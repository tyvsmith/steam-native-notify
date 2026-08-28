import { callable, definePlugin, findModuleExport, IconsModule } from '@steambrew/client';
import { typeName } from './generated/notifications';
import { clientRoute, serverRoute } from './routes';
import { notificationFromToast, type DecodedNotification } from './notification';
import { setIdentity } from './identity';
import { loadUrlTemplates } from './urlstore';
import { dlog, safeJson } from './log';
import { SettingsPanel } from './Settings';
import { loadSettings, parseCallableJson, settings } from './settings';

/**
 * Steam draws every notification as its own CEF popup window, named
 * `notificationtoasts_<N>_desktop`. The window title is all the compositor can
 * see; the text a person reads only exists in that popup's DOM. So the bridge
 * has to live in here, where the document is reachable.
 *
 * This file owns the popup lifecycle: hook the popup manager, wait for a toast
 * to paint, deliver it once, close it if asked. What the toast means lives
 * elsewhere -- notification.ts decodes Steam's attached object, routes.ts turns
 * it into a steam:// route.
 *
 * `g_PopupManager` is not public API. It is what the shipping
 * kitsune-notifications plugin uses to find the same windows, which is the only
 * reason to trust it. If Valve renames it, `installHook` gives up quietly after
 * MANAGER_RETRY_LIMIT tries and the bridge goes silent rather than throwing.
 */
interface SteamPopup {
	window?: (Window & typeof globalThis) | null;
}

interface Registration {
	Unregister(): void;
}

interface SteamPopupManager {
	AddPopupCreatedCallback(cb: (popup: SteamPopup) => void): Registration;
	AddPopupDestroyedCallback(cb: (popup: SteamPopup) => void): Registration;
}

const TOAST_PREFIX = 'notificationtoasts_';

/**
 * ONE key per callable. Millennium does not map an argument object's keys onto
 * the Lua parameter names -- with `{ title, body }` the values arrived in the
 * wrong order and produced a notification with its summary and body swapped. A
 * single JSON string has no ordering to get wrong.
 */
const notify = callable<[{ payload: string }], string>('Notify');
const identity = callable<[], string>('Identity');
const takeDevCommand = callable<[], string>('TakeDevCommand');

/**
 * The popup window exists before it has painted, so a single settle delay is a
 * guess that goes wrong on a slow frame. Poll for content instead: a late toast
 * is delivered late rather than delivered empty.
 */
const READ_INTERVAL_MS = 80;
const READ_ATTEMPTS = 15; // ~1.2s before giving up on a toast

const MANAGER_RETRY_MS = 500;
const MANAGER_RETRY_LIMIT = 60; // ~30s, covers a cold Steam start

/** Toast names already sent, so a re-fired callback cannot double-notify. */
const delivered = new Set<string>();
const registrations: Registration[] = [];

/** Route the way Steam would; the rules and their citations live in routes.ts. */
function routeFor(n: DecodedNotification): string | null {
	switch (n.source) {
		case 'client':
			return clientRoute(n.type, n.fields);
		case 'server':
			return serverRoute(n.server);
	}
}

// --------------------------------------------------------------------------
// toast capture
// --------------------------------------------------------------------------

function toastName(popup: SteamPopup): string | null {
	const name = popup.window?.name;
	if (!name || name.indexOf(TOAST_PREFIX) !== 0) return null;
	return name;
}

/**
 * Steam's toasts put the actor or heading on the first line and the message
 * under it. A single-line toast has no heading, so the app name stands in --
 * better than a notification whose title is its own body.
 */
function split(text: string): { title: string; body: string } {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

	if (lines.length === 0) return { title: 'Steam', body: '' };
	if (lines.length === 1) return { title: 'Steam', body: lines[0] };
	return { title: lines[0], body: lines.slice(1).join(' — ') };
}

/**
 * The capsule or avatar the toast is showing. Game art comes from Steam's own
 * virtual host and a friend's avatar from the public CDN; the helper knows how
 * to resolve either, so the raw reference is passed through untouched.
 */
function toastImage(win: Window): string | null {
	try {
		const first = Array.from(win.document?.images ?? [])
			.map((i) => i.src)
			.find(Boolean);
		return first ?? null;
	} catch {
		return null;
	}
}

/**
 * Wait for the toast to paint, then hand it to deliverToast. Polls at
 * READ_INTERVAL_MS for up to READ_ATTEMPTS (~1.2s); a toast that closes first
 * or never paints is logged and dropped, never delivered empty.
 */
function readWhenPainted(win: Window, name: string, attempt: number = 0): void {
	if (win.closed) {
		dlog(`toast ${name} closed before it painted`);
		return;
	}

	const text = (win.document?.body?.innerText ?? '').trim();

	if (!text) {
		if (attempt < READ_ATTEMPTS) {
			setTimeout(() => readWhenPainted(win, name, attempt + 1), READ_INTERVAL_MS);
		} else {
			dlog(`toast ${name} never painted any text`);
		}
		return;
	}

	deliverToast(win, name, text);
}

/**
 * Deliver one painted toast: at most once per popup name, never throwing, and
 * only after a successful read -- Steam's own popup is closed at the end, and
 * a toast this function could not read stays on screen rather than being
 * silently swallowed.
 */
