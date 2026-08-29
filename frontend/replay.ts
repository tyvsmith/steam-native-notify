import { dlog } from './log';

/**
 * Experiment probe (docs/experiments/click-replay.md): find and stash the
 * toast component's own click handler at capture time, so a later desktop
 * click could replay Steam's click logic verbatim instead of mirroring it
 * through routes.ts and the overlay doors.
 *
 * The walk starts from the toast popup's first fiber-keyed element, climbs to
 * the tree's root, then traverses downward (child/sibling) collecting every
 * fiber whose memoizedProps carries a function-valued onClick or onActivate.
 * The OUTERMOST hit (shallowest depth, first in traversal order) is stashed as
 * the replay candidate: inner buttons (tray options, voice-chat accept) carry
 * their own handlers that ACT rather than navigate, so depth order is the
 * generic disambiguator.
 *
 * Everything here is diagnostics-grade: every fn.toString(), every property
 * read, and every invoke is try-wrapped, and a failed walk changes nothing
 * about delivery.
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
	/** The outermost candidate's handler; what invoke calls. */
	fn: ((e: unknown) => unknown) | null;
	/** Which candidate the fn is, for the logs. */
	chosen: Candidate | null;
	candidates: Candidate[];
}

/**
 * Latest N toasts, insertion-ordered. Production would expire entries with the
 * click-arm window (clickbridge.ts's 120s); the experiment holds them long
 * enough to run the 10-minute lifecycle cell, which is the point of the probe.
 */
const STASH_MAX = 8;
const EXPERIMENT_TTL_MS = 30 * 60_000;

const SNIPPET_LEN = 200;
const MAX_FIBERS = 5000;

const stash = new Map<string, StashEntry>();

function pruneStash(): void {
	const cutoff = Date.now() - EXPERIMENT_TTL_MS;
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
 * Walk the toast's tree and stash the outermost handler under the toast name.
 * Called from deliverToast; never throws, never changes delivery.
 */
export function stashReplayCandidates(win: Window, name: string): void {
	try {
		const doc = win.document;
		if (!doc) return;

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
			return;
		}

		// Climb to the root so the downward walk sees the whole toast tree, not
		// just the subtree under whichever element happened to carry a fiber key.
		let root = fiber;
		for (let up = 0; root.return && up < 60; up++) root = root.return;

		const { candidates, fns } = collectCandidates(root);
		pruneStash();
		const chosen = candidates.length > 0 ? candidates[0] : null;
		stash.delete(name); // re-insert so the map stays insertion-ordered by recency
		stash.set(name, {
			name,
			stashedAt: Date.now(),
			fn: fns.length > 0 ? fns[0] : null,
			chosen,
			candidates,
		});

		const summary = chosen ? `stashed=${chosen.prop}@${chosen.depth}` : 'stashed=none';
		dlog(`replay: candidates ${name} n=${candidates.length} ${summary}`);
		candidates.forEach((c, i) => {
			dlog(`replay: candidate ${name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
		});
	} catch (e) {
		dlog(`replay: walk failed for ${name}: ${(e as Error)?.message ?? e}`);
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
 * entry (the invoke command rides the same 3s dev poll as the fire, so the
 * on-screen lifecycle cell has no time to copy a toast name around). The
 * thrown error, if any, is logged verbatim: a throw AFTER the toast window
 * died is the experiment's kill signal, so it must reach the log intact.
 */
export function invokeReplayHandler(name?: string): void {
	try {
		let entry: StashEntry | undefined;
		if (name) {
			entry = stash.get(name);
		} else {
			for (const e of stash.values()) entry = e; // last = most recent
		}
		if (!entry) {
			dlog(`replay: invoke ${name ?? '(latest)'} -> no stash entry`);
			return;
		}
		if (!entry.fn) {
			dlog(`replay: invoke ${entry.name} -> entry has no handler`);
			return;
		}
		const age = Math.round((Date.now() - entry.stashedAt) / 1000);
		const chosen = entry.chosen ? `${entry.chosen.prop}@${entry.chosen.depth}` : '?';
		dlog(`replay: invoke ${entry.name} ${chosen} age=${age}s`);
		const stubEvent = {
			preventDefault() {},
			stopPropagation() {},
		};
		try {
			entry.fn(stubEvent);
			dlog(`replay: invoke ${entry.name} -> returned without throwing`);
		} catch (e) {
			const err = e as Error;
			dlog(`replay: invoke ${entry.name} -> THREW ${err?.name ?? ''}: ${err?.message ?? String(e)}`);
			if (err?.stack) dlog(`replay: invoke stack: ${String(err.stack).replace(/\s+/g, ' ').slice(0, 500)}`);
		}
	} catch (e) {
		dlog(`replay: invoke failed: ${(e as Error)?.message ?? e}`);
	}
}
