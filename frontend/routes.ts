import { resolveUrl } from './urlstore';

/**
 * The steam:// route a notification's click should follow, or null when Steam's
 * own toast click does nothing this plugin can reproduce.
 *
 * Every rule mirrors the click handler in Steam's shipped UI bundle; the
 * per-type inventory, the module references, and the delivery equivalences
 * (why `steam://friends/message` IS `ShowFriendChatDialog`, why
 * `steam://openurl/` IS Steam's own `SteamWeb`) live in docs/steam-routing.md.
 * Do not add a rule without a row there.
 */

export type PbValue = number | bigint | string;

/** eSource on Steam's notification object: which of the two systems produced it. */
export const SOURCE_CLIENT = 1;
export const SOURCE_SERVER = 2;

/**
 * Steam's `SteamWeb(url)` navigation is `location.href = url` for steam:// URLs
 * and `location.href = "steam://openurl/" + url` for everything else. Emitting
 * the same shape means the click lands in the client's own handler.
 */
function openInClient(url: string | null | undefined): string | null {
	if (!url || typeof url !== 'string') return null;
	if (url.startsWith('steam://')) return url;
	if (!/^https?:\/\//.test(url)) return null;
	return `steam://openurl/${url}`;
}

function chatWith(person: PbValue | undefined): string | null {
	if (typeof person === 'bigint') return `steam://friends/message/${person.toString()}`;
	if (typeof person === 'string' && /^\d{17}$/.test(person)) return `steam://friends/message/${person}`;
	return null;
}

function appDetails(appid: PbValue | undefined): string | null {
	if (typeof appid === 'number' && appid > 0) return `steam://nav/games/details/${appid}`;
	return null;
}

/** Client-sourced notifications (eSource=1), fields decoded via the schema. */
export function clientRoute(type: number, fields: Record<string, PbValue>, me64: string | null): string | null {
	switch (type) {
		// nav.App(appid): DownloadCompleted (observed: switches the library to
		// that game), CloudSyncFailure, CloudSyncConflict.
		case 1:
		case 15:
		case 16:
			return appDetails(fields.appid);

		// ShowFriendChatDialog(steamid): FriendInGame, FriendOnline,
		// FriendMessage, IncomingVoiceChat. FriendOnline, FriendMessage and
		// IncomingVoiceChat also observed on a real client; a voice request
		// opens the chat without accepting the call, and so does this.
		case 3:
		case 4:
		case 8:
		case 17:
			return chatWith(fields.steamid);

		// SteamWeb(ResolveURL("SteamIDAchievementsPage", appid)). The template
		// is Steam's, fetched at startup; only the %p1% substitution runs here.
		case 5: {
			const appid = fields.appid;
			if (typeof appid !== 'number' || appid <= 0) return null;
			return openInClient(resolveUrl('SteamIDAchievementsPage', appid));
		}

		// Settings dialog: SystemUpdate opens System; HardwareUpdateAvailable
		// opens Controller on the desktop client.
		case 7:
			return 'steam://settings/system';
		case 61:
			return 'steam://settings/controller';

		// GroupChatMessage: Steam opens the chat *room* dialog
		// (ShowChatRoomGroupDialog), which no steam:// URL reaches. Opening a
		// 1:1 chat with the sender would be a different action, so: nothing.
		case 9:
			return null;

		// FriendInviteRollup: Steam opens the invites dialog, which has no URL;
		// the pending-invites page is where Steam's server-sourced FriendInvite
		// click lands on desktop, and shows the same invites.
		case 10: {
			const community = resolveUrl('CommunityFrontPage');
			const my = me64 && /^\d{17}$/.test(me64) ? me64 : null;
			return community && my ? openInClient(`${community}profiles/${my}/friends/pending`) : null;
		}

		// Everything else is a dismiss-only toast, an explicit no-op, or a
		// modal this plugin cannot reproduce. The full inventory is the
		// client-sourced catalog in docs/steam-routing.md.
		default:
			return null;
	}
}

/** The rollup Steam attaches for server-sourced notifications (eSource=2). */
export interface ServerNotification {
	/** ESteamNotificationType, from data.type. */
	type: number;
	/** Parsed item.body_data, or null when it did not parse. */
	body: Record<string, unknown> | null;
	/** The rollup's own url field (Comment carries a community-relative path). */
	url?: string;
}

/**
 * Server-sourced notifications. Steam's own mapping is type → URL from
 * body_data (module 655 registries and the pr component map); these rules are
 * that mapping, with base URLs resolved from Steam's URL table and `me64` the
 * current user's steamid64 (read from loginusers.vdf by the backend).
 */
export function serverRoute(n: ServerNotification, me64: string | null): string | null {
	const community = resolveUrl('CommunityFrontPage');
	const store = resolveUrl('StoreFrontPage');
	const body = n.body ?? {};
	const my = me64 && /^\d{17}$/.test(me64) ? me64 : null;

	switch (n.type) {
		case 2: // Gift: ResolveURL("PendingGift")
			return openInClient(resolveUrl('PendingGift'));

		case 3: // Comment: community + rollup url
			return typeof n.url === 'string' && n.url && community ? openInClient(community + n.url) : null;

		case 4: // Item announcement: my inventory
			return community && my ? openInClient(`${community}profiles/${my}/inventory`) : null;

		case 5: // Friend invite: my pending invites page
			return community && my ? openInClient(`${community}profiles/${my}/friends/pending`) : null;

		case 6: // Major sale: the link Steam put in the body
		case 10: // General: likewise
			return openInClient(typeof body.link === 'string' ? body.link : null);

		case 8: {
			// Wishlist: several apps -> wishlist filtered to them; one app ->
			// Steam prefers the app's store page, falling back to the wishlist
			// with ?appid= when app data is not loaded. The fallback is the
			// branch reproducible here.
			if (!store || !my) return null;
			const appids = Array.isArray(body.appids) ? body.appids : null;
			const count = typeof body.count === 'number' ? body.count : 0;
			if (count > 1 && appids?.length) {
				return openInClient(`${store}wishlist/profiles/${my}/?wng=${appids.toString()}#sort=discount`);
			}
			const appid = typeof body.appid === 'number' ? `?appid=${body.appid}` : '';
			return openInClient(`${store}wishlist/profiles/${my}/${appid}#sort=discount`);
		}

		case 9: // Trade offer: my trade offers page
			return community && my ? openInClient(`${community}profiles/${my}/tradeoffers`) : null;

		case 11: {
			// Help request reply: the ticket's help wizard page
			const help = resolveUrl('HelpFrontPage');
			const ticket = typeof body.ticket === 'number' || typeof body.ticket === 'string' ? body.ticket : null;
			return help && ticket !== null ? openInClient(`${help}wizard/HelpRequest/${ticket}`) : null;
		}

		case 12: // Async game (Steam Turn): my game notifications
			return community ? openInClient(`${community}my/gamenotifications/`) : null;

		case 14: {
			// Moderator message: the specific message
			const msgid = typeof body.msgid === 'number' || typeof body.msgid === 'string' ? body.msgid : null;
			return community && msgid !== null ? openInClient(`${community}my/moderatormessages/${msgid}`) : null;
		}

		case 16: {
			// Family invite: the join page for that family
			const familyid = typeof body.familyid === 'number' || typeof body.familyid === 'string' ? body.familyid : null;
			return store && familyid !== null
				? openInClient(`${store}account/familymanagement/join?invitation=${familyid}`)
				: null;
		}

		// Family/parental requests and responses all land on the requests tab.
		case 15:
		case 17:
		case 18:
		case 19:
		case 20:
		case 21:
			return store ? openInClient(`${store}account/familymanagement?tab=requests`) : null;

		case 28: {
			// Playtest invite: the gated-access page for that app
			const appid = typeof body.appid === 'number' ? body.appid : null;
			return store && appid ? openInClient(`${store}account/gatedaccess?appid=${appid}`) : null;
		}

		case 29: // Trade reversal: my trade history
			return community ? openInClient(`${community}my/tradehistory`) : null;

		// RequestedGameAdded needs Steam's package->app lookup and
		// ClipDownloaded opens a Media dialog no URL reaches: nothing.
		default:
			return null;
	}
}
