import { callable, definePlugin, IconsModule } from '@steambrew/client';
import { fieldsForType, typeName } from './generated/notifications';
import { SettingsPanel } from './Settings';
import { loadSettings, settings } from './settings';

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

type PbValue = number | bigint | string;

/**
 * The notification Steam attached to the toast, read out of the React tree.
 *
 * Preferred over the feed because it sees more: an incoming voice chat renders
 * as `notificationtoasts_10000_desktop` and produces no feed event at all, so
 * anything relying on the feed cannot route it. The toast is rendered from
 * whatever produced the notification, so reading it here covers every source.
 *
 * `data` is Steam's own decoded protobuf message, a Closure wrapper whose values
 * sit in `array` at `fieldNumber + arrayIndexOffset_`. Field names still come
 * from the generated schema; only the byte-level decoding is skipped.
 */
function notificationFromToast(win: Window): { type: number; fields: Record<string, PbValue> } | null {
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
				const data = (notification as any).data;
				const schema = fieldsForType(type);
				const fields: Record<string, PbValue> = {};

				const array = data?.array;
				const offset = typeof data?.arrayIndexOffset_ === 'number' ? data.arrayIndexOffset_ : -1;
				if (schema && Array.isArray(array)) {
					for (const [num, field] of Object.entries(schema)) {
						const value = array[Number(num) + offset];
						if (value !== undefined && value !== null) fields[field.name] = value as PbValue;
					}
				}
				return { type, fields };
			}
			fiber = fiber.return;
		}
	} catch {
		/* a toast that cannot be read still gets delivered, just without a route */
	}
	return null;
}

/**
 * The steam:// route a notification's click should follow, or null when Steam
 * itself does nothing.
 *
 * Mirroring, not improving: each rule matches behaviour observed by clicking
 * Steam's own toast while watching the client.
 *
 *   FriendMessage      opens the chat with the sender
 *   DownloadCompleted  switches the library to that game
 *
 * `response_steamurl` looked authoritative, being the only route-shaped field in
 * the schema, but a real friend message decoded with it set to "". Steam
 * declares it and does not fill it, so it is checked and then not relied on.
 *
 * Types are gated explicitly. FriendOnline carries a steamid too, but whether
 * its toast does anything is unestablished, and routing on the mere presence of
 * an id is how the earlier invented routes crept in.
 */
function routeFor(type: number, fields: Record<string, PbValue>): string | null {
	const url = fields.response_steamurl;
	if (typeof url === 'string' && url.startsWith('steam://')) return url;

	// Everything friend-shaped opens the chat with that person. Observed on
	// Steam's own toasts, with a Steam window focused -- which turns out to be
	// required for a toast to be clickable at all, and is why several earlier
	// readings of "it does nothing" were wrong.
	//
	//   8  FriendMessage       observed
	//   4  FriendOnline        observed
	//  17  IncomingVoiceChat   observed; opens the chat, does not accept the call
	//   9  GroupChatMessage    not observed, same shape and a chat id
	//
	// Deliberately absent: FriendInvite (2) and FriendInGame (3). Both carry a
	// steamid and probably behave the same, but "has a steamid" is the reasoning
	// that produced the invented routes earlier, so they wait for a real click.
	if (type === 8 || type === 9 || type === 4 || type === 17) {
		const person = fields.steamid ?? fields.steamid_sender;
		if (typeof person === 'bigint') return `steam://friends/message/${person.toString()}`;
		if (typeof person === 'string' && /^\d{17}$/.test(person)) {
			return `steam://friends/message/${person}`;
		}
	}

	// DownloadCompleted, Achievement.
	if (type === 1 || type === 5) {
		const appid = fields.appid;
		if (typeof appid === 'number' && appid > 0) return `steam://nav/games/details/${appid}`;
	}

	return null;
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
			route = routeFor(fromToast.type, fromToast.fields);
			dlog(`from-toast ${name} type=${fromToast.type} (${kind}) fields=${safeJson(fromToast.fields)}`.slice(0, 700));
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

export default definePlugin(() => {
	void loadSettings();
	installHook();

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
