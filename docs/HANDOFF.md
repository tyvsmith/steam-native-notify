# Handoff

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon. Capture, artwork and delivery work. Click routing
is now built on Steam's own logic, read out of the shipped UI bundle: 28 of 62
types route, the rest are inert in Steam itself or open dialogs no URL can
reach. The open problem is runtime verification: the catalog is cited but most
routes have not yet fired on a live client.

Read `README.md` for the architecture, `docs/notification-types.md` for the
per-type table, and `docs/steam-routing.md` for the bundle analysis every route
cites. This file is the working context that is not obvious from the code.

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

**Always confirm the running bundle is the one on disk.** `tools/capture` reports
this first, because a stale bundle looks exactly like a broken feature.

**`npm run build` now type-checks, and that matters.** Five runtime failures in
this project's history were undefined names or nil globals that the bundler
emitted happily: two `PLUGIN_DIR` bugs, `toBase64`, `notificationFromToast`, and
a `JSON.stringify` on a BigInt inside a debug log. `tsc --noEmit` catches the
name errors. `tools/test-backend` catches the Lua ones. Run both.

**Never let a diagnostic throw.** A debug log that called `JSON.stringify` on a
BigInt killed every notification silently. `dlog` and `safeJson` are defensive
for that reason; keep them that way.

**Millennium's callable quirks.** Pass exactly ONE argument, a JSON string: key
order is not preserved onto Lua parameter names, and two keys arrived swapped.
A callable's return value comes back JSON-encoded, so a Lua string arrives
wrapped in literal quote characters.

## Testing methodology, which is easy to get wrong

**A Steam toast is only clickable while a Steam window has focus.** Unfocused it
takes no click at all: no cursor change, no highlight. Every "Steam's toast does
nothing" observation taken unfocused is meaningless, and three wrong conclusions
in this project came from exactly that.

**Watch the client while clicking.** A `steam://nav/...` route changes the page
inside the existing window. If you are not looking at Steam, a successful
navigation is indistinguishable from nothing happening. That produced a fourth
wrong conclusion.

**Triggering notifications.** `tools/fire TestDownloadComplete 1073390` pushes
a real synthesized notification through Steam's full toast pipeline: Steam's
own NotificationStore (a shared-context global) carries per-type test methods,
the plugin's debug poll executes the named one within ~3s. This covers most
client types (`TestFriendOnline`, `TestFriendMessage`, `TestAchievement`,
`TestIncomingVoiceChat`, ...; search `strTest:` in the bundle). Server-backed
types (Wishlist, TradeOffer, Comment, MajorSale...) cannot be fired this way:
their test path is an empty function in the shipped client, so they still need
a real event. Download completion remains the only real-event self-service
trigger: `steam steam://uninstall/1073390` then `steam steam://install/1073390`
(Aircar, 0.89GB).

## What is verified

- Toasts are CEF popup windows named `notificationtoasts_<N>_desktop`. The title
  is the only thing visible outside the process; the text lives in the DOM.
- Steam attaches its own notification object to the toast's React tree:
  `{ notificationID, rtCreated, eType, nToastDurationMS, fnNotificationResolved,
  eSource, data, bNewIndicator }`. `data` is a decoded Closure protobuf whose
  values sit in `array` at `fieldNumber + arrayIndexOffset_`.
- **The React path is strictly better than the notification feed.** An incoming
  voice chat renders as `notificationtoasts_10000_desktop` and produces no
  `RegisterForNotifications` event at all. Every route currently produced comes
  from React; the feed contributes nothing and should be deleted.
- `response_steamurl` is the only route-shaped field in the client schema and
  **arrives empty** on real friend messages. The bundle shows why it looked
  authoritative and is not: when non-empty it backs only the tray options
  button and the gamepad "Accept" menu, never the desktop body click.
- `fnNotificationResolved` is present as a key and `undefined` in every sample.
  The bundle settles what it is: a dismissal predicate the toast animation loop
  polls each frame, fading the toast when it returns true. Not routing.
- Toast artwork: `steamloopback.host/assets/<appid>/<file>` maps to
  `~/.local/share/Steam/appcache/librarycache/<appid>/<file>`. Friend avatars are
  public CDN URLs and are fetched once and cached.
- Notification actions must be named `default` to fire on a body click, and only
  while the popup is live, hence `-t 0`.

## Observed click behaviour, with Steam focused

| Type | Steam does | We do |
|---|---|---|
| FriendMessage (8) | opens the chat | same |
| FriendOnline (4) | opens the chat | same |
| IncomingVoiceChat (17) | opens the chat, does not accept | same |
| DownloadCompleted (1) | switches library to that game | same |

