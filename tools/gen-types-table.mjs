#!/usr/bin/env node
/**
 * Generate docs/notification-types.md: every notification type, what Steam's
 * own toast click does, and what this plugin emits for it.
 *
 * The type list and payload fields come from the vendored .proto. The prose
 * (what Steam's click does, and why) comes from reading Steam's shipped UI
 * bundle; docs/steam-routing.md records that analysis and is the source the
 * prose summarizes.
 *
 * The routed-or-not classification is NOT restated here: it is derived by
 * calling the real routing rules (frontend/routes.ts, compiled on the fly via
 * tsc) with synthesized payloads, and generation fails when a row's prose
 * disagrees with what the code does. The catalog once drifted three types from
 * routes.ts and published a wrong count; deriving makes that impossible.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrontendModules } from './load-frontend.mjs';
import { parseProto } from './proto.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { types, messages } = parseProto(
	readFileSync(join(root, 'vendor', 'steammessages_clientnotificationtypes.proto'), 'utf8'),
);

// --- the real routing rules, compiled out of the frontend ------------------

const { routes, urlstore, identity } = loadFrontendModules(['routes', 'urlstore', 'identity']);

// The templates a live client served, recorded in docs/steam-routing.md
// ("The URL store"), and a well-formed placeholder identity: enough for every
// rule that needs a base URL or a "my" page to produce its route.
urlstore.seedUrlTemplates({
	CommunityFrontPage: 'https://steamcommunity.com/',
	StoreFrontPage: 'https://store.steampowered.com/',
	HelpFrontPage: 'https://help.steampowered.com/en/',
	PendingGift: 'https://store.steampowered.com/gifts/',
	SteamIDAchievementsPage: 'https://steamcommunity.com/%mystuff%/stats/appid/%p1%/achievements/',
});
identity.setIdentity('76561197960287930');

// Synthesized payloads: for client types, per-field by name; for server types,
// the body_data fields each rule reads (docs/steam-routing.md, server catalog).
const SYNTH_FIELD = { appid: 570, steamid: '76561198000000000' };
const SYNTH_BODY = {
	6: { link: 'https://store.steampowered.com/sale/example/' },
	8: { appid: 1073390, count: 1 },
	10: { link: 'https://store.steampowered.com/news/' },
	11: { ticket: 123 },
	14: { msgid: 5 },
	16: { familyid: 9 },
	28: { appid: 1073390 },
};
const SYNTH_URL = { 3: 'id/example/recommended/1/#comment_2' };

function deriveRoute(type, entry) {
	if (entry.serverType != null) {
		return routes.serverRoute({
			type: entry.serverType,
			body: SYNTH_BODY[entry.serverType] ?? {},
			url: SYNTH_URL[entry.serverType],
		});
	}
	const message = messages[`CClientNotification${type.name}`] ?? {};
	const fields = {};
	for (const { name } of Object.values(message)) fields[name] = SYNTH_FIELD[name] ?? 1;
	return routes.clientRoute(type.index, fields);
}

/**
 * Steam's click action per type, from the UI bundle (docs/steam-routing.md
 * carries the citations), and the route this plugin emits for it.
 *
 *   steam       what Steam's own toast click does
 *   route       prose for the route column; 'none...' rows must derive null and
 *               every other row must derive a route, or generation fails
 *   observed    also clicked on a real, focused client
 *   serverType  ESteamNotificationType this client type arrives as: the toast
 *               is eSource=2 and routes through serverRoute, not clientRoute
 */
