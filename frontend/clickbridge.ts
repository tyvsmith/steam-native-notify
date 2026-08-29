import { callable } from 'millennium';
import { dlog } from './log';
import {
	openChatInOverlay,
	openDialogInOverlay,
	openInOverlay,
	openMediaInOverlay,
	openScreenshotInOverlay,
	overlayFocusedAppId,
	runningOverlayAppId,
} from './overlay';

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

/**
 * Desktop behavior, executed from inside Steam: raise the main window (its
 * own per-window SteamClient.Window.BringToFront, the same self-raise the
 * launcher-activation path uses) and run the route through the client's own
 * URL executor. Action tokens have no desktop behavior by analysis, so they
 * end here.
 */
function desktopClick(route: string): void {
	if (route.startsWith('action:')) {
		dlog(`click-bridge: ${route} is in-game only; desktop click is inert`);
		return;
	}
	try {
		const mgr: any = Reflect.get(globalThis, 'g_PopupManager');
		const popups: Iterable<any> = mgr?.m_mapPopups?.values?.() ?? [];
		for (const popup of popups) {
			const win = popup?.window ?? popup?.m_popup;
			if (typeof win?.name === 'string' && win.name.startsWith('SP Desktop')) {
				win.SteamClient?.Window?.BringToFront?.();
				break;
			}
		}
	} catch (e) {
		dlog(`click-bridge: raise failed: ${(e as Error)?.message ?? e}`);
	}
	// Navigate after the raise has landed: the focus shift is what makes the
	// client's own handlers (chat especially) pick the desktop surface.
	window.setTimeout(() => {
		try {
			const sc: any = Reflect.get(globalThis, 'SteamClient');
			dlog(`click-bridge: desktop ${route}`);
			sc?.URL?.ExecuteSteamURL?.(route);
		} catch (e) {
			dlog(`click-bridge: navigate failed: ${(e as Error)?.message ?? e}`);
		}
	}, 300);
}

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
			const appid = await runningOverlayAppId();
			// Steam placed this toast in the overlay context, but its placement
			// can lag focus changes; re-check at click time. If the game is not
			// actually focused now (or quit), the click behaves like a desktop
			// one -- what Steam's own desktop-context toast click does.
			if (appid === null || overlayFocusedAppId() !== appid) {
				desktopClick(route);
				return;
			}
			let opened: boolean;
			if (route.startsWith('steam://friends/message/')) {
				// The chat dialog, in the overlay explicitly: the ingestion's
				// "chat" case (ActivateGameOverlayToUser). The external URL
				// form lets the client pick the surface, and it picks the
				// overlay whenever a game runs -- even unfocused.
				opened = openChatInOverlay(appid, route.slice('steam://friends/message/'.length));
			} else if (route.startsWith(OPENURL_PREFIX)) {
				opened = openInOverlay(appid, route.slice(OPENURL_PREFIX.length));
			} else if (route.startsWith('steam://settings/')) {
				// The ingestion's "settings" dialog IS Settings("System").
				// Steam's own in-game clicks land on Settings for both
				// SystemUpdate and HardwareUpdate (observed 2026-08-29), so
				// both settings routes map here.
				opened = openDialogInOverlay(appid, 'settings');
			} else if (route.startsWith('action:screenshot:')) {
				// Screenshot with its handle: the specific item, where Steam's
				// own in-game click goes.
				opened = openScreenshotInOverlay(appid, route.slice('action:screenshot:'.length));
			} else if (route === 'action:media') {
				// Screenshot without a handle: the Recordings & Screenshots view.
				opened = openMediaInOverlay(appid);
			} else if (route === 'action:requestplaytime') {
				// PlaytimeWarning: the playtime request dialog, via the
				// ingestion's own case.
				opened = openDialogInOverlay(appid, 'requestplaytime');
			} else {
				dlog(`click-bridge: unbridgeable route ${route}`);
				return;
			}
			if (!opened) dlog('click-bridge: overlay door failed');
		} catch (e) {
			dlog(`click-bridge failed: ${(e as Error)?.message ?? e}`);
		}
	}, CLICK_POLL_MS);
}
