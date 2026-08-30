import { firstFiber } from './fiber';

/**
 * "React tree -> typed notification", in one place.
 *
 * Steam attaches its own decoded notification object to the toast's React
 * tree: `{ eType, eSource, data, ... }`. Client-sourced (eSource 1), `data`
 * is a Closure protobuf whose values sit POSITIONALLY in `array`;
 * server-sourced (2), a plain rollup whose `item.body_data` is JSON
 * (docs/steam-routing.md). The decode feeds ONLY the from-toast log line,
 * so the client payload passes through as the raw array -- the schema that
 * named its fields left with the catalog (docs/regeneration.md §2;
 * docs/notification-types.md maps the type numbers).
 */
export type DecodedNotification =
	| { source: 'client'; type: number; raw: unknown[] }
	| { source: 'server'; type: number; server: ServerNotification };

/** The server (eSource=2) rollup, as the toast components receive it. */
export interface ServerNotification {
	type: number;
	body: Record<string, unknown> | null;
	url?: string;
}

/** eSource on Steam's notification object: which of the two systems produced it. */
const SOURCE_SERVER = 2;

/**
 * The notification Steam attached to the toast, read out of the React tree.
 *
 * Preferred over the notification feed because it sees more: an incoming voice
 * chat renders as `notificationtoasts_10000_desktop` and produces no feed
 * event at all. Returns null when the tree cannot be read; the toast is still
 * delivered, just without the log detail.
 */
export function notificationFromToast(win: Window): DecodedNotification | null {
	// Declared outside the try: a throw on a fiber ABOVE the notification must
	// not discard an already-decoded result.
	let decoded: DecodedNotification | null = null;
	try {
		const doc = win.document;
		if (!doc) return null;

		let fiber: any = firstFiber(doc);
		if (!fiber) return null;
		for (let depth = 0; fiber && depth < 30; depth++) {
			const props = fiber.memoizedProps ?? fiber.pendingProps;
			const notification = props?.notification;
			if (!decoded && notification && typeof notification === 'object') {
				const type = Number((notification as any).eType);
				const source = Number((notification as any).eSource);
				const data = (notification as any).data;

				if (source === SOURCE_SERVER) {
					let body: Record<string, unknown> | null = null;
					try {
						const raw = data?.item?.body_data;
						if (typeof raw === 'string' && raw) body = JSON.parse(raw);
					} catch {
						/* an unparseable body logs as null, and the raw dump in the log shows why */
					}
					decoded = {
						source: 'server',
						type,
						server: {
							type: Number(data?.type),
							body,
							url: typeof data?.url === 'string' ? data.url : undefined,
						},
					};
				} else {
					const array = data?.array;
					decoded = { source: 'client', type, raw: Array.isArray(array) ? array : [] };
				}
			}
			if (decoded) break;
			fiber = fiber.return;
		}
		return decoded;
	} catch {
		/* a toast that cannot be fully read still gets delivered; whatever
		   decoded before the throw survives */
	}
	return decoded;
}
