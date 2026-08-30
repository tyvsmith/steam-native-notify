import { dlog } from './log';

/**
 * The replay click path: every notification click re-runs Steam's own click
 * handler, taken from the toast's React tree at capture time.
 *
 * The walk starts from the toast popup's first fiber-keyed element, climbs to
 * the popup's portal root, then traverses downward (child/sibling) collecting
 * every fiber whose memoizedProps carries a function-valued onClick or
 * onActivate. The OUTERMOST hit (shallowest, first in traversal order) is
 * stashed per toast name: inner buttons (tray options, voice-chat accept)
 * carry handlers that ACT rather than navigate, so depth order is the generic
 * disambiguator. The click bridge later invokes the stashed handler by name.
 *
 * Validated live 2026-08-29 (docs/experiments/click-replay.md): the closure
 * survives the toast window's death in every tested form and replays Steam's
 * click verbatim. Known limit, measured there: the handler is FROZEN to the
 * surface the toast rendered on -- one captured in a game's overlay invoked
 * after that overlay died returns without throwing and does nothing.
 *
 * Diagnostics never throw: every fn.toString(), property read, and invoke is
 * try-wrapped, and a failed walk only costs that toast its click.
 */

interface Candidate {
	prop: string;
	depth: number;
	fnName: string;
	snippet: string;
}

interface StashEntry {
	name: string;
	stashedAt: number;
	/** The chosen handler (the DOM-level full click); what invoke calls. */
	fn: ((e: unknown) => unknown) | null;
	/** The bare outermost handler, kept for the invoke-bare probe. */
	fnBare: ((e: unknown) => unknown) | null;
	/** Which candidate fn is, for the logs. */
	chosen: Candidate | null;
	candidates: Candidate[];
}

/**
 * A stashed closure pins its captured scope, so the stash is bounded: the
 * latest STASH_MAX toasts, expired at STASH_TTL_MS. The TTL matches the click
 * bridge's arm window (clickbridge.ts ARM_WINDOW_MS -- keep in sync): a click
 * the bridge would still consume must find its handler, and anything older is
 * already dropped as stale before it gets here.
 */
const STASH_MAX = 8;
const STASH_TTL_MS = 120_000;

const SNIPPET_LEN = 200;
const MAX_FIBERS = 5000;

const stash = new Map<string, StashEntry>();

function pruneStash(): void {
	const cutoff = Date.now() - STASH_TTL_MS;
	for (const [key, entry] of stash) {
		if (entry.stashedAt < cutoff) stash.delete(key);
	}
	while (stash.size > STASH_MAX) {
		const oldest = stash.keys().next().value;
		if (oldest === undefined) break;
		stash.delete(oldest);
	}
}