const CATALOG = {
	DownloadCompleted: { steam: 'library page for the game', route: '`steam://nav/games/details/<appid>`', observed: true },
	FriendInvite: { steam: 'client no-op; arrives as server FriendInvite instead', route: '`steam://openurl/` + pending invites page', serverType: 5 },
	FriendInGame: { steam: 'chat dialog with that friend', route: '`steam://friends/message/<steamid>`' },
	FriendOnline: { steam: 'chat dialog with that friend', route: '`steam://friends/message/<steamid>`', observed: true },
	Achievement: { steam: 'the game’s achievements page (URL store)', route: '`steam://openurl/` + resolved `SteamIDAchievementsPage`' },
	LowBattery: { steam: 'dismiss only', route: 'none' },
	SystemUpdate: { steam: 'Settings → System', route: '`steam://settings/system`' },
	FriendMessage: { steam: 'chat dialog with the sender', route: '`steam://friends/message/<steamid>`', observed: true },
	GroupChatMessage: { steam: 'that chat room’s dialog', route: 'none as a URL — the click bridge opens the room dialog (`chat_group_id` + `chat_id`)' },
	FriendInviteRollup: { steam: 'pending-invites dialog', route: '`steam://openurl/` + pending invites page' },
	FamilySharingStopPlaying: { steam: 'nothing', route: 'none' },
	Screenshot: { steam: 'that screenshot in the Media dialog', route: 'none as a URL — the click bridge opens that screenshot (`screenshot_handle`; the media grid without one)' },
	CloudSyncFailure: { steam: 'library page for the game', route: '`steam://nav/games/details/<appid>`' },
	CloudSyncConflict: { steam: 'library page for the game', route: '`steam://nav/games/details/<appid>`' },
	IncomingVoiceChat: { steam: 'chat dialog; does not accept the call', route: '`steam://friends/message/<steamid>`', observed: true },
	ClaimSteamDeckRewards: { steam: 'account page (renders only with a Deck)', route: 'none' },
	GiftReceived: { steam: 'client no-op; arrives as server Gift instead', route: '`steam://openurl/` + resolved `PendingGift`', serverType: 2 },
	ItemAnnouncement: { steam: 'client no-op; arrives as server Item instead', route: '`steam://openurl/` + my inventory', serverType: 4 },
	HardwareSurvey: { steam: 'survey modal', route: 'none' },
	LowDiskSpace: { steam: 'confirmation dialog, OK opens Settings → Storage', route: 'none' },
	BatteryTemperature: { steam: 'dismiss only', route: 'none' },
	DockUnsupportedFirmware: { steam: 'firmware modal', route: 'none' },
	PeerContentUpload: { steam: 'nothing (no component)', route: 'none' },
	CannotReadControllerGuideButton: { steam: 'info modal', route: 'none' },
	Comment: { steam: 'the commented page (server URL)', route: '`steam://openurl/` + community + notification url', serverType: 3 },
	Wishlist: { steam: 'wishlist or the app’s store page (server data)', route: '`steam://openurl/` + wishlist/store page', serverType: 8 },
	TradeOffer: { steam: 'your trade offers page', route: '`steam://openurl/` + trade offers page', serverType: 9 },
	AsyncGame: { steam: 'your game notifications page', route: '`steam://openurl/` + game notifications page', serverType: 12 },
	General: { steam: 'the link in the notification body', route: '`steam://openurl/` + body link', serverType: 10 },
	HelpRequest: { steam: 'that help ticket’s wizard page', route: '`steam://openurl/` + ticket page', serverType: 11 },
	OverlaySplashScreen: { steam: 'explicit no-op', route: 'none' },
	BroadcastAvailableToWatch: { steam: 'explicit no-op', route: 'none' },
	TimedTrialRemaining: { steam: 'explicit no-op', route: 'none' },
	LoginRefresh: { steam: 'explicit no-op', route: 'none' },
	MajorSale: { steam: 'the link in the notification body', route: '`steam://openurl/` + body link', serverType: 6 },
	TimerExpired: { steam: 'explicit no-op', route: 'none' },
	ModeratorMsg: { steam: 'that moderator message', route: '`steam://openurl/` + message page', serverType: 14 },
	SteamInputActionSetChanged: { steam: 'nothing', route: 'none' },
	RemoteClientConnection: { steam: 'nothing', route: 'none' },
	RemoteClientStartStream: { steam: 'nothing', route: 'none' },
	StreamingClientConnection: { steam: 'nothing', route: 'none' },
	FamilyInvite: { steam: 'family join page for that invite', route: '`steam://openurl/` + join page', serverType: 16 },
	PlaytimeWarning: { steam: 'playtime dialog', route: 'none as a URL — the click bridge opens the playtime request dialog' },
	FamilyPurchaseRequest: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', serverType: 17 },
	FamilyPurchaseRequestResponse: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', serverType: 19 },
	ParentalFeatureRequest: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', serverType: 15 },
	ParentalPlaytimeRequest: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', serverType: 18 },
	GameRecordingError: { steam: 'explicit no-op', route: 'none' },
	ParentalFeatureResponse: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', serverType: 20 },
	ParentalPlaytimeResponse: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', serverType: 21 },
	RequestedGameAdded: { steam: 'library page after a package→app lookup', route: 'none — lookup unavailable here', serverType: 22 },
	ClipDownloaded: { steam: 'that clip in the Media dialog', route: 'none — Media dialogs have no URL', serverType: 24 },
	GameRecordingStart: { steam: 'explicit no-op', route: 'none' },
	GameRecordingStop: { steam: 'that clip in the Media dialog', route: 'none as a URL — the click bridge opens that clip (`clip_id`; the media grid without one)' },
	GameRecordingUserMarkerAdded: { steam: 'explicit no-op', route: 'none' },
	GameRecordingInstantClip: { steam: 'that clip in the Media dialog', route: 'none as a URL — the click bridge opens that clip (`clip_id`; the media grid without one)' },
	PlaytestInvite: { steam: 'gated-access page for the app', route: '`steam://openurl/` + gated-access page', serverType: 28 },
	TradeReversal: { steam: 'your trade history page', route: '`steam://openurl/` + trade history', serverType: 29 },
	HardwareUpdateAvailable: { steam: 'Settings → Controller (desktop)', route: '`steam://settings/controller`' },
	ControllerLowBattery: { steam: 'dismiss only', route: 'none' },
	ControllerConnected: { steam: 'nothing', route: 'none' },
	ControllerDisconnected: { steam: 'nothing', route: 'none' },
};

