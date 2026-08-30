/**
 * Which stashed handler a click may invoke -- the one piece of the replay
 * path that is pure logic, kept free of imports so tools/test-routes can
 * lock its behavior offline.
 *
 * Steam's real click enters through the DOM-level onClick at the end of a
 * wrapper chain that drills the SAME function object down the tree, and that
 * wrapper pairs the per-type activate with the toast-dismissal bookkeeping.
 * Invoking the bare activate without the bookkeeping leaked one of Steam's
 * ~3 toast display slots per on-screen click until no toast rendered at all
 * (measured 2026-08-29), so selection accepts only PROOF, in two forms:
 *
 * - `twin`: the deepest onClick that IS (===) an onActivate seen shallower
 *   in the tree -- the drilled body click, bookkeeping included. An inner
 *   button (voice-chat accept) is its own function and twins nothing.
 * - `sole`: every candidate is one function object, so nothing can be
 *   mis-chosen; the deepest occurrence is reported.
 *
 * Anything else -- several distinct handlers, none provably the body click
 * -- is null, and the toast stays unclickable: the mirror of a Steam toast
 * whose click does nothing, and the fail-closed end of a path whose wrong
 * invoke ACTS (a voice-chat accept answers the call).
 */

export interface Candidate {
	prop: string;
	depth: number;
	fn: (e: unknown) => unknown;
	fnName: string;
	snippet: string;
}

export interface Choice {
	chosen: Candidate;
	how: 'twin' | 'sole';
}

export function chooseHandler(candidates: Candidate[]): Choice | null {
	let twin: Candidate | null = null;
	for (const c of candidates) {
		if (c.prop !== 'onClick') continue;
		const twinned = candidates.some((a) => a.prop === 'onActivate' && a.depth < c.depth && a.fn === c.fn);
		if (twinned && (!twin || c.depth >= twin.depth)) twin = c;
	}
	if (twin) return { chosen: twin, how: 'twin' };
	if (candidates.length > 0 && candidates.every((c) => c.fn === candidates[0].fn)) {
		return { chosen: candidates[candidates.length - 1], how: 'sole' };
	}
	return null;
}
