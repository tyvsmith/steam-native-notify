/**
 * Which stashed handler a click may invoke -- pure logic, import-free so
 * tools/test-frontend can lock it offline. Selection accepts only proof:
 * `twin` (the deepest onClick that IS (===) an onActivate seen shallower --
 * Steam drills the handler object down the toast's wrapper chain, and only
 * the DOM end carries the toast-dismissal bookkeeping) or `sole` (every
 * candidate is one function object; nothing can be mis-chosen). Anything
 * else is null and the toast stays unclickable: a wrong invoke ACTS (a
 * voice-chat accept answers the call), and invoking less than the DOM
 * click leaked toast display slots until no toast rendered at all
 * (measured 2026-08-29; docs/experiments/click-replay.md, "Build-out
 * incidents").
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
