import { callable, definePlugin, pluginConfig, subscribePluginConfig } from '@steambrew/client';

/**
 * Steam draws every notification as its own CEF popup window, named
 * `notificationtoasts_<N>_desktop`. The window title is all the compositor can
 * see; the text a person reads only exists in that popup's DOM. So the bridge
 * has to live in here, where the document is reachable.
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
 * ONE key per callable, always. Millennium does not map an argument object's
 * keys onto the Lua parameter names -- with `{ title, body }` the values arrived
 * in the wrong order, producing a notification with its summary and body
 * swapped. A single JSON string has no ordering to get wrong.
 */
const notify = callable<[{ payload: string }], string>('Notify');
const takePending = callable<[], string>('TakePending');
const logLine = callable<[{ line: string }], string>('Log');

/**
 * Steam's own toast is left on screen by default so a failure here is visible
 * rather than silent. Flip this once the bridge is trusted; the popup is closed
 * after its text has been read, so nothing is lost.
 */
const HIDE_STEAM_TOAST = false;

/**
 * The popup window exists before it has painted, so a single settle delay is a
 * guess that goes wrong on a slow frame. Poll for content instead: a late toast
 * is delivered late rather than delivered empty.
 */
const READ_INTERVAL_MS = 80;
const READ_ATTEMPTS = 15; // ~1.2s before giving up on a toast

const MANAGER_RETRY_MS = 500;
const MANAGER_RETRY_LIMIT = 60; // ~30s, covers a cold Steam start

/**
 * Feed events keyed by their index. The feed fires roughly 400ms before the
 * toast window appears, and Steam uses the same counter for both -- feed
 * `index=1` belongs to `notificationtoasts_1_desktop`. That shared number is the
 * correlation key, so nothing has to be matched on timing or text.
 */
const feedByIndex = new Map<number, { type: number; kind: string; route: string | null }>();
const FEED_LIMIT = 50;

let uuidCounter = 0;

function nextUuid(): string {
	uuidCounter += 1;
	return `snn-${Date.now()}-${uuidCounter}`;
}

/** The counter in notificationtoasts_<N>_desktop, or null if it is not one. */
function toastIndex(name: string): number | null {
	const m = /^notificationtoasts_(\d+)_desktop$/.exec(name);
	return m ? Number(m[1]) : null;
}

/** Toast names already sent, so a re-fired callback cannot double-notify. */
const delivered = new Set<string>();
const registrations: Registration[] = [];

let debug = false;

function dlog(line: string): void {
	if (!debug) return;
	void logLine({ line });
}

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

	// Only offer a click action when the feed gave us an index to replay with;
	// a notification whose click would do nothing is worse than a plain one.
	const index = toastIndex(name);
	const feed = index !== null ? feedByIndex.get(index) : undefined;
	let uuid: string | null = null;

	if (index !== null && feed) {
		uuid = nextUuid();
		rememberReplay(uuid, index);
		feedByIndex.delete(index);
	}

	const route = feed?.route ?? null;
	dlog(`toast ${name} -> ${JSON.stringify({ title, body, image, uuid, kind: feed?.kind, route })}`);
	void notify({ payload: JSON.stringify({ title, body, image, uuid, route }) });

	if (HIDE_STEAM_TOAST) {
		try {
			win.close();
		} catch (e) {
			dlog(`could not close ${name}: ${(e as Error)?.message ?? e}`);
		}
	}
}

/**
 * The capsule or avatar the toast is showing. Steam serves these from its own
 * virtual host, which nothing outside the client can fetch -- but the path maps
 * one-to-one onto Steam's on-disk library cache, so the backend resolves it to a
 * real file rather than downloading anything. Duplicated <img> tags are common
 * (icon plus a hidden preload), so the first is enough.
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

/**
 * Steam's own notification feed, and the reason the DOM scrape is a stopgap.
 * Each notification arrives typed, with a protobuf body that carries the very
 * thing the toast's click uses -- `response_steamurl` on a friend message, an
 * `appid` on a download, chat ids on a group message. Nothing has to be guessed
 * from rendered text.
 *
 * Decoding needs Steam's generated message class, which is not in hand yet, so
 * this stage only records the type and the raw body as base64. That is enough to
 * decode offline against the published protos and decide how to reach the
 * fields properly.
 *
 * Names are indexed by EClientNotificationType, so position matters.
 */
