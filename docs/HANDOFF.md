# Handoff

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon. Capture, artwork, delivery, routing, and the
click path all work, on every surface. Routing is built on Steam's own click
logic, read out of the shipped UI bundle: 31 of 62 types route as URLs, five
more open Steam's own dialogs through the click bridge, and the rest are inert
in Steam itself. Every type whose Steam click acts has a working mirror
in-game, on the desktop with a game running unfocused, from the tray, and with
no game at all — verified live in Helldivers 2 (2026-08-29). The short list of
what remains is at the end of this file.

Read `docs/notification-types.md` for the per-type table and
`docs/steam-routing.md` for the bundle analysis every route cites. This file is
the working context that is not obvious from the code.

## Architecture

```
frontend/index.tsx        popup lifecycle: hook, wait for paint, deliver once
frontend/notification.ts  React tree -> typed notification (discriminated union)
frontend/routes.ts        the routing catalog; every rule cites steam-routing.md
frontend/urlstore.ts      Steam's URL templates via SteamClient.URL.GetSteamURLList
frontend/identity.ts      the signed-in steamid64, loaded once from the backend
frontend/overlay.ts       the surface doors: overlay web pages and dialogs, chat
                          rooms, media items, the playtime dialog, live focus
frontend/clickbridge.ts   consumes the click file; picks the surface by focus
frontend/log.ts           dlog/safeJson; its prefixes are tools/capture's grep contract
frontend/devfire.ts       the tools/fire door, gated on a setting, off by default
frontend/Settings.tsx     the settings panel; settings.ts persists ONE JSON document
backend/main.lua          a pure marshaller: JSON in, spawn tools/notify-action
tools/notify-action       markup escaping, icon resolution, notify-send; a click
                          writes the click file
```

Markup escaping lives in `tools/notify-action`, next to the `notify-send` that
renders it, not in the backend. The backend never learns a setting's name; it
stores the settings document opaquely.

`tools/capture` greps for the prefixes `hook installed`, `url templates:`,
`identity:`, `from-toast `, `toast <name> -> ` and `dev-fire`. Renaming a log
prefix without updating tools/capture blinds the triage tool. The lines live
in `~/.cache/steam-native-notify/plugin.log`, truncated at each backend load:
Millennium keeps a packed (.star) plugin's logger output in an in-memory
buffer and never writes it to Steam's console-linux.txt, so backend/main.lua
mirrors every line there itself. Steam's log still carries Millennium's
loader lines (capture's freshness stamp). The click path adds its own
`click-bridge:` and `overlay:` lines; the table is under "The click
architecture" below.

## The click architecture

The pieces landed separately; this is the whole, end to end.

**Steam picks the surface at toast time; the click re-picks at click time.**
Steam renders each toast in the surface the user occupies: overlay-context
popups are named `notificationtoasts_uid<appid>-...`, desktop ones
`notificationtoasts_<N>_desktop`. Both are CEF popups, captured identically.
Steam's own click follows the same placement (observed 2026-08-29: a
desktop-context click opens the client window even while a game runs
unfocused, and overlay-context clicks all stay in the overlay). But placement
can lag a focus change on this compositor, so the bridge trusts live focus at
click time, not the toast's context.

**The payload carries five fields**: `title`, `body`, `image`, `route`,
`ingame`. `route` is the steam:// URL from routes.ts, null when Steam's own
click has none. `ingame` is an action token (`clientOverlayAction` in
routes.ts) for the types whose click opens a dialog no URL reaches:
`chatroom:<group>:<chat>` for GroupChatMessage (9), `screenshot:<handle>`
falling back to `media` for Screenshot (14), `requestplaytime` for
PlaytimeWarning (45), and `clip:<clip_id>` falling back to `media` for
GameRecordingStop/InstantClip (56, 58).

