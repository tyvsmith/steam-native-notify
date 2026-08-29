# Handoff

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon. Capture, artwork, delivery, routing, and focus all
work. Routing is built on Steam's own click logic, read out of the shipped UI
bundle: 31 of 62 types route, the rest are inert in Steam itself or open
dialogs no URL can reach. The catalog is runtime-verified for ten types across
both notification systems, including two watched end-to-end clicks; the short
list of what remains unwatched is at the end of this file.

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
frontend/log.ts           dlog/safeJson; its prefixes are tools/capture's grep contract
frontend/devfire.ts       the tools/fire door, gated on a setting, off by default
frontend/Settings.tsx     the settings panel; settings.ts persists ONE JSON document
backend/main.lua          a pure marshaller: JSON in, spawn tools/notify-action
tools/notify-action       markup escaping, icon resolution, notify-send, click plan
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
loader lines (capture's freshness stamp).

## Working on this: read before touching anything

These cost hours to learn. Ignoring them will cost them again.

**A full Steam restart is required for any frontend change.** `plugin.restart`
and disable/enable reload the Lua backend but leave the frontend loaded and not
executing. The log still says "Delegating frontend load", which looks fine and
is not. Use:

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

- Toasts are CEF popup windows named `notificationtoasts_<N>_desktop`. The
  title is the only thing visible outside the process; the text lives in the
  DOM.
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
clicked; the log shows `steam -foreground` then the route a second later each
time, and Steam surfaced on the achievements page and opened Settings. That
click-verifies the openurl and settings route families.

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
row in `docs/steam-routing.md`. 31 of 62 types route; the rest are inert in
Steam or open dialogs no URL reaches (group chat rooms, Media items, modals).

### Constraint the user has been firm about, and was right about

**Mirror Steam, do not invent.** Every invented route in this project's history
had to be torn out; the Achievement route was the latest: it pointed at the
game's library page until the bundle showed Steam opens the achievements page.
A notification whose click does nothing is correct if Steam's own toast does
nothing. When adding a route, cite the observation or the Steam code path it
came from.

## Focus, resolved without window-manager code

`steam://nav/...` and `steam://openurl/...` change pages inside the existing
window and never raise it; only the chat routes self-focus (`friends/message`
passes `btakefocus=1`). Steam never needed raise-on-navigate on the desktop:
its toasts are only clickable while Steam is already focused. The desktop
`steam://` surface contains no raising URL at all (the dispatcher and every
table entry were read; the one `BringToFront` on navigation is gamepad-only).

The fix is Steam's own launcher-activation path: an argless `steam` invocation
while the client runs makes it show and focus its main window itself (it
becomes `steam -foreground` in the log). Verified live; focus moved to Steam on
any-WM mechanics. `tools/notify-action` runs, on click only, `steam;
steam "$route"` for non-chat routes (sequenced, so a tray-only client surfaces
first and a stopped one boots then navigates), and just the route for chat
routes, whose dialog would otherwise risk being buried by the main window.
`notify-action --click-plan <route>` prints the decision; `tools/test-backend`
asserts it. Unclicked notifications never touch the `steam` binary at all.

## Still open

1. **Watch a click on the chat-route skip**: does the chat dialog come up
   focused with the main window left alone (`tools/fire TestFriendOnline`).
   `steam://nav/...` was observed before the rewrite and is unchanged.
2. **The tray-only case end to end**: window created, focused, and navigated
   by one click. The raise of an existing background window is the part
   verified by observation.
3. **One real server event is still worth a look.** Injection verifies the
   pipeline against the rollup shape the bundle describes; a live wishlist
   sale or trade offer confirms the server actually sends that shape,
   especially the Comment rollup's `url` field, which no injection has
   exercised.
4. **In-game capture is untested.** Whether toasts are capturable while a game
   has focus is unknown.
5. **The popup is the whole click window.** quickshell 1.2 expires the popup
   after ~8s despite `-t 0` and the action dies with it (the notification
   centre copy is inert). Orthogonal to routing, but it bounds how a click can
   ever be tested or used here.
6. ~~Ecosystem: migrate to the starlight compiler and `millennium.toml`.~~
   Done (2026-08-28). The plugin is a packed `.star`
   (`me.tysmith.steam-native-notify`), built and installed by
   `bun run build`; `@steambrew/client` imports became the `millennium`
   module; `tools/notify-action` rides inside the .star as an asset and the
   backend materializes it to `~/.cache/steam-native-notify` at load, next to
   the `.dev-fire` handoff and the mirrored `plugin.log`. The whole pipeline
   was re-verified live through `tools/fire` (Achievement and a server Gift
   injection) after the switch.