const NOTIFICATION_TYPES = [
	'Invalid', 'DownloadComplete', 'FriendInvite', 'FriendInGame', 'FriendOnline',
	'Achievement', 'LowBattery', 'SystemUpdate', 'FriendMessage', 'GroupChatMessage',
	'FriendInviteRollup', 'FamilySharingDeviceAuthorizationChanged', 'FamilySharingStopPlaying',
	'FamilySharingLibraryAvailable', 'Screenshot', 'CloudSyncFailure', 'CloudSyncConflict',
	'IncomingVoiceChat', 'ClaimSteamDeckRewards', 'GiftReceived', 'ItemAnnouncement',
	'HardwareSurvey', 'LowDiskSpace', 'BatteryTemperature', 'DockUnsupportedFirmware',
	'PeerContentUpload', 'CannotReadControllerGuideButton', 'Comment', 'Wishlist',
	'TradeOffer', 'AsyncGame', 'General', 'HelpRequest', 'OverlaySplashScreen',
	'BroadcastAvailableToWatch', 'TimedTrialRemaining', 'LoginRefresh', 'MajorSale',
	'TimerExpired', 'ModeratorMsg', 'SteamInputActionSetChanged', 'RemoteClientConnection',
	'RemoteClientStartStream', 'StreamingClientConnection', 'FamilyInvite', 'PlaytimeWarning',
	'FamilyPurchaseRequest', 'FamilyPurchaseRequestResponse', 'ParentalFeatureRequest',
	'ParentalPlaytimeRequest', 'GameRecordingError', 'ParentalFeatureResponse',
	'ParentalPlaytimeResponse', 'RequestedGameAdded', 'ClipDownloaded', 'GameRecordingStart',
	'GameRecordingStop', 'GameRecordingUserMarkerAdded', 'GameRecordingInstantClip',
];

/**
 * Enough protobuf to read a notification body: field number -> value, where a
 * value is a number (varint), a bigint (fixed64) or a string (length-delimited).
 * Steam's notification messages are flat, so nothing recurses.
 */
type PbFields = Map<number, number | bigint | string>;

function decodeProto(buffer: ArrayBuffer): PbFields {
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const fields: PbFields = new Map();
	let i = 0;

	const varint = (): number => {
		let value = 0, shift = 0;
		while (i < bytes.length) {
			const byte = bytes[i++];
			value += (byte & 0x7f) * Math.pow(2, shift);
			if (!(byte & 0x80)) break;
			shift += 7;
		}
		return value;
	};

	while (i < bytes.length) {
		const key = varint();
		const field = key >>> 3;
		switch (key & 7) {
			case 0:
				fields.set(field, varint());
				break;
			case 1:
				if (i + 8 > bytes.length) return fields;
				fields.set(field, view.getBigUint64(i, true));
				i += 8;
				break;
			case 2: {
				const len = varint();
				if (i + len > bytes.length) return fields;
				fields.set(field, new TextDecoder().decode(bytes.subarray(i, i + len)));
				i += len;
				break;
			}
			case 5:
				if (i + 4 > bytes.length) return fields;
				fields.set(field, view.getUint32(i, true));
				i += 4;
				break;
			default:
				return fields; // groups: not used by these messages
		}
	}
	return fields;
}

/** SteamID64s for individual accounts occupy a known, narrow range. */
const STEAMID_MIN = 76561197960265728n;
const STEAMID_MAX = 76561202255233024n;

function findSteamId(fields: PbFields): bigint | null {
	for (const value of fields.values()) {
		if (typeof value === 'bigint' && value >= STEAMID_MIN && value < STEAMID_MAX) return value;
	}
	return null;
}

/** Appids are positive and far below the range anything else here occupies. */
function findAppId(fields: PbFields): number | null {
	for (const value of fields.values()) {
		if (typeof value === 'number' && value > 0 && value < 100_000_000) return value;
	}
	return null;
}

/**
 * The steam:// route a notification's click should follow.
 *
 * Preferred over OnRespondToClientNotification, which was tried against both a
 * DownloadComplete and a FriendOnline and acted on neither -- the feed's index
 * is not the id it wants, and FriendOnline carries no notificationid at all.
 *
 * Fields are searched by shape rather than by position. Position looked safe
 * from three verified captures (DownloadComplete puts appid in field 1,
 * FriendOnline and FriendInGame put a SteamID64 there) but it does not
 * generalise: Achievement declares achievement_id before appid, and
 * GroupChatMessage declares a string tag first, so a field-1 rule would read the
 * wrong thing for both. A SteamID64 and an appid are unmistakable by value.
 */
