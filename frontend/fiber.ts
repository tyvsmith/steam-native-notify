/**
 * The one owner of React's fiber-key convention: a rendered element carries
 * its fiber under a key named `__reactFiber$<random>`. Both tree walkers
 * (notification.ts, replay.ts) start here, so a React change that moves the
 * convention breaks them together -- and is reported once, by replay's
 * `n=0 (no fiber key)` health line. Import-free so the walkers stay in the
 * offline-compilable subgraph.
 */
export function firstFiber(doc: Document): any {
	for (const el of Array.from(doc.querySelectorAll('*'))) {
		const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
		if (key) return (el as any)[key];
	}
	return null;
}
