# Steam's own notification routing

What Steam does when a notification toast is clicked, read out of the shipped
UI bundle rather than guessed. Every route this plugin emits cites a row here.

Provenance: Steam client build 1787097529, file
`~/.local/share/Steam/steamui/chunk~2dcc5aaf7.js`
(sha256 begins `80c059c6ef881187`). Line references are into a beautified copy:
`npx js-beautify -f chunk~2dcc5aaf7.js -o chunk-main.pretty.js`. Minified
identifiers (module ids, `uM.QX`, …) change between Steam builds; the *shape* of
the code is what to re-find, and the strings quoted here are stable search keys.

## Architecture: two systems, keyed by `eSource`

The notification object Steam attaches to a toast's React tree carries
`eSource` (enum at module 60917: `k_Client = 1`, `k_Server = 2`).

- **Client notifications** (`eSource=1`) are the classic
  `EClientNotificationType` protobuf events. `data` is a decoded Closure
  message (values in `data.array`).
- **Server notifications** (`eSource=2`) are the web system from
  `steammessages_notifications.steamclient.proto`, added client-side in the
  June 2023 update. `data` is a rollup object:
  `{ type, item, rgunread, rgread, timestamp, url? }` where
  `item.body_data` is a JSON string. These arrive mapped onto a client
  `eType` via a 23-entry table (module 60917, `Z = new Map([...])`, line
  ~405835): Gift→GiftReceived, Item→ItemAnnouncement, FriendInvite→FriendInvite,
  Wishlist→Wishlist, TradeOffer→TradeOffer, AsyncGame→AsyncGame,
  General→General, Comment→Comment, HelpRequest→HelpRequest,
  MajorSale→MajorSale, ModeratorMsg→ModeratorMsg, and the family/parental,
  RequestedGameAdded, ClipDownloaded, PlaytestInvite, TradeReversal types.
  The client types GiftReceived(19), ItemAnnouncement(20) and FriendInvite(2)
  are explicitly no-ops when they arrive from the client ("This is a no-op due
  to overlap with Steam Notifications", module 60917 `OnNotification`).

There is **no single resolver field**. `fnNotificationResolved` is a dismissal
predicate: the toast animation loop polls it each frame and fades the toast out
when it returns true (module 48197, `t.m_notification.fnNotificationResolved()`
in the `Showing` state). It never routes anything.

Routing lives in the per-type React components of module 11374 (`Ke`, exported
`Tm`, a switch over `eType` — the master dispatch), whose `onActivate`
callbacks bottom out in a small vocabulary:

| primitive | what it is |
|---|---|
| `ShowFriendChatDialog(ctx, steamid)` | FriendsUI chat dialog (module 87913 `LN`) |
| `ShowChatRoomGroupDialog(ctx, group, chat)` | FriendsUI group chat dialog |
| `ShowInvitesDialog(ctx)` | FriendsUI pending-invites dialog |
| `nav.App(appid)` | router push `Library.App.Root(appid)` (module 874) |
| `nav.Media.Screenshot/Clip({id})` | Media named dialog |
| `nav.Settings("Page")` | Settings dialog on that page |
| `navToUrl(B7.ResolveURL(name, …))` | URL store template → SteamWeb |
| `SteamWeb(url)` | `location.href = url` if `steam://`, else `location.href = "steam://openurl/" + url` (module 79112, fn `m`) |
| nothing | click only dismisses |

## The URL store

`CURLStore` (module 87935, `B7`) fetches ~130 named URL templates from
`SteamClient.URL.GetSteamURLList([...names])` at startup;
`ResolveURL(name, ...params)` substitutes `%p1%`, `%p2%`… into the template.
All community/store/help base URLs Steam uses come from it
(`CommunityFrontPage`, `StoreFrontPage`, `HelpFrontPage`).

The `steam://url/<Name>/<params>` protocol handler (module 89748, entry
`["url", ...]`) does exactly `B7.ResolveURL(name, ...params)` then
`navigate.SteamWeb(resolved)` — so a `steam://url/` route is resolved by
Steam's own table at click time. `steam://openurl/<url>` goes straight to
`SteamWeb`. `SteamClient.URL.GetSteamURLList` is callable from this plugin's
frontend, which is how capture-time resolution stays Steam's own data.

Templates observed live on this machine (2026-08-27):
`CommunityFrontPage=https://steamcommunity.com/`,
`StoreFrontPage=https://store.steampowered.com/`,
`HelpFrontPage=https://help.steampowered.com/en/`,
`PendingGift=https://store.steampowered.com/gifts/`,
`SteamIDAchievementsPage=https://steamcommunity.com/%mystuff%/stats/appid/%p1%/achievements/`.
The `%mystuff%` placeholder is not `%pN%`-substituted and appears nowhere in
the steamui JS or the client binaries; it resolves in the logged-in client.
From outside, `profiles/<steamid64>` is the same prefix — verified:
`profiles/<id64>/stats/appid/<appid>/achievements/` 302s to the canonical
achievements page (`/id/<vanity>/stats/<game>?tab=achievements`, 200). The
plugin substitutes it that way.

## Delivery equivalences this plugin relies on

| our route | Steam's handler | why it is the same action |
|---|---|---|
| `steam://friends/message/<steamid64>` | FriendsUI `RegisterForSteamURLs` (line ~29213): `ExecuteCommand({command: "ShowFriendChatDialog", steamid, btakefocus: !0})` | identical command to the components' `Ye(steamid)` activate; also takes focus |
| `steam://nav/games/details/<appid>` | protocol entry `["open/library","open/games","nav/games"]` → library nav | same end state as `nav.App(appid)`; verified by clicking Steam's DownloadCompleted toast |
| `steam://settings/<token>` | desktop protocol entry `["settings","open/settings"]` → token map `Ga` (line ~505025: `system: "System"`, `controller: "Controller"`, …) → same settings opener the components call | |
| `steam://openurl/<https url>` | protocol entry `["openurl", ...]` → `SteamWeb` | literally the code `SteamWeb` itself emits for non-steam URLs |
| `steam://url/<Name>/<params>` | protocol entry `["url", ...]` → `ResolveURL` + `SteamWeb` | the components' `bG(name, ...params)` helper is `SteamWeb(ResolveURL(name, ...params))` (module 18057 `m`/`b`) |

## Focus

Only the chat family raises a window: `friends/message` / `friends/joinchat`
hardcode `btakefocus: !0` into the `ShowFriendChatDialog` command
(→ `k_EWindowBringToFrontAndForceOS` in FriendsUI). Every other desktop
handler — `nav`, `openurl`, `url`, `settings`, the whole protocol table and
its dispatcher — contains no `BringToFront`; the one raise-on-navigate in the
codebase is the *gamepad* navigator's `beforeNavigate`, guarded by "no window
focused". Steam's desktop code never needed focus because its toasts are only
clickable while Steam is already focused.

`steam://open/main` is not handled by the current client (tested: no effect).
The window-manager-agnostic raise is the launcher-activation path: an argless
`steam` invocation while the client runs makes it show and focus its main
window itself (tested: focus moved to Steam). The wrapper translates the bare
launch into `steam -foreground` for the running instance — console_log shows
`ExecCommandLine: ... '-foreground'` — so the mechanism is Steam's own named
bring-to-front command. `tools/notify-action` sequences it before non-chat
routes, on click only; a clicked test toast produced `-foreground` followed one
second later by the route.

## Catalog: client-sourced types (`eSource=1`)

"component" names are the module 11374 functions in the beautified dump.

| # | type | Steam's click (component) | our route |
|---|---|---|---|
| 1 | DownloadCompleted | `nav.App(appid)` (`lt`) | `steam://nav/games/details/<appid>` |
| 2 | FriendInvite | client no-op (overlap list `K`) | — (never toasts from client) |
| 3 | FriendInGame | `ShowFriendChatDialog(steamid)` (`pt`) | `steam://friends/message/<steamid>` |
| 4 | FriendOnline | `ShowFriendChatDialog(steamid)` (`At`; also observed) | `steam://friends/message/<steamid>` |
| 5 | Achievement | `SteamWeb(ResolveURL("SteamIDAchievementsPage", appid))` (`ht`) | `steam://openurl/` + resolved template |
| 6 | LowBattery | dismiss only (`bt`) | none |
| 7 | SystemUpdate | `Settings("System")` (`vt`) | `steam://settings/system` |
| 8 | FriendMessage | `ShowFriendChatDialog(steamid)` (`Rt`; observed). `response_steamurl`, when non-empty, backs only the tray options button and the gamepad "Accept" menu via `OpenURLInClient` — not the desktop body click | `steam://friends/message/<steamid>` |
| 9 | GroupChatMessage | `ShowChatRoomGroupDialog(chat_group_id, chat_id)` (`Tt`) | none — no `steam://` entry point reaches that dialog (FriendsUI registers only `friends/message` and `friends/joinchat`, both steamid-keyed). Routing to the sender's 1:1 chat would be a different action, so it was removed |
| 10 | FriendInviteRollup | `ShowInvitesDialog` (`jt`) | `steam://openurl/<community>profiles/<me64>/friends/pending` — the same destination Steam's *server* FriendInvite component (`Kt`) navigates to on desktop; the dialog itself has no URL |
| 12 | FamilySharingStopPlaying | none (`kt`) | none |
| 14 | Screenshot | `nav.Media.Screenshot({id})` (`ot`) | none — Media item dialogs have no URL; `steam://open/screenshots` is registered for the gamepad UI mode only |
| 15 | CloudSyncFailure | `nav.App(appid)` (`ct`) | `steam://nav/games/details/<appid>` |
| 16 | CloudSyncConflict | `nav.App(appid)` (`dt`) | `steam://nav/games/details/<appid>` |
| 17 | IncomingVoiceChat | desktop: `ShowFriendChatDialog(steamid)` (`gt`; observed — opens chat, does not accept) | `steam://friends/message/<steamid>` |
| 18 | ClaimSteamDeckRewards | `nav.Account()` (`Dt`; renders only with a Deck controller present) | none |
| 21 | HardwareSurvey | survey modal (`Ft`) | none |
| 22 | LowDiskSpace | confirmation dialog whose OK opens `Settings("Storage")` (`St` → module 5187 `me`) | none (dialog-mediated) |
| 23 | BatteryTemperature | dismiss only (`Lt`) | none |
| 24 | DockUnsupportedFirmware | firmware modal (`Nt`) | none |
| 25 | PeerContentUpload | dispatcher returns null | none |
| 26 | CannotReadControllerGuideButton | info modal (`Ot`) | none |
| 33 | OverlaySplashScreen | explicit no-op `() => {}` (`Et`) | none |
| 34 | BroadcastAvailableToWatch | explicit no-op (`Gt`) | none |
| 35 | TimedTrialRemaining | explicit no-op (`zt`) | none |
| 36 | LoginRefresh | explicit no-op (`Wt`) | none |
| 38 | TimerExpired | explicit no-op (`Ut`) | none |
| 40 | SteamInputActionSetChanged | none (`Jt`) | none |
| 41–43 | RemoteClient*/StreamingClient | none (`$t`,`er`,`tr`) | none |
| 45 | PlaytimeWarning | `RequestPlaytimeDialog` (`Yt`) | none |
| 50,55,57 | GameRecording error/start/marker | explicit no-op (`rr`,`ar`,`ir`) | none |
| 56,58 | GameRecordingStop/InstantClip | `nav.Media.Clip({clip_id})` (`or`,`lr`) | none (no URL for Media dialogs) |
| 61 | HardwareUpdateAvailable | desktop: `Settings("Controller")`, gamepad: `Settings("System")` (`It`) | `steam://settings/controller` |
| 62 | ControllerLowBattery | dismiss only (`yt`) | none |
| 63,64 | ControllerConnected/Disconnected | none (`Bt`,`wt`) | none |
| 19,20 | GiftReceived, ItemAnnouncement | client no-op (overlap list `K`) | — (handled as server types) |

## Catalog: server-sourced types (`eSource=2`)

Steam's mapping here *is* data-driven: type-keyed registries in module 655
(`v` for link-carrying types, `x` for family/parental) plus the `pr` component
map in module 11374, each producing an https URL from `item.body_data` (JSON)
and navigating with `SteamWeb`. Clicking also marks the item read
(`Xe` → `MarkItemRead`), which this plugin does not replicate.

| server type | Steam's URL (source) | body fields used |
|---|---|---|
| 2 Gift | `ResolveURL("PendingGift")` (`pr[K]`) | — |
| 3 Comment | community + rollup `data.url` (`pr[v_]`) | rollup `url` |
| 4 Item | community + `profiles/<me64>/inventory` (`pr[hW]`) | — |
| 5 FriendInvite | community + `profiles/<me64>/friends/pending` (`Kt`, desktop) | — |
| 6 MajorSale | `body.link` (registry `v`) | `link` |
| 8 Wishlist | >1 apps: store + `wishlist/profiles/<me64>/?wng=<appids>#sort=discount`; else app store page, falling back to store + `wishlist/profiles/<me64>/?appid=<appid>#sort=discount` (`pr[XJ]`) | `count`, `appid`, `appids` |
| 9 TradeOffer | community + `profiles/<me64>/tradeoffers` (`pr[an]`) | — |
| 10 General | `body.link` (registry `v`) | `link` |
| 11 HelpRequest | help + `wizard/HelpRequest/<ticket>` (registry `v`) | `ticket` |
| 12 AsyncGame | community + `my/gamenotifications/` (`pr[Y9]`) | — |
| 14 ModeratorMsg | community + `my/moderatormessages/<msgid>` (registry `v`) | `msgid` |
| 15–21 family/parental | store + `account/familymanagement?tab=requests` (registry `x`); FamilyInvite: store + `account/familymanagement/join?invitation=<familyid>` | `familyid` |
| 22 RequestedGameAdded | `nav.App()` after a package→app lookup (`qt`) | none we can reach — not routed |
| 23 ClipDownloaded | `nav.Media.Clip({clip_id})` (`nr`) | not routed (no URL) |
| 28 PlaytestInvite | store + `account/gatedaccess?appid=<appid>` (registry `v`) | `appid` |
| 29 TradeReversal | community + `my/tradehistory` (`Vt`) | — |

`<me64>` is the current user's steamid64; the backend reads it from
`loginusers.vdf` (`MostRecent "1"`). Base URLs come from
`SteamClient.URL.GetSteamURLList` at plugin startup — the same source Steam's
own `TS.COMMUNITY_BASE_URL` / `STORE_BASE_URL` / `HELP_BASE_URL` are filled
from.

## Test harness

`window.NotificationStore` is a global in Steam's shared JS context (module
60917 ends with `window.NotificationStore = ne`). Its store carries per-type
test methods that synthesize a real protobuf and run the full toast pipeline:
`TestDownloadComplete(appid)`, `TestFriendOnline()`, `TestFriendIngame(name)`,
`TestFriendMessage(steamid|null, text)`, `TestIncomingVoiceChat()`,
`TestAchievement(appid)`, `TestSystemUpdate(type)`, `TestFriendInviteRollup(n)`,
`TestCloudSyncConflict(appid)`, `TestCloudSyncFailure(appid)`, and more
(search `strTest:` in the registry). This removes the "needs another person"
constraint for client-type capture testing. Server-type test methods exist
(`TestWishlist`, `TestComment`, …) but funnel into `Dev_AddTestNotification`,
which is an empty function in the shipped build — server types still need a
real event.