function routeFor(type: number, fields: PbFields): string | null {
	// Steam's own answer, wherever it sits. This is `response_steamurl` on a
	// friend message.
	for (const value of fields.values()) {
		if (typeof value === 'string' && value.startsWith('steam://')) return value;
	}

	// FriendInvite, FriendInGame, FriendOnline, FriendMessage, GroupChatMessage.
	if (type === 2 || type === 3 || type === 4 || type === 8 || type === 9) {
		const steamid = findSteamId(fields);
		if (steamid !== null) return `steam://friends/message/${steamid.toString()}`;
	}

	// DownloadComplete, Achievement.
	if (type === 1 || type === 5) {
		const appid = findAppId(fields);
		if (appid !== null) return `steam://nav/games/details/${appid}`;
	}

	return null;
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function installNotificationProbe(attempt: number = 0): void {
	const sc: any = Reflect.get(globalThis, 'SteamClient');

	// Two different objects, easily confused. The feed lives on Notifications;
	// ClientNotifications is for displaying one and -- the useful part -- for
	// replaying the action attached to one.
	const feed = sc?.Notifications;
	const client = sc?.ClientNotifications;

	if (!feed?.RegisterForNotifications) {
		if (attempt < MANAGER_RETRY_LIMIT) {
			setTimeout(() => installNotificationProbe(attempt + 1), MANAGER_RETRY_MS);
		} else {
			dlog(`no notification feed. SteamClient keys=${JSON.stringify(sc ? Object.keys(sc) : null)}`);
		}
		return;
	}

	dlog(`Notifications keys=${JSON.stringify(Object.keys(feed))}`);
	dlog(`ClientNotifications keys=${JSON.stringify(client ? Object.keys(client) : null)}`);
	dlog(`can replay = ${typeof client?.OnRespondToClientNotification === 'function'}`);

	try {
		registrations.push(
			feed.RegisterForNotifications((index: number, type: number, data: ArrayBuffer) => {
				const kind = NOTIFICATION_TYPES[type] ?? `Unknown(${type})`;
				const size = data?.byteLength ?? 0;

				if (feedByIndex.size >= FEED_LIMIT) {
					const oldest = feedByIndex.keys().next().value;
					if (oldest !== undefined) feedByIndex.delete(oldest);
				}
				let route: string | null = null;
				try {
					if (size > 0) route = routeFor(type, decodeProto(data));
				} catch (e) {
					dlog(`decode failed for index=${index}: ${(e as Error)?.message ?? e}`);
				}
				feedByIndex.set(index, { type, kind, route });

				dlog(`notif index=${index} type=${type} (${kind}) bytes=${size} route=${route}`);
				if (debug && size > 0 && size < 4096) {
					dlog(`notif index=${index} b64=${toBase64(data)}`);
				}
			}),
		);
		dlog('notification feed registered');
	} catch (e) {
		dlog(`notification feed failed: ${(e as Error)?.message ?? e}`);
	}
}

/**
 * uuid -> the notification index Steam gave us, so a click that arrives long
 * after the toast is gone still knows which notification it belongs to. Held in
 * memory rather than on disk: the process that records an entry is the one that
 * replays it, and a Steam restart invalidates the indices anyway.
 */
const replayable = new Map<string, number>();
const REPLAYABLE_LIMIT = 200;

export function rememberReplay(uuid: string, index: number): void {
	if (replayable.size >= REPLAYABLE_LIMIT) {
		// Oldest first; Map preserves insertion order.
		const oldest = replayable.keys().next().value;
		if (oldest !== undefined) replayable.delete(oldest);
	}
	replayable.set(uuid, index);
}

/**
 * Run Steam's own callback for a notification -- whatever it was. This is the
 * whole reason the bridge exists: no route table, no per-type mapping, no
 * guessing what a chat versus an achievement should open.
 */
function replay(uuid: string): void {
	const index = replayable.get(uuid);
	if (index === undefined) {
		dlog(`replay ${uuid}: unknown, ignoring`);
		return;
	}
	replayable.delete(uuid);

	const client: any = Reflect.get(globalThis, 'SteamClient')?.ClientNotifications;
	if (typeof client?.OnRespondToClientNotification !== 'function') {
		dlog(`replay ${uuid}: OnRespondToClientNotification unavailable`);
		return;
	}

	try {
		client.OnRespondToClientNotification(index, true);
		dlog(`replay ${uuid} -> OnRespondToClientNotification(${index}, true)`);
	} catch (e) {
		dlog(`replay ${uuid} failed: ${(e as Error)?.message ?? e}`);
	}
}

/**
 * The inbound half of the bridge. tools/notify-action writes the clicked uuid
 * into this plugin's config over Millennium's external protocol; the change is
 * pushed here. The key is cleared afterwards so the same click cannot fire twice
 * and so a stale value cannot replay on the next Steam start.
 */
/**
 * Ask the backend for clicked notifications. Only runs while something is
 * actually replayable, so an idle Steam does no work at all.
 */
const CLICK_POLL_MS = 750;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function ensurePolling(): void {
	if (pollTimer !== null) return;
	pollTimer = setInterval(async () => {
		try {
			const token = decodeCallableString(await takePending());
			if (!token) return;
			// A reserved name so the whole pipeline can be driven from a shell
			// without waiting on Steam to produce a notification of its own.
			if (token === SELFTEST_KEY) displayTestNotification();
			else replay(token);
		} catch (e) {
			dlog(`poll failed: ${(e as Error)?.message ?? e}`);
		}
	}, CLICK_POLL_MS);
	dlog('click polling started');
}

function stopPolling(): void {
	if (pollTimer === null) return;
	clearInterval(pollTimer);
	pollTimer = null;
	dlog('click polling stopped');
}

/**
 * A callable's return value arrives JSON-encoded, so a Lua string comes back
 * wrapped in literal quote characters. Comparing it raw silently fails -- the
 * first symptom was a reserved token being treated as an unknown uuid.
 */
function decodeCallableString(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
		try {
			const parsed = JSON.parse(raw);
			return typeof parsed === 'string' ? parsed : '';
		} catch {
			return raw.slice(1, -1);
		}
	}
	return raw;
}