All four match what the bundle says those components do, which is the
cross-check that made building the rest of the catalog from the bundle alone
defensible. The full per-type inventory is `docs/notification-types.md`; the
citations are `docs/steam-routing.md`.

## Dead ends: do not redo these

- **`OnRespondToClientNotification(id, true)`** looked like a universal replay
  primitive. Only 2 of 45 messages carry a `notificationid`, and passing the feed
  index did nothing for every type tried.
- **An MEP click bridge** (uuid on disk, Unix socket back into the plugin,
  frontend polls and replays). Fully built and mechanically proven end to end,
  then deleted once routes turned out to be expressible as `steam://` URLs. MEP
  itself works and `tools/mep` remains useful for diagnostics.
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
  `SteamWeb(url)` — which is literally `location.href = "steam://openurl/" +
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

Routing now implements that catalog (`frontend/routes.ts`), with each rule
citing its row in `docs/steam-routing.md`. 28 of 62 types route; the rest are
inert in Steam or open dialogs no URL reaches (group chat rooms, Media items,
modals).

### Constraint the user has been firm about, and was right about

**Mirror Steam, do not invent.** Every invented route in this project's history
had to be torn out — the Achievement route was the latest: it pointed at the
game's library page until the bundle showed Steam opens the achievements page.
A notification whose click does nothing is correct if Steam's own toast does
nothing. When adding a route, cite the observation or the Steam code path it
came from.

## The open problem: runtime verification

Partially done on 2026-08-27, against the live client:

- **Verified end to end via `tools/fire`**: Achievement (route resolved from
  Steam's template with `%mystuff%` filled: `steam://openurl/...profiles/
  <me64>/stats/appid/570/achievements/`), DownloadCompleted
  (`steam://nav/games/details/1073390`), FriendOnline
  (`steam://friends/message/<steamid>`), SystemUpdate
  (`steam://settings/system`), FriendInviteRollup (pending invites URL),
  FriendInGame (delivery confirmed on the DBus Notify call). `url templates:`
  and `identity:` both load at startup.
- **The openurl and settings families are click-verified, watched**: fired
  Achievement and SystemUpdate toasts were clicked; console_log shows
  `steam -foreground` then the route one second later each time, and the user
  confirmed Steam surfaced on the achievements page and opened Settings. The
  daemon does not auto-fire actions on expiry (verified), so clicks are
  genuine.
- **Test fires can be swallowed by per-type gating**: SystemUpdate allows the
  same update type once a week, and suppresses type 1 entirely once a type 2
  ("restart required") has shown — both in-memory until Steam restarts
  (`BSkipSystemUpdateNotification`, verified by firing). A `dev-fire:` line
  with no `from-toast` line means a gate, not a break.

Still open:

1. **Watch a click on the chat-route skip**: does the chat dialog come up
   focused with the main window left alone (`tools/fire TestFriendOnline`).
   `steam://nav/...` was observed before the rewrite and is unchanged.
2. **Server types need real events.** The next wishlist sale or trade offer is
   the first live `eSource=2` capture ever; the debug log dumps the whole
   rollup (`server type=... body=...`), so one event verifies the field names
   the routes read (`body.link`, `body.ticket`, rollup `url`...). Check those
   against `frontend/routes.ts` before trusting the route.
3. **The popup is the whole click window.** quickshell 1.2 expires the popup
   after ~8s despite `-t 0` and the action dies with it (the notification
   centre copy is inert). Orthogonal to routing, but it bounds how a click can
   ever be tested or used here.

## Focus, resolved without window-manager code

`steam://nav/...` and `steam://openurl/...` change pages inside the existing
window and never raise it; only the chat routes self-focus (`friends/message`
passes `btakefocus=1`). Steam never needed raise-on-navigate on the desktop:
its toasts are only clickable while Steam is already focused. The desktop
`steam://` surface contains no raising URL at all (the dispatcher and every
table entry were read; the one `BringToFront` on navigation is gamepad-only).

The fix is Steam's own launcher-activation path: an argless `steam` invocation
while the client runs makes it show and focus its main window itself — verified
live, focus moved to Steam on any-WM mechanics. `tools/notify-action` now runs,
on click only, `steam; steam "$route"` for non-chat routes (sequenced, so a
tray-only client surfaces first and a stopped one boots then navigates), and
just the route for chat routes, whose dialog would otherwise risk being buried
by the main window. `notify-action --click-plan <route>` prints the decision;
`tools/test-backend` asserts it. Unclicked notifications never touch the
`steam` binary at all.

Still unwatched: the tray-only case end to end (window created + focused +
navigated by one click). The raise of an existing background window is the
part verified by observation.
