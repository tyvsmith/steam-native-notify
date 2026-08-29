import { resolveUrl } from './urlstore';
import { myProfilePath } from './identity';

/**
 * The steam:// route a notification's click should follow, or null when Steam's
 * own toast click does nothing this plugin can reproduce.
 *
 * Every rule mirrors the click handler in Steam's shipped UI bundle; the
 * per-type inventory, the module references, and the delivery equivalences
 * (why `steam://friends/message` IS `ShowFriendChatDialog`, why
 * `steam://openurl/` IS Steam's own `SteamWeb`) live in docs/steam-routing.md.
 * Do not add a rule without a row there.
 *
 * Identity and URL templates are module state (identity.ts, urlstore.ts),
 * loaded once at startup; a rule that needs either and finds it missing
 * returns null rather than a broken URL.
 */

export type PbValue = number | bigint | string;

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

/**
 * Some templates address the signed-in user with a `%mystuff%` placeholder
 * (SteamIDAchievementsPage arrives as
 * `https://steamcommunity.com/%mystuff%/stats/appid/%p1%/achievements/`).
 * Steam's JS ResolveURL only substitutes %pN%, so the alias resolves later in
 * the logged-in client; from outside, `profiles/<steamid64>` is the same
 * prefix -- verified: that form 302s to the canonical achievements page.
 * Without an identity the route is dropped rather than emitted broken.
 */
function fillMyStuff(url: string | null): string | null {
	if (!url) return null;
	if (!url.includes('%mystuff%')) return url;
	const my = myProfilePath();
	return my ? url.replace('%mystuff%', my) : null;
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

/**
 * The signed-in user's pending-invites page. Two clicks land here by Steam's
 * own routing -- the client FriendInviteRollup toast and the server FriendInvite
 * toast (docs/steam-routing.md, both catalog rows) -- so the shared destination
 * is deliberate, not copy-paste.
 */
function pendingInvitesUrl(): string | null {
	const community = resolveUrl('CommunityFrontPage');
	const my = myProfilePath();
	return community && my ? `${community}${my}/friends/pending` : null;
}

/**
 * In-game-only actions for client types whose DESKTOP route is null but whose
 * in-game toast click does something Steam-observable. Tokens name overlay
 * doors, not URLs; the click bridge maps them (clickbridge.ts -> overlay.ts).
 * Observed 2026-08-29 in Helldivers 2: Steam's own in-game Screenshot click
 * opens the Recordings & Screenshots view; PlaytimeWarning pops the playtime
 * request dialog (the overlay ingestion's "requestplaytime" case).
 */
export function clientOverlayAction(type: number, fields: Record<string, PbValue>): string | null {
	switch (type) {
		case 14: {
			// Screenshot: Steam's own in-game click opens the SPECIFIC
			// screenshot (nav.Media.Screenshot({state:{id}})); the proto's
			// screenshot_handle is that id. Without one, the media grid.
			const handle = fields.screenshot_handle;
			return typeof handle === 'string' && handle ? `screenshot:${handle}` : 'media';
		}
		case 45: // PlaytimeWarning -> overlay playtime request dialog
			return 'requestplaytime';
		case 56: // GameRecordingStop: Steam's own click is
		case 58: {
			// nav.Media.Clip({state:{id: data.clip_id()}}) -- the specific clip.
			const clip = fields.clip_id;
			return typeof clip === 'string' && clip ? `clip:${clip}` : 'media';
		}
		default:
			return null;
	}
}

/** Client-sourced notifications, fields decoded via the schema. */
export function clientRoute(type: number, fields: Record<string, PbValue>): string | null {
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
		// is Steam's, fetched at startup; %p1% and the %mystuff% alias are the
		// only substitutions run here.
		case 5: {
			const appid = fields.appid;
			if (typeof appid !== 'number' || appid <= 0) return null;
			return openInClient(fillMyStuff(resolveUrl('SteamIDAchievementsPage', appid)));
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
		case 10:
			return openInClient(pendingInvitesUrl());

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
 * that mapping, with base URLs resolved from Steam's URL table and the user's
 * own pages addressed via identity.ts.
 *
 * Steam's registries mix addressing styles: gamenotifications and tradehistory
 * hang off `/my/`, trade offers off `/profiles/<id64>/`. Mirrored as-is; the
 * inconsistency is Valve's, do not "fix" it.
 */
export function serverRoute(n: ServerNotification): string | null {
	const community = resolveUrl('CommunityFrontPage');
	const store = resolveUrl('StoreFrontPage');
	const body = n.body ?? {};
	const my = myProfilePath();

	switch (n.type) {
		case 2: // Gift: ResolveURL("PendingGift")
			return openInClient(fillMyStuff(resolveUrl('PendingGift')));

		case 3: // Comment: community + rollup url
			return typeof n.url === 'string' && n.url && community ? openInClient(community + n.url) : null;

		case 4: // Item announcement: my inventory
			return community && my ? openInClient(`${community}${my}/inventory`) : null;

		case 5: // Friend invite: my pending invites page
			return openInClient(pendingInvitesUrl());

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
				return openInClient(`${store}wishlist/${my}/?wng=${appids.toString()}#sort=discount`);
			}
			const appid = typeof body.appid === 'number' ? `?appid=${body.appid}` : '';
			return openInClient(`${store}wishlist/${my}/${appid}#sort=discount`);
		}

		case 9: // Trade offer: my trade offers page
			return community && my ? openInClient(`${community}${my}/tradeoffers`) : null;

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