**Every click rides the click file.** On a click, notify-action writes
`<epoch-seconds>|<route-or-action:token>` to
`~/.cache/steam-native-notify/.click`. No external `steam` invocation
remains: an external URL cannot pick the surface, because the client's
handlers choose the overlay whenever a game is merely RUNNING and raise the
main window over a focused game. The accepted loss is a click landing after
Steam has fully quit, which the old external path could serve by booting the
client; the popup only survives ~8s on this daemon, so that window is
documented rather than kept. The epoch stamp exists because the bridge only
polls while armed: a click written after the disarm would sit in the file and
fire as a surprise on the NEXT arm, so the bridge drops anything older than
30s (or unstamped), with a log line.

**The bridge consumes it.** clickbridge.ts polls the file every 1s for 120s
after each delivery (an idle session polls nothing) and picks the surface by
LIVE focus, from the client's own signal
(`SteamClient.System.UI.RegisterForOverlayGameWindowFocusChanged`):

- **Focused game**: the overlay doors, aimed at that appid.
- **Otherwise**: the desktop doors. The main window is raised (its own
  popup's `SteamClient.Window.BringToFront`) or, when closed to the tray,
  created first (`ExecuteSteamURL("steam://open/main")` plus a settle delay);
  then the route runs through the client's URL executor, or the action token
  through the same doors retargeted at the desktop instance (appid 0).
- **Chat picks its surface explicitly on both sides**: the ingestion's
  "chat" case with `steamidTarget` opens the overlay chat for the focused
  game; the same case with appid 0 resolves the desktop instance (a game
  running unfocused would otherwise get an invisible overlay chat); with no
  game at all, the plain `steam://friends/message/` URL is the proven door.

**The doors (frontend/overlay.ts), each mirroring an observed Steam click:**

- The activate-overlay ingestion, for web pages (`bWebPage`) and named
  dialogs. `"settings"` is hard-wired to `Settings("System")`, where Steam's
  own in-game clicks land for BOTH SystemUpdate and HardwareUpdate.
- The ingestion's `"chat"` case with `steamidTarget` for 1:1 chat; appid 0 is
  the desktop instance.
- The FriendsUI dispatcher's `ShowChatRoomGroupDialog(browserInfo,
  chat_group_id, chat_id)` for group rooms, keyed on a per-surface
  browserInfo stashed from each toast's React tree at capture time (a
  provider above the notification fiber; the popup object does not carry it).
  No stash, no door: the dispatcher dereferences the context's `m_unPID`
  unconditionally.
- The navigator doors, via the store's `GetNavigator({unRequestingAppID})`:
  `Media.Screenshot({state:{id}})`, `Media.Clip({state:{id}})`,
  `Media.Grid()`, `RequestPlaytimeDialog("manual")`.

Provenance for all of them: `docs/steam-routing.md`, "The overlay and the
surface doors".

**The `nativeToastInGame` setting** (ships off; "Keep Steam's own toasts
while in a game"): an overlay-context toast is left to Steam — nothing is
sent to the desktop and Steam's popup is not closed, whatever
`hideSteamToast` says. Desktop-context toasts are unaffected, so a game
running unfocused still notifies the desktop. Capture and logging still run,
and the bridge is still armed (an earlier desktop notification may be waiting
for its click).

### Log vocabulary

All in `~/.cache/steam-native-notify/plugin.log`:

| line | meaning |
|---|---|
| `from-toast <name> type=N (...)` | extraction worked; the fields follow |
| `toast <name> -> {...}` | delivered; the JSON carries `route` and `ingame` |
| `toast <name> -> {...} (suppressed: native in-game)` | overlay-context toast left to Steam (`nativeToastInGame` on); nothing sent |
| `click-bridge: <payload>` | a click was consumed from the file |
| `click-bridge: stale click dropped (Ns old): <route>` | consumed but older than 30s; not opened |
| `click-bridge: unstamped click dropped: ...` | consumed but missing its epoch stamp; not opened |
| `click-bridge: desktop <route>` | desktop surface chosen; navigating |
| `click-bridge: main window closed; opening it` | tray-only; creating the window first |
| `overlay: open appid=N ...` | activate-overlay ingestion door |
| `overlay: chat room appid=N group=G chat=C` | room dialog door |
| `overlay: screenshot / clip / media / playtime dialog appid=N` | navigator doors |
| `overlay: toast context stashed (desktop\|overlay)` | browserInfo captured for the room door |
| `click-bridge: overlay door failed` / `desktop door failed` | a door found no store or navigator |
| `overlay: chat room appid=N has no stashed toast context` | room door refused: no toast seen on that surface yet |

Every consumed click logs `click-bridge:`; a consumed click with no line after
it was the double-parse bug, fixed in c07c4d1.

### Known and accepted limits

- Two simultaneous games: the bridge targets the first overlay.
- A click after Steam has fully quit does nothing (see above).
- Clicks beyond the 120s arm window are never opened: written after the
  disarm, they sit in the file until the next arm and are then dropped as
  stale.
- Steam updates reshuffle the minified surfaces the doors hold: the
  activate-overlay store, `GetNavigator`, the FriendsUI dispatcher, the
  browserInfo provider shape, `m_mapPopups`, `GetOverlayBrowserInfo`. The
  `steam-update-smoke` skill's bridge smoke is the check.
- The popup is the whole click window: quickshell 1.2 expires it after ~8s
  despite `-t 0` and the action dies with it (the notification-centre copy is
  inert). Orthogonal to routing, but it bounds how a click can ever be tested
  or used here.

## Working on this: read before touching anything

These cost hours to learn. Ignoring them will cost them again.

**A full Steam restart is required for ANY change, backend included.** Under
the packed .star format, `plugin.restart` and disable/enable leave the backend
STOPPED: the new backend logs "backend loaded" then "backend unloaded"
immediately, `plugin.status` reports `running: false`, and dev fires queue
unconsumed (observed 2026-08-29). The frontend half was already unreloadable
("Delegating frontend load" logs and does not execute). Use:

```sh
steam -shutdown && sleep 15 && setsid uwsm-app -- gtk-launch steam.desktop
```

`steam -shutdown` returns before the shutdown finishes, and a launch attempted
while the old instance is still up is silently swallowed (it pings the dying
instance and exits). If Steam is not running after the sleep, run the launch
again; it happened twice in one session here.

**Always confirm the running bundle is the one on disk.** `tools/capture`
reports this first, because a stale bundle looks exactly like a broken feature.

**A green build proves very little.** Five runtime failures in this project's
history were undefined names or nil globals that the bundler emitted happily:
two `PLUGIN_DIR` bugs, `toBase64`, `notificationFromToast`, and a
`JSON.stringify` on a BigInt inside a debug log. `bun run build` type-checks
now; `bun run test` runs `tools/test-backend` (the Lua backend and the
notify-action seams, with Millennium stubbed) and `tools/test-routes` (offline
checks that lock the exact route URL for every routed type, plus decode
fixtures and url/identity validation). Run all of it, then confirm behaviour
in the running client.

**Never let a diagnostic throw.** A debug log that called `JSON.stringify` on a
BigInt killed every notification silently. `dlog` and `safeJson` are defensive
for that reason; keep them that way.

**Millennium's callable quirks.** Pass exactly ONE argument, a JSON string: key
order is not preserved onto Lua parameter names, and two keys arrived swapped.
A callable's return value comes back JSON-encoded, so a Lua string arrives
wrapped in literal quote characters.

**`bun run gen:table` is a check, not just a generator.** The table's route
column is derived by running the real routing rules; generation fails when the
prose and the code disagree. The catalog once drifted three types from
routes.ts and published a wrong count.

## Testing methodology, which is easy to get wrong

**A Steam toast is only clickable while a Steam window has focus.** Unfocused
it takes no click at all: no cursor change, no highlight. Every "Steam's toast
does nothing" observation taken unfocused is meaningless, and three wrong
conclusions in this project came from exactly that.

**Watch the client while clicking.** A `steam://nav/...` route changes the page
inside the existing window. If you are not looking at Steam, a successful
navigation is indistinguishable from nothing happening. That produced a fourth
wrong conclusion.