let disagreements = 0;
const rows = types
	.filter((t) => t.name !== 'Invalid')
	.map((t) => {
		const entry = CATALOG[t.name];
		if (!entry) {
			console.error(`no catalog entry for ${t.name} (${t.index}) -- Steam added a type; re-read the bundle`);
			return { ...t, steam: 'UNKNOWN — not in catalog', route: 'none', routed: false, basis: '' };
		}
		const derived = deriveRoute(t, entry);
		const claims = !entry.route.startsWith('none');
		if (claims !== (derived !== null)) {
			disagreements += 1;
			console.error(
				`catalog disagrees with routes.ts for ${t.name} (${t.index}): ` +
					`prose says ${claims ? 'routes' : 'none'}, code derives ${derived ?? 'null'}`,
			);
		}
		const basis = [
			entry.serverType != null ? 'server' : 'client',
			entry.observed ? 'bundle + observed' : 'bundle',
		].join(', ');
		return { ...t, steam: entry.steam, route: entry.route, routed: derived !== null, basis };
	});

if (disagreements > 0) {
	console.error(`\n${disagreements} row(s) disagree; fix CATALOG or routes.ts, then re-run.`);
	process.exit(1);
}

const routed = rows.filter((r) => r.routed).length;
const inert = rows.filter((r) => /nothing|dismiss only|no-op/.test(r.steam)).length;

const doc = `<!-- GENERATED by tools/gen-types-table.mjs. Do not edit; run \`npm run gen:table\`. -->

# Notification types

Every value of \`EClientNotificationType\`: what Steam's own toast click does,
and what this plugin emits for it. The actions were read out of Steam's shipped
UI bundle; \`docs/steam-routing.md\` is the analysis this table summarizes,
with the citations. "observed" rows were additionally clicked on a real client
with a Steam window focused. The routed count is derived by running the actual
routing rules, not counted by hand.

- **${routed}** types route.
- **${inert}** types are inert in Steam itself: a click only dismisses, and so does ours.
- The remainder open dialogs no URL can reach. Five of them (the chat room,
  media items, the playtime dialog) act anyway: the click bridge opens the same
  dialog through Steam's own doors, on whichever surface is focused. The rest
  stay inert here too.
- "server" types arrive from the web notification system; their payload is
  \`body_data\` JSON on the toast's React object, not a client protobuf.

| # | Type | Steam's click does | We emit | Basis |
|---|---|---|---|---|
${rows.map((r) => `| ${r.index} | \`${r.name}\` | ${r.steam} | ${r.route} | ${r.basis} |`).join('\n')}
`;

mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'notification-types.md'), doc);
console.log(`generated docs/notification-types.md (${rows.length} types, ${routed} route)`);
