#!/usr/bin/env node
/**
 * Generate docs/notification-types.md: every notification type, what Steam's
 * own toast click does, and what this plugin emits for it.
 *
 * The type list and payload fields come from the vendored .proto. The click
 * actions come from reading Steam's shipped UI bundle; docs/steam-routing.md
 * records that analysis (module references, provenance, equivalences) and is
 * the source this table summarizes. Rows marked "observed" were additionally
 * clicked on a real client with a Steam window focused.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProto } from './proto.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { types } = parseProto(
	readFileSync(join(root, 'vendor', 'steammessages_clientnotificationtypes.proto'), 'utf8'),
);

/**
 * Steam's click action per type, from the UI bundle (docs/steam-routing.md
 * carries the citations), and the route this plugin emits for it.
 *
 *   steam   what Steam's own toast click does
 *   route   what tools/notify-action runs on click, or none
 *   observed  also clicked on a real, focused client
 */
const CATALOG = {
	DownloadCompleted: { steam: 'library page for the game', route: '`steam://nav/games/details/<appid>`', observed: true },
	FriendInvite: { steam: 'client no-op; arrives as server FriendInvite instead', route: 'via server type' },
	FriendInGame: { steam: 'chat dialog with that friend', route: '`steam://friends/message/<steamid>`' },
	FriendOnline: { steam: 'chat dialog with that friend', route: '`steam://friends/message/<steamid>`', observed: true },
	Achievement: { steam: 'the game’s achievements page (URL store)', route: '`steam://openurl/` + resolved `SteamIDAchievementsPage`' },
	LowBattery: { steam: 'dismiss only', route: 'none' },
	SystemUpdate: { steam: 'Settings → System', route: '`steam://settings/system`' },
	FriendMessage: { steam: 'chat dialog with the sender', route: '`steam://friends/message/<steamid>`', observed: true },
	GroupChatMessage: { steam: 'that chat room’s dialog', route: 'none — no steam:// entry point reaches the room dialog' },
	FriendInviteRollup: { steam: 'pending-invites dialog', route: '`steam://openurl/` + pending invites page' },
	FamilySharingStopPlaying: { steam: 'nothing', route: 'none' },
	Screenshot: { steam: 'that screenshot in the Media dialog', route: 'none — Media dialogs have no URL' },
	CloudSyncFailure: { steam: 'library page for the game', route: '`steam://nav/games/details/<appid>`' },
	CloudSyncConflict: { steam: 'library page for the game', route: '`steam://nav/games/details/<appid>`' },
	IncomingVoiceChat: { steam: 'chat dialog; does not accept the call', route: '`steam://friends/message/<steamid>`', observed: true },
	ClaimSteamDeckRewards: { steam: 'account page (renders only with a Deck)', route: 'none' },
	GiftReceived: { steam: 'client no-op; arrives as server Gift instead', route: 'via server type' },
	ItemAnnouncement: { steam: 'client no-op; arrives as server Item instead', route: 'via server type' },
	HardwareSurvey: { steam: 'survey modal', route: 'none' },
	LowDiskSpace: { steam: 'confirmation dialog, OK opens Settings → Storage', route: 'none' },
	BatteryTemperature: { steam: 'dismiss only', route: 'none' },
	DockUnsupportedFirmware: { steam: 'firmware modal', route: 'none' },
	PeerContentUpload: { steam: 'nothing (no component)', route: 'none' },
	CannotReadControllerGuideButton: { steam: 'info modal', route: 'none' },
	Comment: { steam: 'the commented page (server URL)', route: '`steam://openurl/` + community + notification url', server: true },
	Wishlist: { steam: 'wishlist or the app’s store page (server data)', route: '`steam://openurl/` + wishlist/store page', server: true },
	TradeOffer: { steam: 'your trade offers page', route: '`steam://openurl/` + trade offers page', server: true },
	AsyncGame: { steam: 'your game notifications page', route: '`steam://openurl/` + game notifications page', server: true },
	General: { steam: 'the link in the notification body', route: '`steam://openurl/` + body link', server: true },
	HelpRequest: { steam: 'that help ticket’s wizard page', route: '`steam://openurl/` + ticket page', server: true },
	OverlaySplashScreen: { steam: 'explicit no-op', route: 'none' },
	BroadcastAvailableToWatch: { steam: 'explicit no-op', route: 'none' },
	TimedTrialRemaining: { steam: 'explicit no-op', route: 'none' },
	LoginRefresh: { steam: 'explicit no-op', route: 'none' },
	MajorSale: { steam: 'the link in the notification body', route: '`steam://openurl/` + body link', server: true },
	TimerExpired: { steam: 'explicit no-op', route: 'none' },
	ModeratorMsg: { steam: 'that moderator message', route: '`steam://openurl/` + message page', server: true },
	SteamInputActionSetChanged: { steam: 'nothing', route: 'none' },
	RemoteClientConnection: { steam: 'nothing', route: 'none' },
	RemoteClientStartStream: { steam: 'nothing', route: 'none' },
	StreamingClientConnection: { steam: 'nothing', route: 'none' },
	FamilyInvite: { steam: 'family join page for that invite', route: '`steam://openurl/` + join page', server: true },
	PlaytimeWarning: { steam: 'playtime dialog', route: 'none' },
	FamilyPurchaseRequest: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', server: true },
	FamilyPurchaseRequestResponse: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', server: true },
	ParentalFeatureRequest: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', server: true },
	ParentalPlaytimeRequest: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', server: true },
	GameRecordingError: { steam: 'explicit no-op', route: 'none' },
	ParentalFeatureResponse: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', server: true },
	ParentalPlaytimeResponse: { steam: 'family management, requests tab', route: '`steam://openurl/` + requests tab', server: true },
	RequestedGameAdded: { steam: 'library page after a package→app lookup', route: 'none — lookup unavailable here', server: true },
	ClipDownloaded: { steam: 'that clip in the Media dialog', route: 'none — Media dialogs have no URL', server: true },
	GameRecordingStart: { steam: 'explicit no-op', route: 'none' },
	GameRecordingStop: { steam: 'that clip in the Media dialog', route: 'none — Media dialogs have no URL' },
	GameRecordingUserMarkerAdded: { steam: 'explicit no-op', route: 'none' },
	GameRecordingInstantClip: { steam: 'that clip in the Media dialog', route: 'none — Media dialogs have no URL' },
	PlaytestInvite: { steam: 'gated-access page for the app', route: '`steam://openurl/` + gated-access page', server: true },
	TradeReversal: { steam: 'your trade history page', route: '`steam://openurl/` + trade history', server: true },
	HardwareUpdateAvailable: { steam: 'Settings → Controller (desktop)', route: '`steam://settings/controller`' },
	ControllerLowBattery: { steam: 'dismiss only', route: 'none' },
	ControllerConnected: { steam: 'nothing', route: 'none' },
	ControllerDisconnected: { steam: 'nothing', route: 'none' },
};

