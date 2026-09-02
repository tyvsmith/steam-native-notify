import { ffi } from 'millennium';
import { dlog } from './log';
import { CLICK_WINDOW_MS, invokeReplayHandler, raiseSteamWindow, REPLAY_CLICK_PREFIX } from './replay';

/**
 * The click transport: tools/notify-action writes each clicked payload
 * (`replay:<toast-name>`, stamped with its write time) to a click file;
 * this end consumes it and hands the name to replay.ts. The poll is armed
 * by deliverToast for CLICK_WINDOW_MS after each delivery -- the same
 * constant that bounds the handler stash, so a consumed click always finds
 * its handler -- and stops itself afterwards; an idle session polls
 * nothing.
 */
const takeClick = ffi<[], string>('TakeClick');

const CLICK_POLL_MS = 1000;
/**
 * A click written after the disarm would sit in the file and fire as a
 * surprise on the NEXT arm, up to days later; anything older than this is
 * dropped instead of opened.
 */
const CLICK_MAX_AGE_S = 30;

let armedUntil = 0;
let timer: number | null = null;

export function armClickBridge(): void {
	armedUntil = Date.now() + CLICK_WINDOW_MS;
	if (timer !== null) return;
	timer = window.setInterval(async () => {
		if (Date.now() > armedUntil) {
			if (timer !== null) window.clearInterval(timer);
			timer = null;
			return;
		}
		try {
			// The click file holds a plain stamped string. A Lua string return
			// has arrived both raw and JSON-quoted across Millennium transports
			// (the old callable double-encoded; a wrong unwrap silently ate the
			// route once) -- so unwrap only what is provably a JSON string, and
			// keep the log line on every consumed click.
			const raw = await takeClick();
			const taken =
				typeof raw === 'string' && raw ? (raw.startsWith('"') ? (JSON.parse(raw) as string) : raw) : '';
			if (typeof taken !== 'string' || !taken) return;
			const sep = taken.indexOf('|');
			const stamp = sep > 0 ? Number(taken.slice(0, sep)) : NaN;
			const route = sep > 0 ? taken.slice(sep + 1) : '';
			if (!Number.isFinite(stamp) || !route) {
				dlog(`click-bridge: unstamped click dropped: ${taken.slice(0, 120)}`);
				return;
			}
			const age = Math.round(Date.now() / 1000 - stamp);
			if (age > CLICK_MAX_AGE_S) {
				dlog(`click-bridge: stale click dropped (${age}s old): ${route}`);
				return;
			}
			dlog(`click-bridge: ${route}`);
			if (!route.startsWith(REPLAY_CLICK_PREFIX)) {
				dlog(`click-bridge: unbridgeable route ${route}`);
				return;
			}
			// Only for a click that will actually replay: a refused payload
			// must not pull Steam forward for nothing.
			raiseSteamWindow();
			if (!invokeReplayHandler(route.slice(REPLAY_CLICK_PREFIX.length))) {
				dlog('click-bridge: replay did not run');
			}
		} catch (e) {
			dlog(`click-bridge failed: ${(e as Error)?.message ?? e}`);
		}
	}, CLICK_POLL_MS);
}