`tools/fire` writes a command file the plugin's debug poll picks up, so a test
toast can be fired from the shell while Steam runs.

A fired test can still be swallowed by the type's own gating, silently: the
test methods call `OnNotification`, which applies the same suppression real
notifications get. Known case: SystemUpdate (`BSkipSystemUpdateNotification`,
state held in memory until restart) — the same update type repeats at most
once a week, and type 1 ("update available") after a type 2 ("restart
required") is suppressed unconditionally, since a restart notice supersedes an
availability notice. Both verified by firing. When a fire produces a
`dev-fire:` log line but no `from-toast` line, suspect this class of gate, not
the pipeline.

## Answers to the questions this analysis started from

1. **A field or resolver?** No single one. `fnNotificationResolved` is toast
   dismissal. The general mapping is the dispatch in module 11374 plus the
   server registries in module 655; the server half is genuinely data-driven
   (`link(body_data)` → URL), the client half is per-type code over a small
   navigation vocabulary.
2. **Can `steam://` be invoked from inside the notification?** Effectively
   yes: every web-bound click Steam performs already goes through
   `steam://openurl/` (that is what `SteamWeb` emits), and `steam://url/<Name>`
   resolves through the same `SteamClient.URL` table the components use. This
   plugin resolves templates at capture time and delivers `steam://openurl/`.
3. **Do the types group?** Yes, but the real split is client-handled vs
   server-webbed, then by activate primitive: chat-dialog types, library-nav
   types, URL types, settings types, modal types, and inert types. The
   person/game/store/account intuition maps onto those, but Steam's own axis is
   the vocabulary above.