**Our clicks have windows too.** The bridge polls for 120s after each
delivery; a click consumed outside a door logs why. Every consumed click logs
`click-bridge:`; no line means the bridge was not armed, the poll ended, or
the bundle is stale.

**Firing test notifications.** `tools/fire TestDownloadComplete 1073390`
writes a command file into `~/.cache/steam-native-notify`; the backend hands it
over exactly once, and the frontend poll executes it within ~3s, calling the
named test method on Steam's own NotificationStore. Those `Test*` methods push
a real synthesized notification through the full toast pipeline. This covers
most client types (`TestFriendOnline`, `TestFriendMessage`, `TestAchievement`,
`TestIncomingVoiceChat`, ...; search `strTest:` in the bundle).

The poll is gated on the "Accept test commands from tools/fire" toggle in the
plugin settings, which ships OFF. Read a failed fire in this order:

- No `dev-fire:` log line at all: the toggle is off (or the bundle is stale).
- A `dev-fire:` line with no `from-toast` line: one of Steam's own gates ate
  the toast, not a plugin break. Known gates:
  - SystemUpdate allows the same update type once a week, and suppresses
    type 1 entirely once a type 2 ("restart required") has shown; both
    in-memory until Steam restarts (`BSkipSystemUpdateNotification`, verified
    by firing).
  - Server toasts obey the user's notification preferences
    (`CachedNotificationPreferences` in localconfig.vdf). On this machine
    Wishlist, Comment, Item, HelpRequest and PlaytestInvite have the toast bit
    off, so those types never toast until enabled in Steam Settings >
    Notifications.
  - Gift, TradeOffer and FriendInvite injections need a sender persona loaded,
    e.g. body `{"gifter_account":<accountid>}` with a friend's accountid.

