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
		if (!Array.isArray(info) || info.length === 0) return null;
		// With several games running, prefer the entry for the FOCUSED game:
		// answering with a different game's appid would make the focus check
		// read false and raise the desktop over a focused fullscreen game.
		const entry = info.find((e: any) => Number(e?.appID) === focusedOverlayAppId) ?? info[0];
		const appid = Number(entry?.appID);
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

/**
 * The context descriptor chat dialogs key on. ShowChatRoomGroupDialog's first
 * argument flows into GetPerContextChatData / ShowAndOrActivateChat, both
 * keyed by the browserInfo's m_unPID: the wrong object means the dialog opens
 * on the wrong surface AND never reuses an existing window. Steam's own toast
 * click passes the toast popup's params.browserInfo; index.tsx stashes each
 * toast's browserInfo here per surface at capture time.
 */
let desktopToastCtx: unknown = null;
let overlayToastCtx: unknown = null;

export function rememberToastContext(overlayCtx: boolean, browserInfo: unknown): void {
	if (!browserInfo) return;
	if (overlayCtx) {
		if (!overlayToastCtx) dlog('overlay: toast context stashed (overlay)');
		overlayToastCtx = browserInfo;
	} else {
		if (!desktopToastCtx) dlog('overlay: toast context stashed (desktop)');
		desktopToastCtx = browserInfo;
	}
}

/**
 * The FriendsUI dispatcher the ingestion's chat case calls into; it also
 * carries ShowChatRoomGroupDialog, which is Steam's own GroupChatMessage
 * toast click: LN.ShowChatRoomGroupDialog(browserInfo, chat_group_id,
 * chat_id). No URL reaches the room dialog; this does.
 */
let chatDispatcher: any;

function findChatDispatcher(): any {
	if (chatDispatcher) return chatDispatcher;
	try {
		chatDispatcher = findModuleExport((e: any) => {
			try {
				return (
					typeof e?.ShowChatRoomGroupDialog === 'function' &&
					typeof e?.ShowFriendChatDialog === 'function'
				);
			} catch {
				return false;
			}
		});
	} catch (e) {
		dlog(`chat dispatcher lookup failed: ${(e as Error)?.message ?? e}`);
	}
	return chatDispatcher;
}

/** Open a group chat room dialog on the surface for appid (0 = desktop). */
export function openChatRoomDialog(appid: number, groupId: string, chatId: string): boolean {
	const friends = findChatDispatcher();
	if (!friends) return false;
	let ctx: any = appid > 0 ? overlayToastCtx : desktopToastCtx;
	// A stash from a game that has since exited points at a dead PID; the
	// dispatcher would report success while opening nothing. When the context
	// names an appid, it must be the one being targeted.
	if (appid > 0 && ctx && typeof ctx.m_unAppID === 'number' && ctx.m_unAppID !== appid) {
		dlog(`overlay: stashed toast context is for appid ${ctx.m_unAppID}, not ${appid}; treating as missing`);
		ctx = null;
	}
	if (!ctx) {
		// The dispatcher dereferences the context's m_unPID unconditionally;
		// calling without one throws inside Steam's code. Known limit: after a
		// load, the slot for a surface only fills once a toast renders there.
		dlog(`overlay: chat room appid=${appid} has no stashed toast context`);
		return false;
	}
	try {
		dlog(`overlay: chat room appid=${appid} group=${groupId} chat=${chatId}`);
		friends.ShowChatRoomGroupDialog(ctx, groupId, chatId);
		return true;
	} catch (e) {
		dlog(`overlay: chat room failed: ${(e as Error)?.message ?? e}`);
		return false;
	}
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
