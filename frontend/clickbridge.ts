import { callable } from 'millennium';
import { dlog } from './log';
import { openInOverlay, runningOverlayAppId } from './overlay';

/**
 * The in-game click bridge. With a game running, a desktop notification's
 * click cannot be delivered as a steam:// URL: openurl navigates the desktop
 * client and raises it OVER the game, which Steam's own in-game toast click
 * never does (its handler runs inside the overlay context). So in-game,
 * tools/notify-action writes the route to a click file instead, and this end
 * -- which lives inside Steam -- opens it in the overlay browser through
 * Steam's own activate-overlay ingestion (overlay.ts).
 *
 * The poll is armed by deliverToast for ARM_WINDOW_MS after each delivery and
 * stops itself afterwards, so an idle session polls nothing. Only
 * steam://openurl/ routes are bridged: chat routes never write a click file
 * (the client already routes them into the overlay), and nav/settings routes
 * have no overlay equivalent, so their in-game clicks are inert by design.
 */
const takeClick = callable<[], string>('TakeClick');

const CLICK_POLL_MS = 1000;
const ARM_WINDOW_MS = 120_000;

const OPENURL_PREFIX = 'steam://openurl/';

let armedUntil = 0;
let timer: number | null = null;

export function armClickBridge(): void {
	armedUntil = Date.now() + ARM_WINDOW_MS;
	if (timer !== null) return;
	timer = window.setInterval(async () => {
		if (Date.now() > armedUntil) {
			if (timer !== null) window.clearInterval(timer);
			timer = null;
			return;
		}
		try {
			// The click file holds a bare route string, so the callable's
			// return needs exactly ONE unwrap -- parseCallableJson would parse
			// twice (its payloads are JSON documents) and silently eat the
			// route it just consumed. That bug shipped once; hence the log
			// line on every consumed click.
			const raw = await takeClick();
			const route = typeof raw === 'string' && raw ? (JSON.parse(raw) as string) : '';
			if (typeof route !== 'string' || !route) return;
			dlog(`click-bridge: ${route}`);
			if (!route.startsWith(OPENURL_PREFIX)) {
				dlog(`click-bridge: unbridgeable route ${route}`);
				return;
			}
			const appid = await runningOverlayAppId();
			if (appid === null) {
				// The game quit between the click and this poll; the desktop
				// client is visible again, so nothing needs surfacing.
				dlog(`click-bridge: no overlay up for ${route}`);
				return;
			}
			if (!openInOverlay(appid, route.slice(OPENURL_PREFIX.length))) {
				dlog('click-bridge: overlay store not found');
			}
		} catch (e) {
			dlog(`click-bridge failed: ${(e as Error)?.message ?? e}`);
		}
	}, CLICK_POLL_MS);
}