**Server-sourced types go through injection.** Valve stubbed out the test
methods for server-backed types (Wishlist, TradeOffer, Comment, MajorSale...)
in the shipped client. `tools/fire --server <type> '<body-json>'` (and the
`--wishlist` shorthand) hands a synthetic rollup to Steam's real
`OnServerNotification` ingestion, the same path live server events take, so
capture, extraction and routing are exercised exactly as a real event would.

**Download completion is the only real-event self-service trigger:**
`steam steam://uninstall/1073390` then `steam steam://install/1073390`
(Aircar, 0.89GB). Everything else needs another person or a server event;
design captures so one real notification yields everything needed.

## What is verified

- Toasts are CEF popup windows: `notificationtoasts_<N>_desktop` on the
  desktop, `notificationtoasts_uid<appid>-...` in a focused game's overlay
  context. The title is the only thing visible outside the process; the text
  lives in the DOM.
- Steam attaches its own notification object to the toast's React tree:
  `{ notificationID, rtCreated, eType, nToastDurationMS, fnNotificationResolved,
  eSource, data, bNewIndicator }`. Client-sourced (`eSource=1`), `data` is a
  decoded Closure protobuf whose values sit in `array` at
  `fieldNumber + arrayIndexOffset_`. Server-sourced (`eSource=2`), it is a
  plain rollup object `{ type, item, url }` whose `item.body_data` is JSON.
- **The React path is strictly better than the notification feed.** An
  incoming voice chat renders as `notificationtoasts_10000_desktop` and
  produces no `RegisterForNotifications` event at all. The feed path is
  deleted; everything reads from React.
- `response_steamurl` is the only route-shaped field in the client schema and
  **arrives empty** on real friend messages. The bundle shows why it looked
  authoritative and is not: when non-empty it backs only the tray options
  button and the gamepad "Accept" menu, never the desktop body click.
