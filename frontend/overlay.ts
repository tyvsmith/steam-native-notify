import { findModuleExport } from 'millennium';
import { dlog, safeJson } from './log';

/**
 * The in-game overlay's web-page door, verified live 2026-08-29 (a synthetic
 * request opened the overlay browser on the gifts page in Helldivers 2).
 *
 * No external steam:// URL reaches the overlay browser: the documented
 * steam://overlay command is gone from current binaries, and an externally
 * invoked steam://openexternalforpid never reaches its JS handler -- the
 * client raises its main window over the game instead. The overlay is driven
 * from THIS context: one store registers
 * SteamClient.Overlay.RegisterForActivateOverlayRequests and its
 * OnGameOverlayActivateRequested routes web-page requests into the overlay
 * navigator (RouteNavigateToSteamWeb -> GetInstanceForAppID(...).
 * NavigateToSteamWeb). The request shape below is the one the bundle's own
 * steam://openexternalforpid parser builds.
 */
let overlayStore: any;

/**
 * Live game-focus state, from the client's own signal. Steam places toasts by
 * focus too, but its placement can lag on this compositor (observed: an
 * overlay-context toast while the game was backgrounded), so the click bridge
 * re-checks focus at CLICK time instead of trusting the notify-time context.
 */
let focusedOverlayAppId = 0;

export function trackOverlayFocus(): void {
	try {
		const sc: any = Reflect.get(globalThis, 'SteamClient');
		sc?.System?.UI?.RegisterForOverlayGameWindowFocusChanged?.((appid: number) => {
			focusedOverlayAppId = Number(appid) || 0;
		});
	} catch (e) {
		dlog(`overlay focus tracking failed: ${(e as Error)?.message ?? e}`);
	}
}

/** The appid of the game window that has focus right now, or 0. */
export function overlayFocusedAppId(): number {
	return focusedOverlayAppId;
}

export function findOverlayStore(): any {
	if (overlayStore) return overlayStore;
	try {
		overlayStore = findModuleExport((e: any) => {
			try {
				return (
					typeof e?.OnGameOverlayActivateRequested === 'function' &&
					typeof e?.OnSteamURLOpenExternalForPID === 'function'
				);
			} catch {
				return false;
			}
		});
	} catch (e) {
		dlog(`overlay store lookup failed: ${(e as Error)?.message ?? e}`);
	}
	return overlayStore;
}

/**
 * The appid whose overlay is up, or null when no game is running. The overlay
 * browser info is the same map Steam keys its overlay instances on, so a
 * non-empty answer means an overlay exists to navigate.
 */
export async function runningOverlayAppId(): Promise<number | null> {
	try {
		const sc: any = Reflect.get(globalThis, 'SteamClient');
		const info = await sc?.Overlay?.GetOverlayBrowserInfo?.();
		const appid = Array.isArray(info) ? Number(info[0]?.appID) : NaN;
		return Number.isFinite(appid) && appid > 0 ? appid : null;
	} catch {
		return null;
	}
}

function sendOverlayRequest(appid: number, bWebPage: boolean, strDialog: string, steamidTarget: string = '0'): boolean {
	const store = findOverlayStore();
	if (!store) return false;
	const request = {
		unRequestingAppID: appid,
		appid,
		bWebPage,
		strDialog,
		eWebPageMode: 0 /* Default: non-modal, RouteNavigateToSteamWeb */,
		steamidTarget,
		eFlag: 0 /* OverlayToStoreFlag_None */,
		strConnectString: '',
	};
	dlog(`overlay: open appid=${appid} ${safeJson(strDialog)} target=${steamidTarget}`);
	store.OnGameOverlayActivateRequested(request);
	return true;
}

/**
 * Open a 1:1 chat in the game's overlay -- the ingestion's "chat" case, i.e.
 * the SDK's ActivateGameOverlayToUser("chat", steamid). Needed because an
 * external steam://friends/message URL lets the client pick the surface, and
 * it picks the overlay whenever a game is running, focused or not.
 */
export function openChatInOverlay(appid: number, steamid64: string): boolean {
	return sendOverlayRequest(appid, false, 'chat', steamid64);
}

