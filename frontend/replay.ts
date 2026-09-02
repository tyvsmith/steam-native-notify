import { dlog } from './log';
import { chooseHandler, type Candidate } from './choose';
import { firstFiber } from './fiber';

/**
 * The replay click path: a notification click re-runs the handler Steam
 * attached to the toast, taken from its React tree at capture time and
 * invoked later by the click bridge. choose.ts decides which handler a
 * click may run; a toast it refuses stays unclickable, the mirror of a
 * Steam toast whose click does nothing. Known limit (measured,
 * docs/experiments/click-replay.md): the handler is frozen to the surface
 * its toast rendered on.
 *
 * Every `replay: candidates` line is the health probe for the reflective
 * layers, in order: `n=0 (no fiber key)` -- the fiber convention moved;
 * `portal=miss` -- the HostPortal boundary moved; `stashed=none
 * (ambiguous)` -- Steam stopped drilling the handler object. No line at
 * all means the popup hook is dead. Diagnostics never throw; a failed walk
 * only costs that toast its click.
 */

/** The click-file payload prefix: `replay:<toast-name>`. */
export const REPLAY_CLICK_PREFIX = 'replay:';

/**
 * How long a delivered notification stays clickable. The click bridge polls
 * for exactly this long after each delivery, and the stash keeps handlers
 * exactly as long -- one constant, so a click the bridge would still
 * consume always finds its handler. The stash is also bounded to the
 * latest STASH_MAX toasts: a stashed closure pins its captured scope.
 */
export const CLICK_WINDOW_MS = 120_000;
const STASH_MAX = 8;

const SNIPPET_LEN = 200;
const MAX_FIBERS = 5000;
/** Detail lines logged per anomalous toast; the rest is one +N summary. */
const LOG_CANDIDATES_MAX = 12;

/**
 * Candidate metadata without the function: what the stash retains for
 * --replay inspect. Only the CHOSEN handler's closure is worth pinning for
 * CLICK_WINDOW_MS; a portal miss once collected 673 candidates.
 */
type CandidateMeta = Omit<Candidate, 'fn'>;

interface StashEntry {
	name: string;
	stashedAt: number;
	/** The proven handler, or null for an ambiguous toast kept for inspect. */
	fn: ((e: unknown) => unknown) | null;
	chosen: CandidateMeta | null;
	candidates: CandidateMeta[];
}

const stash = new Map<string, StashEntry>();

function toMeta({ fn: _fn, ...meta }: Candidate): CandidateMeta {
	return meta;
}

function pruneStash(): void {
	const cutoff = Date.now() - CLICK_WINDOW_MS;
	for (const [key, entry] of stash) {
		if (entry.stashedAt < cutoff) stash.delete(key);
	}
	while (stash.size > STASH_MAX) {
		const oldest = stash.keys().next().value;
		if (oldest === undefined) break;
		stash.delete(oldest);
	}
}

function fnMeta(fn: unknown): { fnName: string; snippet: string } {
	try {
		return {
			fnName: (fn as { name?: string })?.name ?? '',
			snippet: String(fn).replace(/\s+/g, ' ').slice(0, SNIPPET_LEN),
		};
	} catch {
		return { fnName: '', snippet: '<toString failed>' };
	}
}

/**
 * The toast popup is portal-rendered from the main window's React tree, so
 * the walk roots at the HostPortal fiber (tag 4) whose containerInfo lives
 * in the popup's document -- rooting any higher sweeps the whole Steam UI
 * (the 673-candidate incident in the experiment doc). Fallback when no
 * portal is found: the highest fiber whose stateNode is still in the popup
 * document.
 */
function toastSubtreeRoot(fiber: any, doc: Document): { root: any; viaPortal: boolean } {
	let cur = fiber;
	let best = fiber;
	for (let up = 0; cur && up < 80; up++) {
		try {
			if (cur.tag === 4 && cur.stateNode?.containerInfo?.ownerDocument === doc) {
				return { root: cur, viaPortal: true };
			}
			const sn = cur.stateNode;
			if (sn && typeof sn === 'object' && sn.ownerDocument === doc) best = cur;
			// A host fiber in ANOTHER document means the portal boundary was
			// passed without matching; everything above is main-window tree.
			if (sn && typeof sn === 'object' && sn.ownerDocument && sn.ownerDocument !== doc) break;
		} catch {
			/* hostile getters must not stop the climb */
		}
		cur = cur.return;
	}
	return { root: best, viaPortal: false };
}

