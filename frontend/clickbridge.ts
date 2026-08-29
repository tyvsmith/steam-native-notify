import { callable } from 'millennium';
import { dlog } from './log';
import {
	openChatInOverlay,
	openChatOnDesktop,
	openChatRoomDialog,
	openClipInOverlay,
	openDialogInOverlay,
	openInOverlay,
	openMediaInOverlay,
	openPlaytimeDialog,
	openScreenshotInOverlay,
	overlayFocusedAppId,
	runningOverlayAppId,
} from './overlay';

/**
 * The click bridge: clicks that must pick their surface from inside Steam.
 *
 * tools/notify-action writes the clicked route (or action token) to a click
 * file when the surface decision needs live state -- overlay-context toasts,
 * every chat click, every action token -- and this end consumes it, checks
 * which game window is focused RIGHT NOW (overlay.ts tracks the client's own
 * focus signal), and opens the destination on the right surface: the overlay
 * doors for the focused game, the same doors retargeted at the desktop
 * instance (appid 0) or the client's URL executor otherwise. External
 * steam:// URLs cannot do this: the client's handlers pick the overlay
 * whenever a game is running, and raise the main window over a focused game.
 *
 * The poll is armed by deliverToast for ARM_WINDOW_MS after each delivery and
 * stops itself afterwards, so an idle session polls nothing.
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
/**
 * Raise the main window if it exists; closed to the tray, its popup is
 * destroyed and the appid-0 instance has no surface, so it is opened first
 * through the client's own URL executor (steam://open/main -- the same thing
 * launcher activation does). Returns true when the window already existed.
 */
function ensureMainWindow(): boolean {
	try {
		const mgr: any = Reflect.get(globalThis, 'g_PopupManager');
		const popups: Iterable<any> = mgr?.m_mapPopups?.values?.() ?? [];
		for (const popup of popups) {
			const win = popup?.window ?? popup?.m_popup;
			if (typeof win?.name === 'string' && win.name.startsWith('SP Desktop')) {
				win.SteamClient?.Window?.BringToFront?.();
				return true;
			}
		}
	} catch (e) {
		dlog(`click-bridge: raise failed: ${(e as Error)?.message ?? e}`);
	}
	try {
		dlog('click-bridge: main window closed; opening it');
		const sc: any = Reflect.get(globalThis, 'SteamClient');
		sc?.URL?.ExecuteSteamURL?.('steam://open/main');
	} catch (e) {
		dlog(`click-bridge: open main failed: ${(e as Error)?.message ?? e}`);
	}
	return false;
}

/** Run a desktop door once the main window is up (freshly created needs to settle). */
function afterMainWindow(fn: () => void): void {
	const existed = ensureMainWindow();
	window.setTimeout(fn, existed ? 300 : 1500);
}

/**
 * Action tokens on the desktop: the same doors, retargeted at the desktop
 * instance (appid 0 -- GetInstanceForAppID(0), proven by the desktop chat
 * fix). Steam's own desktop clicks for these types open the media page and
 * the playtime dialog in the main window, so inert was the wrong mirror.
 */
function chatRoomParts(route: string): [string, string] | null {
	const parts = route.slice('action:chatroom:'.length).split(':');
	return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

function desktopAction(route: string): void {
	afterMainWindow(() => {
		let opened: boolean;
		if (route.startsWith('action:chatroom:')) {
			const parts = chatRoomParts(route);
			if (!parts) return;
			opened = openChatRoomDialog(0, parts[0], parts[1]);
		} else if (route.startsWith('action:screenshot:')) {
			opened = openScreenshotInOverlay(0, route.slice('action:screenshot:'.length));
		} else if (route.startsWith('action:clip:')) {
			opened = openClipInOverlay(0, route.slice('action:clip:'.length));
		} else if (route === 'action:media') {
			opened = openMediaInOverlay(0);
		} else if (route === 'action:requestplaytime') {
			opened = openPlaytimeDialog(0);
		} else {
			dlog(`click-bridge: unbridgeable action ${route}`);
			return;
		}
		if (!opened) dlog('click-bridge: desktop door failed');
	});
}

function desktopClick(route: string): void {
	if (route.startsWith('action:')) {
		desktopAction(route);
		return;
	}
	// Navigate after the raise (or creation) has landed: the focus shift is
	// what makes the client's own handlers (chat especially) pick the desktop
	// surface.
	afterMainWindow(() => {
		try {
			const sc: any = Reflect.get(globalThis, 'SteamClient');
			dlog(`click-bridge: desktop ${route}`);
			sc?.URL?.ExecuteSteamURL?.(route);
		} catch (e) {
			dlog(`click-bridge: navigate failed: ${(e as Error)?.message ?? e}`);
		}
	});
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
			const focused = appid !== null && overlayFocusedAppId() === appid;

			// Chat picks its surface explicitly on BOTH sides: the external
			// friends/message URL lets the client choose, and it chooses the
			// overlay whenever a game is running, focused or not. The same
			// ingestion case with appid 0 resolves the desktop instance.
			if (route.startsWith('steam://friends/message/')) {
				const sid = route.slice('steam://friends/message/'.length);
				if (focused) {
					if (!openChatInOverlay(appid!, sid)) dlog('click-bridge: overlay door failed');
				} else if (appid !== null) {
					// Game running but unfocused: the desktop instance,
					// explicitly (the URL handler would pick the overlay).
					afterMainWindow(() => {
						if (!openChatOnDesktop(sid)) dlog('click-bridge: overlay door failed');
					});
				} else {
					// No game at all: the URL handler is the proven desktop
					// path.
					desktopClick(route);
				}
				return;
			}

			// Steam placed this toast in the overlay context, but its placement
			// can lag focus changes; re-check at click time. If the game is not
			// actually focused now (or quit), the click behaves like a desktop
			// one -- what Steam's own desktop-context toast click does.
			if (!focused) {
				desktopClick(route);
				return;
			}
			let opened: boolean;
			if (route.startsWith(OPENURL_PREFIX)) {
				opened = openInOverlay(appid, route.slice(OPENURL_PREFIX.length));
			} else if (route.startsWith('steam://settings/')) {
				// The ingestion's "settings" dialog IS Settings("System").
				// Steam's own in-game clicks land on Settings for both
				// SystemUpdate and HardwareUpdate (observed 2026-08-29), so
				// both settings routes map here.
				opened = openDialogInOverlay(appid, 'settings');
			} else if (route.startsWith('action:chatroom:')) {
				// GroupChatMessage: the room dialog, on the overlay surface.
				const parts = chatRoomParts(route);
				if (!parts) return;
				opened = openChatRoomDialog(appid, parts[0], parts[1]);
			} else if (route.startsWith('action:screenshot:')) {
				// Screenshot with its handle: the specific item, where Steam's
				// own in-game click goes.
				opened = openScreenshotInOverlay(appid, route.slice('action:screenshot:'.length));
			} else if (route.startsWith('action:clip:')) {
				// A finished recording: the specific clip.
				opened = openClipInOverlay(appid, route.slice('action:clip:'.length));
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
