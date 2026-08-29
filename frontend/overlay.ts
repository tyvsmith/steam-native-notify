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

function sendOverlayRequest(appid: number, bWebPage: boolean, strDialog: string): boolean {
	const store = findOverlayStore();
	if (!store) return false;
	const request = {
		unRequestingAppID: appid,
		appid,
		bWebPage,
		strDialog,
		eWebPageMode: 0 /* Default: non-modal, RouteNavigateToSteamWeb */,
		steamidTarget: '0',
		eFlag: 0 /* OverlayToStoreFlag_None */,
		strConnectString: '',
	};
	dlog(`overlay: open appid=${appid} ${safeJson(strDialog)}`);
	store.OnGameOverlayActivateRequested(request);
	return true;
}

/** Open a web page in the running game's overlay browser. */
export function openInOverlay(appid: number, url: string): boolean {
	return sendOverlayRequest(appid, true, url);
}

/**
 * Open one of the handler's named dialogs in the overlay -- the SDK's
 * ActivateGameOverlay vocabulary ("settings", "friends", "community", ...).
 * Note "settings" is hard-wired to Settings("System") in the handler, which
 * is exactly where a SystemUpdate click goes.
 */
export function openDialogInOverlay(appid: number, dialog: string): boolean {
	return sendOverlayRequest(appid, false, dialog);
}