/**
 * Collect handler-bearing fibers breadth-first from the root, so the array
 * comes back shallowest-first.
 */
function collectCandidates(rootFiber: any): Candidate[] {
	const candidates: Candidate[] = [];
	let queue: { fiber: any; depth: number }[] = [{ fiber: rootFiber, depth: 0 }];
	let visited = 0;
	while (queue.length > 0 && visited < MAX_FIBERS) {
		const next: typeof queue = [];
		for (const { fiber, depth } of queue) {
			if (!fiber || visited >= MAX_FIBERS) break;
			visited++;
			try {
				const props = fiber.memoizedProps ?? fiber.pendingProps;
				if (props && typeof props === 'object') {
					for (const prop of ['onClick', 'onActivate']) {
						const fn = props[prop];
						if (typeof fn === 'function') candidates.push({ prop, depth, fn, ...fnMeta(fn) });
					}
				}
			} catch {
				/* a fiber with hostile props must not stop the walk */
			}
			for (let child = fiber.child; child; child = child.sibling) {
				next.push({ fiber: child, depth: depth + 1 });
			}
		}
		queue = next;
	}
	return candidates;
}

/**
 * Walk the toast's tree, stash the handler choose.ts proves, and return the
 * click token the notification should carry -- null when the toast must
 * stay unclickable. Called from deliverToast before the popup can be
 * closed; never throws, never blocks delivery. An ambiguous toast is
 * stashed without a handler so --replay inspect can still show what the
 * walk saw.
 */
