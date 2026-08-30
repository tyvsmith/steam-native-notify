/**
 * "React tree -> typed notification", in one place.
 *
 * Steam attaches its own decoded notification object to the toast's React
 * tree: `{ eType, eSource, data, ... }`. The shape of `data` depends on
 * `eSource` (docs/steam-routing.md): client-sourced (1), it is Steam's own
 * decoded protobuf message, a Closure wrapper whose values sit POSITIONALLY
 * in `array`. Server-sourced (2), it is a plain rollup object
 * `{ type, item, url }` whose `item.body_data` is a JSON string.
 *
 * On this branch the decode feeds ONLY the from-toast log line -- clicks
 * replay Steam's own handler and never read these fields -- so the client
 * payload is passed through as the raw positional array. Field names come
 * from the generated protobuf schema, which was removed with the routing
 * catalog; docs/regeneration.md says where it lives and how to bring it
 * back, and docs/notification-types.md maps the type numbers.
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
