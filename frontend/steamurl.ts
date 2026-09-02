import { dlog } from './log';
import { invokeReplayHandler, raiseSteamWindow, REPLAY_CLICK_PREFIX } from './replay';

/**
 * The Windows click transport: Steam's own steam:// dispatch.
 *
 * A desktop notification cannot reach this plugin directly on Windows.
 * Measured on Windows 11 (docs/platforms.md): a toast activates
 * `activationType="protocol"` only for schemes Windows already knows --
 * `ms-settings:`, `http:`, and `steam:` all launch; a scheme this plugin
 * registers itself never does, under every registration tried. Steam's own
 * scheme is therefore the way in, and Steam hands a steam:// URL to the
 * client's JS, where this plugin lives.
 *
 * `RegisterForRunSteamURL` takes any section name (Millennium registers
 * `millennium` the same way), so a Windows toast carries
 * `steam://snn/replay/<toast-name>` and lands here with the token intact.
 *
 * Linux keeps the click file: notify-send hands the click back to a helper
 * this plugin owns, which needs no round trip through Steam. Registering
 * here is additive on every platform -- a second door to the same stash,
 * never a replacement for the bridge.
 */
const URL_SECTION = 'snn';

interface Unregisterable {
	unregister(): void;
}

interface SteamUrlApi {
	RegisterForRunSteamURL(section: string, callback: (n: number, url: string) => void): Unregisterable;
}

/**
 * `steam://snn/replay/<toast-name>` -> the toast name, or null for anything
 * else. Steam passes the URL through verbatim, so this end validates it: the
 * only shape ever emitted is one replay token of the characters Steam's own
 * popup names use.
 */
export function replayNameFromSteamUrl(url: string): string | null {
	const match = /^steam:\/{1,2}snn\/replay\/([A-Za-z0-9_.-]+)\/?$/.exec(url.trim());
	return match ? match[1] : null;
}

/**
 * Never throws: a failed registration must leave delivery untouched, and an
 * older client without the API simply has no Windows click path.
 */
export function registerSteamUrlClicks(): Unregisterable | null {
	try {
		const api = (Reflect.get(globalThis, 'SteamClient') as { URL?: SteamUrlApi } | undefined)?.URL;
		if (typeof api?.RegisterForRunSteamURL !== 'function') {
			dlog('steam-url: RegisterForRunSteamURL unavailable; no steam:// click path');
			return null;
		}
		const registration = api.RegisterForRunSteamURL(URL_SECTION, (_n: number, url: string) => {
			try {
				const name = replayNameFromSteamUrl(String(url ?? ''));
				if (!name) {
					dlog(`steam-url: ignored ${String(url).slice(0, 120)}`);
					return;
				}
				dlog(`steam-url: ${REPLAY_CLICK_PREFIX}${name}`);
				raiseSteamWindow();
				if (!invokeReplayHandler(name)) dlog('steam-url: replay did not run');
			} catch (e) {
				dlog(`steam-url handler failed: ${(e as Error)?.message ?? e}`);
			}
		});
		dlog(`steam-url: registered steam://${URL_SECTION}/replay/<toast>`);
		return registration;
	} catch (e) {
		dlog(`steam-url: registration failed: ${(e as Error)?.message ?? e}`);
		return null;
	}
}
