/**
 * The signed-in user's steamid64, loaded once at startup from the backend
 * (loginusers.vdf) and held as module state the way urlstore holds Steam's URL
 * templates. Routing rules read it from here rather than threading it through
 * every call; without it, "my"-page routes come back null rather than broken.
 */

let me64: string | null = null;

/** Accepts the backend's value; anything but a 17-digit id leaves it unset. */
export function setIdentity(raw: unknown): string | null {
	me64 = typeof raw === 'string' && /^\d{17}$/.test(raw) ? raw : null;
	return me64;
}

/**
 * The community path addressing the signed-in user: `profiles/<steamid64>`.
 * This is also what Steam's `%mystuff%` template alias resolves to from
 * outside a logged-in session (routes.ts, fillMyStuff).
 */
export function myProfilePath(): string | null {
	return me64 ? `profiles/${me64}` : null;
}
