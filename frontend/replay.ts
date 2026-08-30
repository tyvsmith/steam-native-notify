import { dlog } from './log';
import { chooseHandler, type Candidate } from './choose';

/**
 * The replay click path: every notification click re-runs Steam's own click
 * handler, taken from the toast's React tree at capture time.
 *
 * The walk starts from the toast popup's first fiber-keyed element, climbs to
 * the popup's portal root, then traverses downward collecting every fiber
 * whose props carry a function-valued onClick or onActivate. Which of those
 * a click may invoke is choose.ts's job (pure, offline-tested): the
 * identity-proven DOM-level body click, or the sole handler when only one
 * distinct function exists; a toast with neither proof is left unclickable,
 * the mirror of a Steam toast whose click does nothing.
 *
 * Every `replay: candidates` line doubles as the health probe for the
 * reflective layers, in order: `n=0 (no fiber key)` means the fiber
 * convention moved; `portal=miss` means the HostPortal boundary moved;
 * `stashed=none (ambiguous)` means Steam stopped drilling the handler
 * object and left several distinct handlers; a missing line entirely means
 * the popup hook is dead. Validated live 2026-08-29
 * (docs/experiments/click-replay.md); known limit measured there: the
 * handler is frozen to the surface its toast rendered on.
 *
 * Diagnostics never throw: every property read, toString, and invoke is
 * try-wrapped, and a failed walk only costs that toast its click.
 */

/**
 * How long a delivered notification stays clickable. The click bridge polls
 * for exactly this long after each delivery, and the stash keeps handlers
 * exactly as long -- one constant, so a click the bridge would still consume
 * always finds its handler. The stash is also bounded to the latest
 * STASH_MAX toasts: a stashed closure pins its captured scope.
 */
export const CLICK_WINDOW_MS = 120_000;
const STASH_MAX = 8;

const SNIPPET_LEN = 200;
const MAX_FIBERS = 5000;

interface StashEntry {
	name: string;
	stashedAt: number;
	/** The DOM-level click handler; only twinned toasts are stashed. */
	fn: (e: unknown) => unknown;
	chosen: Candidate;
	candidates: Candidate[];
}

const stash = new Map<string, StashEntry>();

function pruneStash(): void {
	const cutoff = Date.now() - CLICK_WINDOW_MS;
	for (const [key, entry] of stash) {
		if (entry.stashedAt < cutoff) stash.delete(key);
	}
	while (stash.size > STASH_MAX) {
		const oldest = stash.keys().next().value;
		if (oldest === undefined) break;
		stash.delete(oldest);
	}
}

function fnMeta(fn: unknown): { fnName: string; snippet: string } {
	let fnName = '';
	let snippet = '<toString failed>';
	try {
		fnName = (fn as { name?: string })?.name ?? '';
	} catch {
		/* a hostile name getter; keep going */
	}
	try {
		snippet = String(fn).replace(/\s+/g, ' ').slice(0, SNIPPET_LEN);
	} catch {
		/* some proxies throw on toString; the candidate is still listed */
	}
	return { fnName, snippet };
}

/**
 * The toast popup is PORTAL-rendered from the main window's React tree:
 * climbing to the absolute root and walking down sweeps every clickable in
 * the Steam UI (measured: 673 candidates, window chrome included). The
 * toast's own subtree hangs under a HostPortal fiber (tag 4) whose
 * containerInfo lives in the popup's document; that portal is the walk root.
 * Fallback when no portal is found: the highest fiber whose stateNode is
 * still in the popup document.
 */
function toastSubtreeRoot(fiber: any, doc: Document): { root: any; viaPortal: boolean } {
	let cur = fiber;
	let best = fiber;
	for (let up = 0; cur && up < 80; up++) {
		try {
			if (cur.tag === 4 && cur.stateNode?.containerInfo?.ownerDocument === doc) {
				return { root: cur, viaPortal: true };
			}
			const sn = cur.stateNode;
			if (sn && typeof sn === 'object' && sn.ownerDocument === doc) best = cur;
			// A host fiber in ANOTHER document means the portal boundary was
			// passed without matching; everything above is main-window tree.
			if (sn && typeof sn === 'object' && sn.ownerDocument && sn.ownerDocument !== doc) break;
		} catch {
			/* hostile getters must not stop the climb */
		}
		cur = cur.return;
	}
	return { root: best, viaPortal: false };
}

/**
 * Collect handler-bearing fibers breadth-first from the root, so the array
 * comes back shallowest-first.
 */