export function stashToastHandler(win: Window, name: string): string | null {
	try {
		const doc = win.document;
		if (!doc) return null;
		const fiber = firstFiber(doc);
		if (!fiber) {
			dlog(`replay: candidates ${name} n=0 (no fiber key in toast document)`);
			return null;
		}

		const { root, viaPortal } = toastSubtreeRoot(fiber, doc);
		const candidates = collectCandidates(root);
		const picked = chooseHandler(candidates);
		const health = viaPortal ? '' : ' portal=miss';
		const summary = picked
			? `stashed=${picked.chosen.prop}@${picked.chosen.depth} (${picked.how})`
			: 'stashed=none (ambiguous)';
		dlog(`replay: candidates ${name} n=${candidates.length} ${summary}${health}`);
		// Detail only on anomaly, and capped: the summary line carries the
		// whole health signal, and each detail line is a callable plus a file
		// write -- unbounded, a portal miss would emit hundreds per toast.
		if (!picked || !viaPortal) {
			candidates.slice(0, LOG_CANDIDATES_MAX).forEach((c, i) => {
				dlog(`replay: candidate ${name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
			});
			if (candidates.length > LOG_CANDIDATES_MAX) {
				dlog(`replay: candidate ${name} +${candidates.length - LOG_CANDIDATES_MAX} more`);
			}
		}

		stash.delete(name); // re-insert so the map stays insertion-ordered by recency
		stash.set(name, {
			name,
			stashedAt: Date.now(),
			fn: picked?.chosen.fn ?? null,
			chosen: picked ? toMeta(picked.chosen) : null,
			candidates: candidates.map(toMeta),
		});
		pruneStash();
		return picked ? `${REPLAY_CLICK_PREFIX}${name}` : null;
	} catch (e) {
		dlog(`replay: walk failed for ${name}: ${(e as Error)?.message ?? e}`);
		return null;
	}
}

/** Dump the stash: names, ages, candidate metadata. The --replay inspect door. */
export function inspectReplayStash(): void {
	dlog(`replay: stash size=${stash.size}`);
	for (const entry of stash.values()) {
		const age = Math.round((Date.now() - entry.stashedAt) / 1000);
		const chosen = entry.chosen ? `${entry.chosen.prop}@${entry.chosen.depth}` : 'none';
		dlog(`replay: stash ${entry.name} age=${age}s n=${entry.candidates.length} chosen=${chosen}`);
		entry.candidates.forEach((c, i) => {
			dlog(`replay: stash ${entry.name} #${i} ${c.prop}@${c.depth} name=${c.fnName || '(anon)'} :: ${c.snippet}`);
		});
	}
}

/**
 * Invoke a stashed handler with a stub event. No name targets the most
 * recent entry (the tools/fire probe rides the same poll as the fires).
 * A throw from the handler is logged verbatim and swallowed. Returns
 * whether a live handler was found and ran without throwing.
 */
/**
 * Raise Steam's desktop window, the way clicking Steam's own toast does.
 *
 * A replayed handler navigates the client but leaves the window where it
 * was, so a click with another app focused changed a page nobody could see.
 * SteamClient.Window.BringToFront is the client's own answer, but its
 * documentation is explicit that it must be called from the window being
 * raised -- never from SharedJSContext, where a plugin runs. g_PopupManager
 * is already this plugin's door to Steam's windows (index.tsx), so the call
 * is made through the main window's own SteamClient, with AndForceOS so the
 * OS actually brings it forward rather than flashing the taskbar.
 *
 * steam://open/main stays as the fallback: it navigates rather than raises
 * (measured on Windows 11 and Linux), but it is what creates the desktop
 * window when Steam is closed to the tray and there is no popup to raise.
 *
 * Best-effort throughout: a click must still replay if none of this works,
 * and on Wayland the compositor may refuse the focus change regardless.
 */
const BRING_TO_FRONT_FORCE_OS = 1; // EWindowBringToFront.AndForceOS
const TOAST_POPUP_PREFIX = 'notificationtoasts_';
/** Steam's own names for the desktop window, most specific first. */
const MAIN_WINDOW_NAMES = ['SP', 'Steam', 'SteamDesktop'];
/**
 * Whether a click may hide and re-show Steam's window to win the foreground.
 * Measured on Windows 11 (2026-09-01): it does NOT win it -- BringToFront,
 * MarkLastFocused, SetKeyFocus, ShowWindow and Hide+Show all ran and the
 * window stayed behind. Off, so nothing flickers for a raise Windows will
 * refuse anyway; kept as the record of what was tried (docs/platforms.md).
 */
const RAISE_BY_REPRESENTING = false;

/**
 * Every window Steam's popup manager knows. GetPopups() answered empty on a
 * live client with the desktop window open (measured 2026-09-01), while
 * m_mapPopups held them, so both are read and merged rather than trusting
 * either: this is undocumented client internals, and the shape has already
 * moved once.
 */
function steamPopups(): any[] {
	const mgr: any = Reflect.get(globalThis, 'g_PopupManager');
	if (!mgr) return [];
	const out: any[] = [];
	const absorb = (source: any) => {
		if (!source) return;
		if (Array.isArray(source)) out.push(...source);
		else if (typeof source.values === 'function') out.push(...Array.from(source.values() as Iterable<any>));
		else if (typeof source === 'object') out.push(...Object.values(source));
	};
	try {
		if (typeof mgr.GetPopups === 'function') absorb(mgr.GetPopups());
	} catch {
		/* an internal that moved; m_mapPopups below still answers */
	}
	absorb(mgr.m_mapPopups);
	// A popup may appear in both accessors, and Steam nests its own wrapper.
	const seen = new Set<any>();
	return out.filter((p) => p && !seen.has(p) && seen.add(p));
}

export function raiseSteamWindow(): void {
	try {
		const candidates = steamPopups().filter((p) => {
			const name = String(p?.window?.name ?? p?.m_strName ?? '');
			return name.indexOf(TOAST_POPUP_PREFIX) !== 0 && p?.window?.SteamClient?.Window;
		});
		const named = (n: string) =>
			candidates.find((p) => String(p?.window?.name ?? p?.m_strName ?? '').toLowerCase().indexOf(n) === 0);
		const target = MAIN_WINDOW_NAMES.map(named).find(Boolean) ?? candidates[0];
		if (target) {
			const name = String(target?.window?.name ?? target?.m_strName ?? '?');
			const api: any = target.window.SteamClient.Window;
			// Steam's own window calls, weakest side effect first. Windows
			// refuses a plain raise for a background process on an external
			// trigger (measured: BringToFront alone, and steam:// activation,
			// both leave the window behind), so the focus calls follow, and
			// FlashWindow is the sanctioned way to ask for attention when the
			// OS will not hand over the foreground. Each is optional in the
			// client build; the log names the ones that ran.
			const ran: string[] = [];
			const call = (fn: string, ...args: unknown[]) => {
				try {
					if (typeof api?.[fn] === 'function') {
						api[fn](...args);
						ran.push(fn);
					}
				} catch {
					/* one missing call must not stop the rest */
				}
			};
			call('BringToFront', BRING_TO_FRONT_FORCE_OS);
			call('MarkLastFocused');
			call('SetKeyFocus', true);
			call('FlashWindow');
			call('ShowWindow');
			// Last resort, and the only path with evidence behind it: showing
			// a window Steam had hidden DOES take focus (a click from the tray
			// comes forward), because Windows treats presenting a window
			// differently from raising a background one. It flickers, so it
			// runs only after the quiet calls above have failed to move
			// anything. ShowWindow is in a finally: a Hide that succeeded with
			// a Show that threw would leave the user with no Steam window.
			if (RAISE_BY_REPRESENTING && typeof api?.HideWindow === 'function' && typeof api?.ShowWindow === 'function') {
				try {
					api.HideWindow();
				} finally {
					api.ShowWindow();
					ran.push('Hide+Show');
				}
			}
			try {
				target.window.focus();
			} catch {
				/* focus() is a nudge; the calls above are the real ones. */
			}
			dlog(`raise: ${name} -> ${ran.join(',') || 'nothing available'}`);
			return;
		}
		// No window to raise: Steam is closed to the tray, where opening the
		// desktop window DOES take focus. steam://open/main is what creates it.
		const sc = Reflect.get(globalThis, 'SteamClient') as
			| { URL?: { ExecuteSteamURL?: (url: string) => void } }
			| undefined;
		sc?.URL?.ExecuteSteamURL?.('steam://open/main');
		dlog('raise: no window; steam://open/main');
	} catch (e) {
		dlog(`raise failed: ${(e as Error)?.message ?? e}`);
	}
}

export function invokeReplayHandler(name?: string): boolean {
	let entry: StashEntry | undefined;
	if (name) {
		entry = stash.get(name);
	} else {
		for (const e of stash.values()) entry = e; // last = most recent
	}
	if (!entry) {
		dlog(`replay: invoke ${name ?? '(latest)'} -> no stash entry`);
		return false;
	}
	const age = Math.round((Date.now() - entry.stashedAt) / 1000);
	if (Date.now() - entry.stashedAt > CLICK_WINDOW_MS) {
		dlog(`replay: invoke ${entry.name} -> expired (${age}s old)`);
		stash.delete(entry.name);
		return false;
	}
	if (!entry.fn || !entry.chosen) {
		dlog(`replay: invoke ${entry.name} -> entry has no handler`);
		return false;
	}
	dlog(`replay: invoke ${entry.name} ${entry.chosen.prop}@${entry.chosen.depth} age=${age}s`);
	const stubEvent = {
		preventDefault() {},
		stopPropagation() {},
	};
	try {
		entry.fn(stubEvent);
		dlog(`replay: invoke ${entry.name} -> returned without throwing`);
		return true;
	} catch (e) {
		const err = e as Error;
		dlog(`replay: invoke ${entry.name} -> THREW ${err?.name ?? ''}: ${err?.message ?? String(e)}`);
		if (err?.stack) dlog(`replay: invoke stack: ${String(err.stack).replace(/\s+/g, ' ').slice(0, 500)}`);
		return false;
	}
}
