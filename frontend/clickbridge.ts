import { callable } from 'millennium';
import { dlog } from './log';
import { invokeReplayHandler } from './replay';

/**
 * The click bridge: every notification click is delivered through here.
 *
 * tools/notify-action writes the clicked payload to a click file, and this
 * end consumes it. On this branch the payload is a replay token
 * (`replay:<toast-name>`): the click re-runs the handler Steam attached to
 * that toast, stashed at capture time (replay.ts). Surface, navigation, and
 * side effects are whatever Steam's own click does -- there is no routing
 * catalog. Known limit (docs/experiments/click-replay.md): the handler is
 * frozen to the surface the toast rendered on.
 *
 * The poll is armed by deliverToast for ARM_WINDOW_MS after each delivery and
 * stops itself afterwards, so an idle session polls nothing.
 */
const takeClick = callable<[], string>('TakeClick');

const CLICK_POLL_MS = 1000;
export const ARM_WINDOW_MS = 120_000;
/**
 * notify-action stamps each click with its write time (<epoch-seconds>|
 * <payload>). The poll only runs while armed, so a click written after the
 * disarm would sit in the file and fire as a surprise on the NEXT arm, up to
 * days later; anything older than this is dropped instead of opened.
 */
const CLICK_MAX_AGE_S = 30;

/** The payload prefix deliverToast hands notify-action for stashed toasts. */
export const REPLAY_CLICK_PREFIX = 'replay:';

let armedUntil = 0;
let timer: number | null = null;

export function armClickBridge(): void {
	armedUntil = Date.now() + ARM_WINDOW_MS;
	if (timer !== null) return;
	timer = window.setInterval(async () => {
		if (Date.now() > armedUntil) {
			if (timer !== null) window.clearInterval(timer);
			timer = null;
			return;
		}
		try {
			// The click file holds a plain stamped string, so the callable's
			// return needs exactly ONE unwrap -- parseCallableJson would parse
			// twice (its payloads are JSON documents) and silently eat the
			// route it just consumed. That bug shipped once; hence the log
			// line on every consumed click.
			const raw = await takeClick();
			const taken = typeof raw === 'string' && raw ? (JSON.parse(raw) as string) : '';
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
			if (!invokeReplayHandler(route.slice(REPLAY_CLICK_PREFIX.length))) {
				dlog('click-bridge: replay did not run');
			}
		} catch (e) {
			dlog(`click-bridge failed: ${(e as Error)?.message ?? e}`);
		}
	}, CLICK_POLL_MS);
}
