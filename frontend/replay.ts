import { dlog } from './log';
import { chooseHandler, type Candidate } from './choose';
import { firstFiber } from './fiber';

/**
 * The replay click path: a notification click re-runs the handler Steam
 * attached to the toast, taken from its React tree at capture time and
 * invoked later by the click bridge. choose.ts decides which handler a
 * click may run; a toast it refuses stays unclickable, the mirror of a
 * Steam toast whose click does nothing. Known limit (measured,
 * docs/experiments/click-replay.md): the handler is frozen to the surface
 * its toast rendered on.
 *
 * Every `replay: candidates` line is the health probe for the reflective
 * layers, in order: `n=0 (no fiber key)` -- the fiber convention moved;
 * `portal=miss` -- the HostPortal boundary moved; `stashed=none
 * (ambiguous)` -- Steam stopped drilling the handler object. No line at
 * all means the popup hook is dead. Diagnostics never throw; a failed walk
 * only costs that toast its click.
 */

/** The click-file payload prefix: `replay:<toast-name>`. */
export const REPLAY_CLICK_PREFIX = 'replay:';

/**
 * How long a delivered notification stays clickable. The click bridge polls
 * for exactly this long after each delivery, and the stash keeps handlers
 * exactly as long -- one constant, so a click the bridge would still
 * consume always finds its handler. The stash is also bounded to the
 * latest STASH_MAX toasts: a stashed closure pins its captured scope.
 */
export const CLICK_WINDOW_MS = 120_000;
const STASH_MAX = 8;

const SNIPPET_LEN = 200;
const MAX_FIBERS = 5000;
/** Detail lines logged per anomalous toast; the rest is one +N summary. */
const LOG_CANDIDATES_MAX = 12;

/**
 * Candidate metadata without the function: what the stash retains for
 * --replay inspect. Only the CHOSEN handler's closure is worth pinning for
 * CLICK_WINDOW_MS; a portal miss once collected 673 candidates.
 */
type CandidateMeta = Omit<Candidate, 'fn'>;

interface StashEntry {
	name: string;
	stashedAt: number;
	/** The proven handler, or null for an ambiguous toast kept for inspect. */
	fn: ((e: unknown) => unknown) | null;
	chosen: CandidateMeta | null;
	candidates: CandidateMeta[];
}

const stash = new Map<string, StashEntry>();

function toMeta({ fn: _fn, ...meta }: Candidate): CandidateMeta {
	return meta;
}

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
	try {
		return {
			fnName: (fn as { name?: string })?.name ?? '',
			snippet: String(fn).replace(/\s+/g, ' ').slice(0, SNIPPET_LEN),
		};
	} catch {
		return { fnName: '', snippet: '<toString failed>' };
	}
}

/**
 * The toast popup is portal-rendered from the main window's React tree, so
 * the walk roots at the HostPortal fiber (tag 4) whose containerInfo lives
 * in the popup's document -- rooting any higher sweeps the whole Steam UI
 * (the 673-candidate incident in the experiment doc). Fallback when no
 * portal is found: the highest fiber whose stateNode is still in the popup
 * document.
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
 * Walk the toast's tree, stash the handler choose.ts proves, and return the
 * click token the notification should carry -- null when the toast must
 * stay unclickable. Called from deliverToast before the popup can be
 * closed; never throws, never blocks delivery. An ambiguous toast is
 * stashed without a handler so --replay inspect can still show what the
 * walk saw.
 */