const rows = types
	.filter((t) => t.name !== 'Invalid')
	.map((t) => {
		const entry = CATALOG[t.name];
		if (!entry) {
			console.error(`no catalog entry for ${t.name} (${t.index}) -- Steam added a type; re-read the bundle`);
			return { ...t, steam: 'UNKNOWN — not in catalog', route: 'none', basis: '' };
		}
		const basis = [
			entry.server ? 'server' : 'client',
			entry.observed ? 'bundle + observed' : 'bundle',
		].join(', ');
		return { ...t, steam: entry.steam, route: entry.route, basis };
	});

const routed = rows.filter((r) => !r.route.startsWith('none') && r.route !== 'via server type').length;
const inert = rows.filter((r) => /nothing|dismiss only|no-op/.test(r.steam)).length;

const doc = `<!-- GENERATED by tools/gen-types-table.mjs. Do not edit; run \`npm run gen:table\`. -->

# Notification types

Every value of \`EClientNotificationType\`: what Steam's own toast click does,
and what this plugin emits for it. The actions were read out of Steam's shipped
UI bundle; \`docs/steam-routing.md\` is the analysis this table summarizes,
with the citations. "observed" rows were additionally clicked on a real client
with a Steam window focused.

- **${routed}** types route.
- **${inert}** types are inert in Steam itself: a click only dismisses, and so does ours.
- The remainder open dialogs no URL can reach, so their clicks stay inert here.
- "server" types arrive from the web notification system; their payload is
  \`body_data\` JSON on the toast's React object, not a client protobuf.

| # | Type | Steam's click does | We emit | Basis |
|---|---|---|---|---|
${rows.map((r) => `| ${r.index} | \`${r.name}\` | ${r.steam} | ${r.route} | ${r.basis} |`).join('\n')}
`;

mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'notification-types.md'), doc);
console.log(`generated docs/notification-types.md (${rows.length} types)`);