function collectCandidates(rootFiber: any): Candidate[] {
	const candidates: Candidate[] = [];
	let queue: { fiber: any; depth: number }[] = [{ fiber: rootFiber, depth: 0 }];
	let visited = 0;
	while (queue.length > 0 && visited < MAX_FIBERS) {
		const next: typeof queue = [];
		for (const { fiber, depth } of queue) {
			if (!fiber || visited >= MAX_FIBERS) break;
			visited++;
			try {
				const props = fiber.memoizedProps ?? fiber.pendingProps;
				if (props && typeof props === 'object') {
					for (const prop of ['onClick', 'onActivate']) {
						const fn = props[prop];
						if (typeof fn === 'function') candidates.push({ prop, depth, fn, ...fnMeta(fn) });
					}
				}
			} catch {
				/* a fiber with hostile props must not stop the walk */
			}
			for (let child = fiber.child; child; child = child.sibling) {
				next.push({ fiber: child, depth: depth + 1 });
			}
		}
		queue = next;
	}
	return candidates;
}

/**
 * Walk the toast's tree and stash the proven click handler under the toast
 * name. Called from deliverToast before the popup can be closed; never
 * throws, never blocks delivery. Returns whether a handler was stashed --
 * the notification is only made clickable when one was.
 */
export function stashReplayCandidates(win: Window, name: string): boolean {
	try {
		const doc = win.document;
		if (!doc) return false;

		let fiber: any = null;
		for (const el of Array.from(doc.querySelectorAll('*'))) {
			const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
			if (key) {
				fiber = (el as any)[key];
				break;
			}
		}
		if (!fiber) {
			dlog(`replay: candidates ${name} n=0 (no fiber key in toast document)`);
			return false;
		}

		const { root, viaPortal } = toastSubtreeRoot(fiber, doc);
		const candidates = collectCandidates(root);
		const picked = chooseHandler(candidates);
		const health = viaPortal ? '' : ' portal=miss';
		const summary = picked
			? `stashed=${picked.chosen.prop}@${picked.chosen.depth} (${picked.how})`
			: 'stashed=none (ambiguous)';
		dlog(`replay: candidates ${name} n=${candidates.length} ${summary}${health}`);
		candidates.forEach((c, i) => {
			dlog(`replay: candidate ${name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
		});
		if (!picked) return false;

		stash.delete(name); // re-insert so the map stays insertion-ordered by recency
		stash.set(name, { name, stashedAt: Date.now(), fn: picked.chosen.fn, chosen: picked.chosen, candidates });
		pruneStash();
		return true;
	} catch (e) {
		dlog(`replay: walk failed for ${name}: ${(e as Error)?.message ?? e}`);
		return false;
	}
}

/** Dump the stash: names, ages, candidate metadata. The --replay inspect door. */
export function inspectReplayStash(): void {
	try {
		dlog(`replay: stash size=${stash.size}`);
		for (const entry of stash.values()) {
			const age = Math.round((Date.now() - entry.stashedAt) / 1000);
			dlog(
				`replay: stash ${entry.name} age=${age}s n=${entry.candidates.length} chosen=${entry.chosen.prop}@${entry.chosen.depth}`,
			);
			entry.candidates.forEach((c, i) => {
				dlog(`replay: stash ${entry.name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
			});
		}
	} catch (e) {
		dlog(`replay: inspect failed: ${(e as Error)?.message ?? e}`);
	}
}

/**
 * Invoke a stashed handler with a stub event. No name targets the most
 * recent entry (the tools/fire probe rides the same poll as the fires).
 * Thrown errors are logged verbatim and swallowed. Returns whether a live
 * handler was found and ran without throwing.
 */
export function invokeReplayHandler(name?: string): boolean {
	try {
		let entry: StashEntry | undefined;
		if (name) {
			entry = stash.get(name);
		} else {
			for (const e of stash.values()) entry = e; // last = most recent
		}
		if (!entry) {
			dlog(`replay: invoke ${name ?? '(latest)'} -> no stash entry`);
			return false;
		}
		const age = Math.round((Date.now() - entry.stashedAt) / 1000);
		if (Date.now() - entry.stashedAt > CLICK_WINDOW_MS) {
			dlog(`replay: invoke ${entry.name} -> expired (${age}s old)`);
			stash.delete(entry.name);
			return false;
		}
		dlog(`replay: invoke ${entry.name} ${entry.chosen.prop}@${entry.chosen.depth} age=${age}s`);
		const stubEvent = {
			preventDefault() {},
			stopPropagation() {},
		};
		try {
			entry.fn(stubEvent);
			dlog(`replay: invoke ${entry.name} -> returned without throwing`);
			return true;
		} catch (e) {
			const err = e as Error;
			dlog(`replay: invoke ${entry.name} -> THREW ${err?.name ?? ''}: ${err?.message ?? String(e)}`);
			if (err?.stack) dlog(`replay: invoke stack: ${String(err.stack).replace(/\s+/g, ' ').slice(0, 500)}`);
			return false;
		}
	} catch (e) {
		dlog(`replay: invoke failed: ${(e as Error)?.message ?? e}`);
		return false;
	}
}
