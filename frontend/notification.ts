import { fieldsForType } from './generated/notifications';
import type { PbValue, ServerNotification } from './routes';

/**
 * "React tree -> typed notification", in one place.
 *
 * Steam attaches its own decoded notification object to the toast's React
 * tree: `{ eType, eSource, data, ... }`. The shape of `data` depends on
 * `eSource` (docs/steam-routing.md): client-sourced (1), it is Steam's own
 * decoded protobuf message, a Closure wrapper whose values sit in `array` at
 * `fieldNumber + arrayIndexOffset_`, with field names from the generated
 * schema. Server-sourced (2), it is a plain rollup object `{ type, item, url }`
 * whose `item.body_data` is a JSON string.
 *
 * Everything that knows those two layouts lives here; consumers get a
 * discriminated union and never see eSource, fiber keys, or array offsets.
 */
export type DecodedNotification =
	| { source: 'client'; type: number; fields: Record<string, PbValue> }
	| { source: 'server'; type: number; server: ServerNotification };

/** eSource on Steam's notification object: which of the two systems produced it. */
const SOURCE_SERVER = 2;

/** Set as a side effect of the walk; consumed once by the caller. */
let foundBrowserInfo: unknown = null;

export function takeToastBrowserInfo(): unknown {
	const v = foundBrowserInfo;
	foundBrowserInfo = null;
	return v;
}

/**
 * The notification Steam attached to the toast, read out of the React tree.
 *
 * Preferred over the notification feed because it sees more: an incoming voice
 * chat renders as `notificationtoasts_10000_desktop` and produces no feed
 * event at all, so anything relying on the feed cannot route it. The toast is
 * rendered from whatever produced the notification, so reading it here covers
 * every source. Returns null when the tree cannot be read; the toast is still
 * delivered, just without a route.
 */
export function notificationFromToast(win: Window): DecodedNotification | null {
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

		// The walk continues past the notification-bearing fiber: the
		// per-surface browserInfo (which the chat dialogs key on) lives on a
		// context provider ABOVE the toast component -- as the provider's
		// `value` (the popup object with params.browserInfo) or as plain props
		// higher up. Returning early would miss it.
		let decoded: DecodedNotification | null = null;
		let fiber: any = (node as any)[key];
		for (let depth = 0; fiber && depth < 30; depth++) {
			const props = fiber.memoizedProps ?? fiber.pendingProps;
			const bi =
				props?.browserInfo ??
				props?.params?.browserInfo ??
				props?.value?.params?.browserInfo ??
				props?.value?.browserInfo;
			if (bi && typeof bi === 'object') foundBrowserInfo = bi;

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
						/* an unparseable body routes as null, and the raw dump in the log shows why */
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
					const fields: Record<string, PbValue> = {};
					const schema = fieldsForType(type);
					const array = data?.array;
					const offset = typeof data?.arrayIndexOffset_ === 'number' ? data.arrayIndexOffset_ : -1;
					if (schema && Array.isArray(array)) {
						for (const [num, field] of Object.entries(schema)) {
							const value = array[Number(num) + offset];
							// A repeated field arrives as an array, which PbValue cannot
							// represent; no current route reads one, and this cast would
							// hide it if one ever did. Extend PbValue before routing one.
							if (value !== undefined && value !== null) fields[field.name] = value as PbValue;
						}
					}
					decoded = { source: 'client', type, fields };
				}
			}
			fiber = fiber.return;
		}
		return decoded;
	} catch {
		/* a toast that cannot be read still gets delivered, just without a route */
	}
	return null;
}