/**
 * Open a 1:1 chat on the DESKTOP explicitly: the same ingestion case with
 * appid 0, whose GetInstanceForAppID resolves the desktop instance. Used when
 * a game is running but unfocused -- the external friends/message URL would
 * open the overlay chat invisibly.
 */
export function openChatOnDesktop(steamid64: string): boolean {
	return sendOverlayRequest(0, false, 'chat', steamid64);
}

/** Open a web page in the running game's overlay browser. */
export function openInOverlay(appid: number, url: string): boolean {
	return sendOverlayRequest(appid, true, url);
}

/**
 * Open one of the handler's named dialogs in the overlay -- the SDK's
 * ActivateGameOverlay vocabulary ("settings", "friends", "community",
 * "requestplaytime", ...). Note "settings" is hard-wired to
 * Settings("System") in the handler, which is exactly where a SystemUpdate
 * click goes.
 */
export function openDialogInOverlay(appid: number, dialog: string): boolean {
	return sendOverlayRequest(appid, false, dialog);
}

/**
 * The playtime request dialog, the way Steam's own toast click opens it:
 * navigator.RequestPlaytimeDialog("manual"). Each surface's navigator does
 * the right thing -- the desktop one (appid 0) shows the main-window dialog,
 * the overlay one routes through the activate-overlay request list.
 */
export function openPlaytimeDialog(appid: number): boolean {
	const store = findOverlayStore();
	if (!store) return false;
	try {
		const nav = store.GetNavigator({ unRequestingAppID: appid });
		if (typeof nav?.RequestPlaytimeDialog !== 'function') {
			dlog('overlay: navigator has no RequestPlaytimeDialog');
			return false;
		}
		dlog(`overlay: playtime dialog appid=${appid}`);
		nav.RequestPlaytimeDialog('manual');
		return true;
	} catch (e) {
		dlog(`overlay: playtime dialog failed: ${(e as Error)?.message ?? e}`);
		return false;
	}
}

/**
 * Open the overlay's Recordings & Screenshots view. The activate-overlay
 * ingestion has no media case; Steam's own in-game screenshot toast click
 * navigates its overlay context to the media grid, and the same navigator is
 * reachable here through the store's GetNavigator.
 */
/**
 * Open one specific screenshot in the overlay's media view, the way Steam's
 * own in-game screenshot toast click does: nav.Media.Screenshot({state:{id}})
 * with the notification's screenshot_handle as the id.
 */
export function openScreenshotInOverlay(appid: number, id: string): boolean {
	const store = findOverlayStore();
	if (!store) return false;
	try {
		const nav = store.GetNavigator({ unRequestingAppID: appid });
		if (typeof nav?.Media?.Screenshot !== 'function') {
			dlog('overlay: navigator has no Media.Screenshot');
			return false;
		}
		dlog(`overlay: screenshot appid=${appid} id=${id}`);
		nav.Media.Screenshot({ state: { id } });
		return true;
	} catch (e) {
		dlog(`overlay: screenshot failed: ${(e as Error)?.message ?? e}`);
		return false;
	}
}

/**
 * Open one specific clip, the way Steam's own recording toast click does:
 * nav.Media.Clip({state:{id}}) with the notification's clip_id.
 */
export function openClipInOverlay(appid: number, id: string): boolean {
	const store = findOverlayStore();
	if (!store) return false;
	try {
		const nav = store.GetNavigator({ unRequestingAppID: appid });
		if (typeof nav?.Media?.Clip !== 'function') {
			dlog('overlay: navigator has no Media.Clip');
			return false;
		}
		dlog(`overlay: clip appid=${appid} id=${id}`);
		nav.Media.Clip({ state: { id } });
		return true;
	} catch (e) {
		dlog(`overlay: clip failed: ${(e as Error)?.message ?? e}`);
		return false;
	}
}

export function openMediaInOverlay(appid: number): boolean {
	const store = findOverlayStore();
	if (!store) return false;
	try {
		const nav = store.GetNavigator({ unRequestingAppID: appid });
		if (typeof nav?.Media?.Grid !== 'function') {
			dlog('overlay: navigator has no Media.Grid');
			return false;
		}
		dlog(`overlay: media appid=${appid}`);
		nav.Media.Grid();
		return true;
	} catch (e) {
		dlog(`overlay: media failed: ${(e as Error)?.message ?? e}`);
		return false;
	}
}