function fnSnippet(fn: unknown): { fnName: string; snippet: string } {
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
function toastSubtreeRoot(fiber: any, doc: Document): any {
	let cur = fiber;
	let best = fiber;
	for (let up = 0; cur && up < 80; up++) {
		try {
			if (cur.tag === 4 && cur.stateNode?.containerInfo?.ownerDocument === doc) return cur;
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
	return best;
}

/**
 * Collect handler-bearing fibers breadth-first from the root, so the array
 * comes back shallowest-first and candidates[0] is the outermost handler.
 */
function collectCandidates(rootFiber: any): { candidates: Candidate[]; fns: ((e: unknown) => unknown)[] } {
	const candidates: Candidate[] = [];
	const fns: ((e: unknown) => unknown)[] = [];
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
						if (typeof fn === 'function') {
							candidates.push({ prop, depth, ...fnSnippet(fn) });
							fns.push(fn);
						}
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
	return { candidates, fns };
}

/**
 * Which candidate a click should run. NOT the outermost: Steam's real click
 * enters through the DOM-level onClick at the end of the drilled wrapper
 * chain, and that wrapper adds the dismissal bookkeeping to the activate
 * (`r=>{e&&e(r),t&&t()}` in the dumps -- activate, then dismiss). Invoking
 * the bare outermost onActivate skips the dismissal, and each such invoke
 * while the toast is still on screen leaks one of Steam's ~3 concurrent
 * toast slots; three leaks wedged the toast queue for the whole session
 * (observed 2026-08-29, plugin.log 17:50). The DOM onClick is recognised as
 * the deepest onClick whose source text matches an onActivate ABOVE it --
 * the drilled twin. An inner button (voice-chat accept, tray options)
 * carries its own source, matches no onActivate, and is never chosen.
 * Fallback: the outermost candidate.
 */
function chooseCandidate(candidates: Candidate[]): number {
	let chosen = 0;
	for (let i = 1; i < candidates.length; i++) {
		const c = candidates[i];
		if (c.prop !== 'onClick' || c.snippet === '<toString failed>') continue;
		const twin = candidates.some(
			(a) => a.prop === 'onActivate' && a.depth < c.depth && a.snippet === c.snippet,
		);
		if (twin && c.depth >= candidates[chosen].depth) chosen = i;
	}
	return chosen;
}

/**
 * Walk the toast's tree and stash the click handler under the toast name.
 * Called from deliverToast before the popup can be closed; never throws,
 * never blocks delivery. Returns whether a handler was stashed -- the
 * notification is only made clickable when one was.
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

		const { candidates, fns } = collectCandidates(toastSubtreeRoot(fiber, doc));
		pruneStash();
		const idx = candidates.length > 0 ? chooseCandidate(candidates) : 0;
		const chosen = candidates.length > 0 ? candidates[idx] : null;
		stash.delete(name); // re-insert so the map stays insertion-ordered by recency
		stash.set(name, {
			name,
			stashedAt: Date.now(),
			fn: fns.length > 0 ? fns[idx] : null,
			fnBare: fns.length > 0 ? fns[0] : null,
			chosen,
			candidates,
		});

		const summary = chosen ? `stashed=${chosen.prop}@${chosen.depth}` : 'stashed=none';
		dlog(`replay: candidates ${name} n=${candidates.length} ${summary}`);
		candidates.forEach((c, i) => {
			dlog(`replay: candidate ${name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
		});
		return fns.length > 0;
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
			const chosen = entry.chosen ? `${entry.chosen.prop}@${entry.chosen.depth}` : 'none';
			dlog(`replay: stash ${entry.name} age=${age}s n=${entry.candidates.length} chosen=${chosen}`);
			entry.candidates.forEach((c, i) => {
				dlog(`replay: stash ${entry.name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
			});
		}
	} catch (e) {
		dlog(`replay: inspect failed: ${(e as Error)?.message ?? e}`);
	}
}

/**
 * Invoke a stashed handler with a stub event. No name targets the most recent
 * entry (the tools/fire probe rides the same poll as the fires, so the
 * on-screen probes have no time to copy a toast name around). Thrown errors
 * are logged verbatim and swallowed. Returns whether a live handler was found
 * and ran without throwing. `bare` invokes the outermost candidate instead of
 * the DOM click -- the probe that reproduces the toast-slot leak; never used
 * by the click path.
 */
export function invokeReplayHandler(name?: string, bare = false): boolean {
	try {
		let entry: StashEntry | undefined;
		if (name) {
			entry = stash.get(name);
		} else {
			for (const e of stash.values()) entry = e; // last = most recent
		}
		const age = entry ? Math.round((Date.now() - entry.stashedAt) / 1000) : 0;
		if (entry && Date.now() - entry.stashedAt > STASH_TTL_MS) {
			dlog(`replay: invoke ${entry.name} -> expired (${age}s old)`);
			stash.delete(entry.name);
			return false;
		}
		if (!entry) {
			dlog(`replay: invoke ${name ?? '(latest)'} -> no stash entry`);
			return false;
		}
		const fn = bare ? entry.fnBare : entry.fn;
		if (!fn) {
			dlog(`replay: invoke ${entry.name} -> entry has no handler`);
			return false;
		}
		const chosen = bare ? 'bare-outermost' : entry.chosen ? `${entry.chosen.prop}@${entry.chosen.depth}` : '?';
		dlog(`replay: invoke ${entry.name} ${chosen} age=${age}s`);
		const stubEvent = {
			preventDefault() {},
			stopPropagation() {},
		};
		try {
			fn(stubEvent);
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