function deliverToast(win: Window, name: string, text: string): void {
	if (delivered.has(name)) return;
	delivered.add(name);

	const { title, body } = split(text);
	const image = toastImage(win);
	const fromToast = notificationFromToast(win);

	let route: string | null = null;
	let kind: string | undefined;
	try {
		if (fromToast) {
			kind = typeName(fromToast.type);
			route = routeFor(fromToast);
			const detail =
				fromToast.source === 'server'
					? `server type=${fromToast.server.type} url=${fromToast.server.url ?? ''} body=${safeJson(fromToast.server.body)}`
					: `fields=${safeJson(fromToast.fields)}`;
			dlog(`from-toast ${name} type=${fromToast.type} (${kind}) source=${fromToast.source} ${detail}`.slice(0, 700));
		}
	} catch (e) {
		dlog(`from-toast ${name} failed: ${(e as Error)?.message ?? e}`);
		route = null;
	}
	dlog(`toast ${name} -> ${safeJson({ title, body, image, kind, route })}`);
	void notify({ payload: safeJson({ title, body, image, route }) });

	// Closing Steam's own popup is what stops a notification being reported
	// twice. Done here rather than with a compositor rule because the plugin
	// knows the read succeeded, and because it works on any window manager.
	if (settings().hideSteamToast) {
		try {
			win.close();
		} catch (e) {
			dlog(`could not close ${name}: ${(e as Error)?.message ?? e}`);
		}
	}
}

function onPopupCreated(popup: SteamPopup): void {
	const name = toastName(popup);
	if (!name || !popup.window) return;
	readWhenPainted(popup.window, name, 0);
}

function onPopupDestroyed(popup: SteamPopup): void {
	const name = toastName(popup);
	// Names carry an incrementing counter, so a destroyed one never comes back.
	// Dropping it here keeps the set from growing for the life of the session.
	if (name) delivered.delete(name);
}

function installHook(attempt: number = 0): void {
	const mgr = Reflect.get(globalThis, 'g_PopupManager') as SteamPopupManager | undefined;

	if (!mgr) {
		if (attempt < MANAGER_RETRY_LIMIT) {
			setTimeout(() => installHook(attempt + 1), MANAGER_RETRY_MS);
		} else {
			dlog('g_PopupManager never appeared; bridge inactive');
		}
		return;
	}

	try {
		registrations.push(mgr.AddPopupCreatedCallback(onPopupCreated));
		registrations.push(mgr.AddPopupDestroyedCallback(onPopupDestroyed));
		dlog('hook installed');
	} catch (e) {
		dlog(`hook failed: ${(e as Error)?.message ?? e}`);
	}
}

/**
 * IconsModule is typed `any` and resolved from Steam's webpack bundle at
 * runtime, so a name that does not exist compiles cleanly and then renders as
 * undefined -- which React reports as error #130 and which takes down the whole
 * Steam UI, not just this panel. Pick the first name that actually resolves, and
 * fall back to no icon rather than to a crash.
 */
function pluginIcon(): any {
	const icons: any = IconsModule;
	for (const name of ['Notification', 'Bell', 'Settings', 'Gear']) {
		const candidate = icons?.[name];
		if (typeof candidate === 'function' || typeof candidate === 'object') {
			try {
				return window.SP_REACT.createElement(candidate, {});
			} catch {
				/* try the next one */
			}
		}
	}
	return null;
}

/**
 * Dev trigger: `tools/fire` writes a command file; the backend hands it over
 * exactly once via TakeDevCommand. The command names a test method on Steam's
 * own NotificationStore (a shared-context global, `window.NotificationStore`),
 * whose Test* functions push a real synthesized notification through the full
 * toast pipeline -- the only self-service way to exercise most types.
 * Debug-only machinery; the notification path never depends on it.
 */
const DEV_POLL_MS = 3000;

/**
 * The server notification store is not a window global; it is found the way
 * lead 1 always suggested, by webpack export search. Its OnServerNotification
 * is the real ingestion path for eSource=2 notifications -- the one live
 * server events take -- so a synthetic rollup pushed through it exercises
 * capture, extraction and routing exactly as a real wishlist sale would.
 * Valve's own server-type test methods are stubbed out in the shipped build,
 * which is why this door exists.
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

function pollDevCommands(): void {
	window.setInterval(async () => {
		try {
			const raw = await takeDevCommand();
			const cmd = parseCallableJson<{
				call?: string;
				args?: unknown[];
				server?: { type: number; body?: unknown };
			} | null>(raw, null);
			if (!cmd) return;
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

async function loadIdentity(): Promise<void> {
	try {
		const parsed = parseCallableJson<{ steamid64?: string }>(await identity(), {});
		const id = setIdentity(parsed?.steamid64);
		dlog(`identity: steamid64=${id ?? '(none)'}`);
	} catch (e) {
		dlog(`identity failed: ${(e as Error)?.message ?? e}`);
	}
}

export default definePlugin(() => {
	void loadSettings();
	void loadIdentity();
	void loadUrlTemplates().then((summary) => dlog(`url templates: ${summary}`));
	installHook();
	pollDevCommands();

	return {
		title: 'Steam Native Notify',
		icon: pluginIcon(),
		content: <SettingsPanel />,
		onDismount() {
			for (const r of registrations.splice(0)) {
				try {
					r.Unregister();
				} catch {
					/* Steam tore the manager down first; nothing to release. */
				}
			}
		},
	} as any;
});