- `fnNotificationResolved` is a dismissal predicate the toast animation loop
  polls each frame, fading the toast when it returns true. Not routing.
- Toast artwork: `steamloopback.host/assets/<appid>/<file>` maps to
  `~/.local/share/Steam/appcache/librarycache/<appid>/<file>`. Friend avatars
  are public CDN URLs, fetched once and cached.
- Notification actions must be named `default` to fire on a body click, and
  only while the popup is live, hence `-t 0`.
- The daemon does not auto-fire actions on expiry (verified), so a logged
  click is a genuine click.

### Runtime verification of the catalog (2026-08-27)

Capture and route verified on the live client via `tools/fire`:
DownloadCompleted (`steam://nav/games/details/1073390`), FriendInGame,
FriendOnline (`steam://friends/message/<steamid>`), FriendMessage, Achievement
(570 and 440; the route resolved from Steam's template with `%mystuff%`
filled), SystemUpdate types 1 and 2 (`steam://settings/system`),
FriendInviteRollup (pending invites URL), HardwareUpdateAvailable. `url
templates:` and `identity:` both load at startup.

The server (`eSource=2`) path is verified via injection: Gift and TradeOffer
rollups pushed through `OnServerNotification` rendered through Steam's own
components, extraction read `data.type` and `data.item.body_data` as coded,
and the routes resolved to the store gifts page and the trade offers page.
These were the first server-sourced captures, without waiting for a live
event.

Watched end-to-end clicks: fired Achievement and SystemUpdate toasts were
clicked; Steam surfaced on the achievements page and opened Settings. That
click-verifies the openurl and settings route families.

### Real events and surfaces (2026-08-29)

- **GroupChatMessage**: real mentions AND plain group messages toast; the
  decoded fields include `chat_group_id` and `chat_id`, which the room door
  needs. A group *invite* arrives as a plain FriendMessage, not a
  GroupChatMessage.
- **Real PlaytimeWarning, real FriendMessage DMs, GameRecordingStop with a
  `clip_id`, OverlaySplashScreen**: all captured from live events, not fires.
- **Every type whose Steam click acts now has a working mirror on every
  surface** — in-game (Helldivers 2), desktop with the game unfocused,
  tray-only, and no game — each verified by watching the click land.

### Observed click behaviour, with Steam focused

| Type | Steam does | We do |
|---|---|---|
| FriendMessage (8) | opens the chat | same |
| FriendOnline (4) | opens the chat | same |
| IncomingVoiceChat (17) | opens the chat, does not accept | same |
| DownloadCompleted (1) | switches library to that game | same |

All four match what the bundle says those components do, which is the
cross-check that made building the rest of the catalog from the bundle alone
defensible.

## Dead ends: do not redo these

- **`OnRespondToClientNotification(id, true)`** looked like a universal replay
  primitive. Only 2 of 45 messages carry a `notificationid`, and passing the
  feed index did nothing for every type tried.
- **An MEP click bridge** (uuid on disk, Unix socket back into the plugin,
  frontend polls and replays). Fully built and mechanically proven end to end,
  then deleted once routes turned out to be expressible as `steam://` URLs.
  MEP itself works and `tools/mep` remains useful for diagnostics.
- **Config-change propagation to a plugin frontend.** Millennium delivers an
  external config write by evaluating JS in the main IPC context; a plugin
  frontend runs in its own isolated CDP world and never sees it. The Lua
  `config.on_change` hook did not fire for MEP writes either.
- **Reading the click target from the DOM.** No anchors, no href, no inline
  handlers. It is all React state.
- **Compositor rules for hiding Steam's toast.** The plugin closes the popup
  itself after reading it, which is portable and knows the read succeeded.
- **External steam:// URLs into the overlay.** The wiki's `steam://overlay`
  command is gone from current binaries, and an externally invoked
  `steam://openexternalforpid` never reaches its JS handler — the client
  raises its main window over the game instead. Even a bare
  `steam://openurl/` navigates the desktop client and raises it over a
  focused game. The overlay is reachable only from inside the shared JS
  context.