export function stashToastHandler(win: Window, name: string): string | null {
	try {
		const doc = win.document;
		if (!doc) return null;
		const fiber = firstFiber(doc);
		if (!fiber) {
			dlog(`replay: candidates ${name} n=0 (no fiber key in toast document)`);
			return null;
		}

		const { root, viaPortal } = toastSubtreeRoot(fiber, doc);
		const candidates = collectCandidates(root);
		const picked = chooseHandler(candidates);
		const health = viaPortal ? '' : ' portal=miss';
		const summary = picked
			? `stashed=${picked.chosen.prop}@${picked.chosen.depth} (${picked.how})`
			: 'stashed=none (ambiguous)';
		dlog(`replay: candidates ${name} n=${candidates.length} ${summary}${health}`);
		// Detail only on anomaly, and capped: the summary line carries the
		// whole health signal, and each detail line is a callable plus a file
		// write -- unbounded, a portal miss would emit hundreds per toast.
		if (!picked || !viaPortal) {
			candidates.slice(0, LOG_CANDIDATES_MAX).forEach((c, i) => {
				dlog(`replay: candidate ${name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
			});
			if (candidates.length > LOG_CANDIDATES_MAX) {
				dlog(`replay: candidate ${name} +${candidates.length - LOG_CANDIDATES_MAX} more`);
			}
		}

		stash.delete(name); // re-insert so the map stays insertion-ordered by recency
		stash.set(name, {
			name,
			stashedAt: Date.now(),
			fn: picked?.chosen.fn ?? null,
			chosen: picked ? toMeta(picked.chosen) : null,
			candidates: candidates.map(toMeta),
		});
		pruneStash();
		return picked ? `${REPLAY_CLICK_PREFIX}${name}` : null;
	} catch (e) {
		dlog(`replay: walk failed for ${name}: ${(e as Error)?.message ?? e}`);
		return null;
	}
}

/** Dump the stash: names, ages, candidate metadata. The --replay inspect door. */
export function inspectReplayStash(): void {
	dlog(`replay: stash size=${stash.size}`);
	for (const entry of stash.values()) {
		const age = Math.round((Date.now() - entry.stashedAt) / 1000);
		const chosen = entry.chosen ? `${entry.chosen.prop}@${entry.chosen.depth}` : 'none';
		dlog(`replay: stash ${entry.name} age=${age}s n=${entry.candidates.length} chosen=${chosen}`);
		entry.candidates.forEach((c, i) => {
			dlog(`replay: stash ${entry.name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
		});
	}
}

/**
 * Invoke a stashed handler with a stub event. No name targets the most
 * recent entry (the tools/fire probe rides the same poll as the fires).
 * A throw from the handler is logged verbatim and swallowed. Returns
 * whether a live handler was found and ran without throwing.
 */
/**
 * Open Steam's desktop window if it is closed to the tray, so a replayed
 * click has somewhere to land.
 *
 * This deliberately does NOT try to raise a window that already exists.
 * Windows grants foreground rights to the process the shell activates, and
 * they cannot be taken by anyone else (Raymond Chen, 2009: foreground
 * permission "has to be given to you"). A toast click activates steam.exe,
 * which forwards the URL to the resident client over IPC and exits, so the
 * grant dies with it; nothing callable from inside Steam can recover it.
 * Measured on Windows 11 (docs/platforms.md): BringToFront(AndForceOS),
 * MarkLastFocused, SetKeyFocus, ShowWindow and a HideWindow+ShowWindow
 * re-present all ran from the main window's own context and none took the
 * foreground -- and Steam's own steam://open/friends behaves the same way.
 *
 * steam://open/ is the family Valve documents as opening a window (nav/
 * explicitly does not activate), so it is what creates one when there is
 * none. Best-effort: a click must still replay if this fails.
 */
export function raiseSteamWindow(): void {
	try {
		const sc = Reflect.get(globalThis, 'SteamClient') as
			| { URL?: { ExecuteSteamURL?: (url: string) => void } }
			| undefined;
		sc?.URL?.ExecuteSteamURL?.('steam://open/main');
	} catch (e) {
		dlog(`raise failed: ${(e as Error)?.message ?? e}`);
	}
}

export function invokeReplayHandler(name?: string): boolean {
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
	if (!entry.fn || !entry.chosen) {
		dlog(`replay: invoke ${entry.name} -> entry has no handler`);
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
}
