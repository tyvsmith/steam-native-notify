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
 * The click bridge: every notification click is delivered through here.
 *
 * tools/notify-action writes the clicked route (or action token) to a click
 * file, and this end consumes it, checks which game window is focused RIGHT
 * NOW (overlay.ts tracks the client's own focus signal), and opens the
 * destination on the right surface: the overlay doors for the focused game,
 * the same doors retargeted at the desktop instance (appid 0) or the client's
 * URL executor otherwise. External steam:// URLs cannot do this: the client's
 * handlers pick the overlay whenever a game is running, and raise the main
 * window over a focused game.
 *
 * The poll is armed by deliverToast for ARM_WINDOW_MS after each delivery and
 * stops itself afterwards, so an idle session polls nothing.
 */
const takeClick = callable<[], string>('TakeClick');

const CLICK_POLL_MS = 1000;
const ARM_WINDOW_MS = 120_000;
/**
 * notify-action stamps each click with its write time (<epoch-seconds>|
 * <payload>). The poll only runs while armed, so a click written after the
 * disarm would sit in the file and fire as a surprise on the NEXT arm, up to
 * days later; anything older than this is dropped instead of opened.
 */
const CLICK_MAX_AGE_S = 30;

const OPENURL_PREFIX = 'steam://openurl/';

let armedUntil = 0;
let timer: number | null = null;

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

function mainWindowPresent(): boolean {
	try {
		const mgr: any = Reflect.get(globalThis, 'g_PopupManager');
		const popups: Iterable<any> = mgr?.m_mapPopups?.values?.() ?? [];
		for (const popup of popups) {
			const win = popup?.window ?? popup?.m_popup;
			if (typeof win?.name === 'string' && win.name.startsWith('SP Desktop')) return true;
		}
	} catch {
		/* treated as absent */
	}
	return false;
}

/**
 * Run a desktop door once the main window is up. A freshly created window is
 * POLLED for (its popup appearing in g_PopupManager) rather than trusted to a
 * fixed delay: on a slow start a blind timer fires the door against nothing
 * and the click is silently lost.
 */
function afterMainWindow(fn: () => void): void {
	if (ensureMainWindow()) {
		fn();
		return;
	}
	const deadline = Date.now() + 6000;
	const poll = window.setInterval(() => {
		const present = mainWindowPresent();
		if (!present && Date.now() < deadline) return;
		window.clearInterval(poll);
		if (!present) dlog('click-bridge: main window slow to appear; running the door anyway');
		fn();
	}, 250);
}

function chatRoomParts(route: string): [string, string] | null {
	const parts = route.slice('action:chatroom:'.length).split(':');
	return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

/**
 * One dispatch for the action tokens, on either surface: appid 0 is the
 * desktop instance (proven by the desktop chat fix; Steam's own desktop
 * clicks for these types open the media page and the playtime dialog in the
 * main window), any other appid the game's overlay. Adding a token here
 * covers both surfaces at once.
 */
function runActionToken(appid: number, route: string): void {
	const surface = appid === 0 ? 'desktop' : 'overlay';
	let opened: boolean;
	if (route.startsWith('action:chatroom:')) {
		const parts = chatRoomParts(route);
		if (!parts) {
			dlog(`click-bridge: malformed action ${route}`);
			return;
		}
		opened = openChatRoomDialog(appid, parts[0], parts[1]);
	} else if (route.startsWith('action:screenshot:')) {
		opened = openScreenshotInOverlay(appid, route.slice('action:screenshot:'.length));
	} else if (route.startsWith('action:clip:')) {
		opened = openClipInOverlay(appid, route.slice('action:clip:'.length));
	} else if (route === 'action:media') {
		opened = openMediaInOverlay(appid);
	} else if (route === 'action:requestplaytime') {
		// The overlay renders this through the ingestion's dialog-request
		// list; the desktop has no container for it and uses the navigator
		// door instead. Both observed.
		opened = appid === 0 ? openPlaytimeDialog(0) : openDialogInOverlay(appid, 'requestplaytime');
	} else {
		dlog(`click-bridge: unbridgeable action ${route}`);
		return;
	}
	if (!opened) dlog(`click-bridge: ${surface} door failed`);
}

function desktopClick(route: string): void {
	if (route.startsWith('action:')) {
		afterMainWindow(() => runActionToken(0, route));
		return;
	}
	// Navigate once the window exists; a freshly created one needs its settle
	// before the URL executor can land a page change in it.
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
			// The click file holds a plain stamped string, so the callable's
			// return needs exactly ONE unwrap -- parseCallableJson would parse
			// twice (its payloads are JSON documents) and silently eat the
			// route it just consumed. That bug shipped once; hence the log
			// line on every consumed click.
			const raw = await takeClick();
			const taken = typeof raw === 'string' && raw ? (JSON.parse(raw) as string) : '';
			if (typeof taken !== 'string' || !taken) return;
			const sep = taken.indexOf('|');
			const stamp = sep > 0 ? Number(taken.slice(0, sep)) : NaN;
			const route = sep > 0 ? taken.slice(sep + 1) : '';
			if (!Number.isFinite(stamp) || !route) {
				dlog(`click-bridge: unstamped click dropped: ${taken.slice(0, 120)}`);
				return;
			}
			const age = Math.round(Date.now() / 1000 - stamp);
			if (age > CLICK_MAX_AGE_S) {
				dlog(`click-bridge: stale click dropped (${age}s old): ${route}`);
				return;
			}
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
						if (!openChatOnDesktop(sid)) dlog('click-bridge: desktop chat door failed');
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
			if (route.startsWith('action:')) {
				runActionToken(appid, route);
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
			} else if (route.startsWith('steam://nav/')) {
				// Inert by design: Steam's own in-game click for nav routes
				// does nothing (observed for DownloadCompleted).
				dlog(`click-bridge: inert in-game, mirrors Steam: ${route}`);
				return;
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
