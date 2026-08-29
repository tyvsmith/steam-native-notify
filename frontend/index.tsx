import { callable, definePlugin, IconsModule } from 'millennium';
import { typeName } from './generated/notifications';
import { clientOverlayAction, clientRoute, serverRoute } from './routes';
import { notificationFromToast, takeToastBrowserInfo, type DecodedNotification } from './notification';
import { setIdentity } from './identity';
import { loadUrlTemplates } from './urlstore';
import { dlog, safeJson } from './log';
import { armClickBridge } from './clickbridge';
import { rememberToastContext, trackOverlayFocus } from './overlay';
import { startDevFirePoll } from './devfire';
import { stashReplayCandidates } from './replay';
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
	// Steam renders each toast in the surface the user is on: overlay-context
	// names (notificationtoasts_uid<appid>-...) mean the game was focused,
	// _desktop names mean it was not -- even with a game running.
	const overlayCtx = name.startsWith('notificationtoasts_uid');
	// The walk also surfaces the toast's per-surface browserInfo, which the
	// chat dialogs key on; stash it for the click bridge (overlay.ts).
	rememberToastContext(overlayCtx, takeToastBrowserInfo());
	// Experiment probe (docs/experiments/click-replay.md): stash the toast's
	// own click handler before the popup can be closed. Never throws.
	stashReplayCandidates(win, name);

	let route: string | null = null;
	let ingame: string | null = null;
	let kind: string | undefined;
	try {
		if (fromToast) {
			kind = typeName(fromToast.type);
			route = routeFor(fromToast);
			if (fromToast.source === 'client') ingame = clientOverlayAction(fromToast.type, fromToast.fields);
			const detail =
				fromToast.source === 'server'
					? `server type=${fromToast.server.type} url=${fromToast.server.url ?? ''} body=${safeJson(fromToast.server.body)}`
					: `fields=${safeJson(fromToast.fields)}`;
			dlog(`from-toast ${name} type=${fromToast.type} (${kind}) source=${fromToast.source} ${detail}`.slice(0, 700));
		}
	} catch (e) {
		dlog(`from-toast ${name} failed: ${(e as Error)?.message ?? e}`);
		route = null;
		ingame = null;
	}
	// An overlay-context toast is one Steam already showed inside the focused
	// game. With nativeToastInGame on, that toast is the notification: nothing
	// is sent to the desktop and Steam's popup is left alone (hideSteamToast
	// included). The capture and logs above still run, so tools/capture and
	// the observability contract are unchanged.
	const suppressed = overlayCtx && settings().nativeToastInGame;
	dlog(
		`toast ${name} -> ${safeJson({ title, body, image, kind, route, ingame })}` +
			(suppressed ? ' (suppressed: native in-game)' : ''),
	);
	if (!suppressed) void notify({ payload: safeJson({ title, body, image, route, ingame }) });

	// notify-action delivers every click back through a file; arm the bridge
	// that picks it up and chooses the surface by live focus (clickbridge.ts).
	// A suppressed toast arms it too: arming only ever extends the window, and
	// an earlier desktop notification may still be waiting for its click.
	armClickBridge();

	// Closing Steam's own popup is what stops a notification being reported
	// twice. Done here rather than with a compositor rule because the plugin
	// knows the read succeeded, and because it works on any window manager.
	if (settings().hideSteamToast && !suppressed) {
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
	trackOverlayFocus();
	startDevFirePoll();

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
