import { callable, findModuleExport } from 'millennium';
import { dlog, safeJson } from './log';
import { parseCallableJson, settings } from './settings';
import { openDialogInOverlay, openInOverlay, openMediaInOverlay } from './overlay';

/**
 * The tools/fire door: dev machinery, fenced off from the capture path.
 *
 * `tools/fire` writes a command file; the backend hands it over exactly once
 * via TakeDevCommand; the poll here executes it. A command either names a test
 * method on Steam's own NotificationStore (whose Test* functions push a real
 * synthesized notification through the full toast pipeline) or carries a
 * synthetic server rollup for injection.
 *
 * This is a name-and-args door into Steam's stores for anything that can write
 * the plugin's cache directory, so it is OFF by default and gated on the devFire
 * setting -- checked per tick, so the settings toggle takes effect without a
 * restart, and a disabled gate costs one boolean read every 3s.
 */
const takeDevCommand = callable<[], string>('TakeDevCommand');

const DEV_POLL_MS = 3000;

/**
 * The server notification store is not a window global; it is found by webpack
 * export search. Its OnServerNotification is the real ingestion path for
 * eSource=2 notifications -- the one live server events take -- so a synthetic
 * rollup pushed through it exercises capture, extraction and routing exactly
 * as a real wishlist sale would. Valve's own server-type test methods are
 * stubbed out in the shipped build, which is why this door exists.
 */
let serverStore: any;

function findServerNotificationStore(): any {
	if (serverStore) return serverStore;
	try {
		serverStore = findModuleExport((e: any) => {
			try {
				return typeof e?.OnServerNotification === 'function' && typeof e?.MarkItemRead === 'function';
			} catch {
				return false;
			}
		});
	} catch (e) {
		dlog(`server store lookup failed: ${(e as Error)?.message ?? e}`);
	}
	return serverStore;
}

/**
 * A minimal rollup, shaped like the ones OnServerNotification receives:
 * everything the toast path reads from it is a plain property
 * (item.body_data, rgunread, timestamp), verified against the bundle.
 */
function injectServerNotification(type: number, body: unknown): void {
	const store = findServerNotificationStore();
	if (!store) {
		dlog('dev-fire: server notification store not found');
		return;
	}
	const id = Date.now() % 1_000_000_000;
	const now = Math.floor(Date.now() / 1000);
	const rollup = {
		type,
		rollup_key: id,
		item: {
			notification_id: id,
			// Bitfield of delivery targets; 8 is the toast bit, and
			// BToastEnabled falls back to this when the user has no stored
			// preference for the type. All bits set, so the fallback shows it.
			notification_targets: 15,
			notification_type: type,
			body_data: JSON.stringify(body ?? {}),
			read: false,
			viewed: 0,
			timestamp: now,
		},
		rgunread: [id],
		rgread: [] as number[],
		timestamp: now,
	};
	dlog(`dev-fire: OnServerNotification type=${type} body=${safeJson(body)}`);
	store.OnServerNotification(rollup, 0 /* New */);
}

/**
 * Overlay research probes, from the in-game click investigation (2026-08-29).
 * The production door lives in overlay.ts; these keep the raw calls testable:
 * `info` dumps the overlay browser map, `activate` fires the synthetic
 * request -- the probe that proved the mechanism, now what the click bridge
 * uses.
 */
async function runOverlayProbe(probe: { call?: string; appid?: number; url?: string }): Promise<void> {
	switch (probe.call) {
		case 'info': {
			const sc: any = Reflect.get(globalThis, 'SteamClient');
			const info = await sc?.Overlay?.GetOverlayBrowserInfo?.();
			dlog(`overlay-info: ${safeJson(info)}`.slice(0, 1500));
			return;
		}
		case 'activate': {
			if (!openInOverlay(probe.appid ?? 0, probe.url ?? '')) {
				dlog('overlay probe: store not found');
			}
			return;
		}
		case 'dialog': {
			if (!openDialogInOverlay(probe.appid ?? 0, probe.url ?? '')) {
				dlog('overlay probe: store not found');
			}
			return;
		}
		case 'media': {
			if (!openMediaInOverlay(probe.appid ?? 0)) {
				dlog('overlay probe: media door failed');
			}
			return;
		}
		default:
			dlog(`overlay probe: unknown call ${String(probe.call)}`);
	}
}

export function startDevFirePoll(): void {
	window.setInterval(async () => {
		if (!settings().devFire) return;
		try {
			const raw = await takeDevCommand();
			const cmd = parseCallableJson<{
				call?: string;
				args?: unknown[];
				server?: { type: number; body?: unknown };
				overlay?: { call?: string; appid?: number; url?: string };
			} | null>(raw, null);
			if (!cmd) return;
			if (cmd.overlay) {
				void runOverlayProbe(cmd.overlay);
				return;
			}
			if (cmd.server && typeof cmd.server.type === 'number') {
				injectServerNotification(cmd.server.type, cmd.server.body);
				return;
			}
			if (!cmd.call) return;
			const store: any = Reflect.get(globalThis, 'NotificationStore');
			const fn = store?.[cmd.call];
			if (typeof fn !== 'function') {
				dlog(`dev-fire: NotificationStore.${cmd.call} is not a function`);
				return;
			}
			dlog(`dev-fire: NotificationStore.${cmd.call}(${safeJson(cmd.args ?? [])})`);
			fn.apply(store, Array.isArray(cmd.args) ? cmd.args : []);
		} catch (e) {
			dlog(`dev-fire failed: ${(e as Error)?.message ?? e}`);
		}
	}, DEV_POLL_MS);
}
