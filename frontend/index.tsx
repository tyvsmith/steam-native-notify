import { callable, definePlugin, findModuleExport, IconsModule } from '@steambrew/client';
import { fieldsForType, typeName } from './generated/notifications';
import {
	clientRoute,
	serverRoute,
	SOURCE_SERVER,
	type PbValue,
	type ServerNotification,
} from './routes';
import { loadUrlTemplates } from './urlstore';
import { SettingsPanel } from './Settings';
import { loadSettings, parseCallableJson, settings } from './settings';

/**
 * Steam draws every notification as its own CEF popup window, named
 * `notificationtoasts_<N>_desktop`. The window title is all the compositor can
 * see; the text a person reads only exists in that popup's DOM. So the bridge
 * has to live in here, where the document is reachable.
 *
 * The toast supplies everything: what a person reads -- title, body, artwork --
 * from its DOM, and the typed notification behind it from its React tree, where
 * Steam attaches its own decoded object. The notification feed
 * (`SteamClient.Notifications.RegisterForNotifications`) was used for the typed
 * half and deleted: it misses types entirely (an incoming voice chat produces no
 * feed event at all), while the React path sees every source.
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
const logLine = callable<[{ line: string }], string>('Log');
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

let debug = true;

function dlog(line: string): void {
	if (!debug) return;
	try {
		void logLine({ line });
	} catch {
		/* Diagnostics must never take the notification path down with them. */
	}
}

/**
 * JSON.stringify throws outright on a BigInt, and Steam's decoded values can be
 * any protobuf scalar. A debug line that throws killed every notification once
 * already, so serialising for logs is done defensively.
 */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) ?? 'undefined';
	} catch (e) {
		return `<unserialisable: ${(e as Error)?.message ?? e}>`;
	}
}

interface ToastNotification {
	type: number;
	/** eSource: 1 = classic client notification, 2 = the server (web) system. */
	source: number;
	/** Client-sourced: fields decoded from the Closure array via the schema. */
	fields: Record<string, PbValue>;
	/** Server-sourced: the rollup's type, parsed body_data and url. */
	server: ServerNotification | null;
}

/**
 * The notification Steam attached to the toast, read out of the React tree.
 *
 * Preferred over the feed because it sees more: an incoming voice chat renders
 * as `notificationtoasts_10000_desktop` and produces no feed event at all, so
 * anything relying on the feed cannot route it. The toast is rendered from
 * whatever produced the notification, so reading it here covers every source.
 *
 * The shape of `data` depends on `eSource` (docs/steam-routing.md):
 * client-sourced, it is Steam's own decoded protobuf message, a Closure wrapper
 * whose values sit in `array` at `fieldNumber + arrayIndexOffset_`; field names
 * come from the generated schema. Server-sourced, it is a plain rollup object
 * `{ type, item, ... }` whose `item.body_data` is a JSON string.
 */
function notificationFromToast(win: Window): ToastNotification | null {
	try {
		const doc = win.document;
		if (!doc) return null;

		let node: Element | null = null;
		let key: string | undefined;
		for (const el of Array.from(doc.querySelectorAll('*'))) {
			key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
			if (key) {
				node = el;
				break;
			}
		}
		if (!node || !key) return null;

		let fiber: any = (node as any)[key];
		for (let depth = 0; fiber && depth < 12; depth++) {
			const notification = (fiber.memoizedProps ?? fiber.pendingProps)?.notification;
			if (notification && typeof notification === 'object') {
				const type = Number((notification as any).eType);
				const source = Number((notification as any).eSource);
				const data = (notification as any).data;
				const fields: Record<string, PbValue> = {};
				let server: ServerNotification | null = null;

				if (source === SOURCE_SERVER) {
					let body: Record<string, unknown> | null = null;
					try {
						const raw = data?.item?.body_data;
						if (typeof raw === 'string' && raw) body = JSON.parse(raw);
					} catch {
						/* an unparseable body routes as null, and the raw dump below shows why */
					}
					server = {
						type: Number(data?.type),
						body,
						url: typeof data?.url === 'string' ? data.url : undefined,
					};
				} else {
					const schema = fieldsForType(type);
					const array = data?.array;
					const offset = typeof data?.arrayIndexOffset_ === 'number' ? data.arrayIndexOffset_ : -1;
					if (schema && Array.isArray(array)) {
						for (const [num, field] of Object.entries(schema)) {
							const value = array[Number(num) + offset];
							if (value !== undefined && value !== null) fields[field.name] = value as PbValue;
						}
					}
				}
				return { type, source, fields, server };
			}
			fiber = fiber.return;
		}
	} catch {
		/* a toast that cannot be read still gets delivered, just without a route */
	}
	return null;
}

/**
 * The current user's steamid64, from the backend (loginusers.vdf). Server-side
 * notification routes to "my" community pages need it; missing, those routes
 * come back null rather than broken.
 */
let me64: string | null = null;

/** Route the way Steam would; the rules and their citations live in routes.ts. */
function routeFor(n: ToastNotification): string | null {
	if (n.source === SOURCE_SERVER && n.server) return serverRoute(n.server, me64);
	return clientRoute(n.type, n.fields, me64);
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
				fromToast.source === SOURCE_SERVER
					? `server type=${fromToast.server?.type} url=${fromToast.server?.url ?? ''} body=${safeJson(fromToast.server?.body)}`
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
		// After the read, never before: a toast that could not be read is worth
		// leaving on screen rather than silently swallowing.
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
	if (!debug) return;
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
		const id = parsed?.steamid64;
		if (typeof id === 'string' && /^\d{17}$/.test(id)) me64 = id;
		dlog(`identity: steamid64=${me64 ?? '(none)'}`);
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