- **The appid-0 ingestion cannot render `requestplaytime`.** The desktop
  playtime dialog opens through the navigator door
  (`GetNavigator({unRequestingAppID: 0}).RequestPlaytimeDialog("manual")`),
  not the activate-overlay request.
- **Instance objects are NOT valid browserInfo.** `ShowChatRoomGroupDialog`
  keys on a toast popup's `params.browserInfo` (its `m_unPID`); passing an
  overlay/desktop instance object opens the dialog on the wrong surface and
  never reuses an existing window. Only the browserInfo stashed from a
  toast's React tree works.

## The routing question, resolved

The 2024-era leads all closed at once by reading the shipped UI bundle on disk
(`~/.local/share/Steam/steamui/chunk~*.js`, beautified). Full write-up with
module references and provenance: `docs/steam-routing.md`. The short version:

- **There is no single resolver field.** `fnNotificationResolved` is toast
  dismissal, not routing. Routing is a per-type component dispatch whose
  activate handlers bottom out in a small vocabulary: chat dialogs, library
  navigation, settings pages, URL-store lookups, modals, or nothing.
- **The server (web) notification system is genuinely data-driven**: type-keyed
  registries turn `body_data` JSON into an https URL, navigated via
  `SteamWeb(url)`, which is literally `location.href = "steam://openurl/" +
  url`. Wishlist, TradeOffer, Comment, MajorSale and the rest of the June-2023
  clickable set live there, mapped onto client eTypes by a 23-entry table.
  `eSource=2` on the React object marks them; their `data` is a rollup object,
  not a Closure protobuf.
- **Steam's URL construction is reachable**: `SteamClient.URL.GetSteamURLList`
  serves the same named templates Steam's own `CURLStore` resolves, and the
  plugin fetches them at startup. `steam://url/<Name>/<params>` and
  `steam://openurl/<url>` are handled by the client with exactly the calls the
  notification components make.
- The expected person/game/store/account grouping is real but secondary; the
  primary split is client-handled vs server-webbed, then by activate primitive.

Routing implements that catalog (`frontend/routes.ts`), each rule citing its
row in `docs/steam-routing.md`. 31 of 62 types route as URLs. Of the rest,
five open dialogs no URL reaches — the group chat room, media items, the
playtime dialog — and the click bridge now opens those through Steam's own
components ("The click architecture" above); the remainder are inert in Steam
itself, so they stay inert here.

### Constraint the user has been firm about, and was right about

**Mirror Steam, do not invent.** Every invented route in this project's history
had to be torn out; the Achievement route was the latest: it pointed at the
game's library page until the bundle showed Steam opens the achievements page.
A notification whose click does nothing is correct if Steam's own toast does
nothing. When adding a route, cite the observation or the Steam code path it
came from.

## Still open

1. **The server-type sweep has gaps.** AsyncGame (12), TradeReversal (29),
   ModeratorMsg (14), FamilyInvite (16) and General (10) have never been
   injected; the CloudSyncConflict/Failure test fires have never been run
   either.
2. **Tray-only against the dialog doors.** The tray-only path is verified for
   URL routes; the room, screenshot and clip doors have not been clicked from
   a tray-only client.
3. **Clip from the desktop.** A GameRecordingStop/InstantClip click has not
   been watched on the desktop surface (in-game is verified).
4. **One real server event is still worth a look.** Injection verifies the
   pipeline against the rollup shape the bundle describes; a live wishlist
   sale or trade offer confirms the server actually sends that shape,
   especially the Comment rollup's `url` field, which no injection has
   exercised.
5. **The daemon matrix.** Everything end to end ran on this machine's daemon
   (quickshell). The escaping and caps seams are tested offline; mako, dunst,
   GNOME and KDE have not seen a live click.