function installClickBridge(): void {
	// Millennium dispatches config changes to listeners keyed by plugin name; the
	// single-argument form of subscribePluginConfig registers under '' and never
	// matches. Both are registered because which one fires for an MEP-originated
	// change is exactly what this is meant to establish.
	const unsubscribe = subscribePluginConfig(PLUGIN_NAME, (key: string, value: any) => {
		if (key === REPLAY_KEY && typeof value === 'string' && value) {
			dlog(`click bridge received ${value}`);
			replay(value);
			void pluginConfig.delete(REPLAY_KEY);
		}

		// Displays a real Steam notification, so the whole pipeline can be
		// exercised without waiting on a friend to message you.
		if (key === SELFTEST_KEY && value) {
			displayTestNotification();
			void pluginConfig.delete(SELFTEST_KEY);
		}
	});
	const unsubscribeBare = subscribePluginConfig((key: string, value: any) => {
		dlog(`click bridge (bare listener) saw ${key}=${JSON.stringify(value)}`);
	});

	registrations.push({ Unregister: unsubscribe });
	registrations.push({ Unregister: unsubscribeBare });
	dlog('click bridge installed');
}

const REPLAY_KEY = 'replay';
const SELFTEST_KEY = 'selftest';
const PLUGIN_NAME = 'steam-native-notify';

function displayTestNotification(): void {
	const client: any = Reflect.get(globalThis, 'SteamClient')?.ClientNotifications;
	if (typeof client?.DisplayClientNotification !== 'function') {
		dlog('selftest: DisplayClientNotification unavailable');
		return;
	}
	try {
		client.DisplayClientNotification(
			8, // FriendMessage-shaped, the type whose action is least reconstructable
			JSON.stringify({
				title: 'Toast Bridge',
				body: 'Synthetic notification for testing the feed',
				state: 'online',
				steamid: '0',
			}),
			() => {},
		);
		dlog('selftest: DisplayClientNotification dispatched');
	} catch (e) {
		dlog(`selftest failed: ${(e as Error)?.message ?? e}`);
	}
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

export default definePlugin(() => {
	debug = true; // prototype: log every toast until the extraction is trusted
	installHook();
	installNotificationProbe();
	installClickBridge();
	ensurePolling();

	return {
		title: 'Steam Native Notify',
		icon: null,
		content: null,

		// Reached from backend/main.lua via millennium.call_frontend_method.
		// The Lua config.on_change hook is documented to fire for MEP-originated
		// writes, which the frontend subscription may not.
		onReplay(uuid: string) {
			dlog(`onReplay(${uuid}) from backend`);
			replay(uuid);
		},

		onSelfTest() {
			dlog('onSelfTest() from backend');
			displayTestNotification();
		},
		onDismount() {
			stopPolling();
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
