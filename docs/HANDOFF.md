# Handoff

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon. Capture, artwork and delivery work. Clicking works
for four notification types. The open problem is making click routing general
instead of per-type.

Read `README.md` for the architecture and `docs/notification-types.md` for the
type table. This file is the working context that is not obvious from the code.

## Working on this: read before touching anything

These cost hours to learn. Ignoring them will cost them again.

**A full Steam restart is required for any frontend change.** `plugin.restart`
and disable/enable reload the Lua backend but leave the frontend loaded and not
executing. The log still says "Delegating frontend load", which looks fine and
is not. Use:

```sh
steam -shutdown && sleep 15 && setsid uwsm-app -- gtk-launch steam.desktop
```

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

**Triggering notifications.** Download completion is the only reliable
self-service trigger: uninstall and reinstall a small game (Aircar, appid
1073390, 0.89GB) via `steam steam://uninstall/1073390` then
`steam steam://install/1073390`. Friend online, friend in game, incoming voice
chat and friend messages all need another person. Wishlist, comment, trade offer,
major sale and Steam Turn cannot be triggered at all without a second account or
a server-side event, and none has ever been observed here.

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
  **arrives empty** on real friend messages. Do not build on it.
- `fnNotificationResolved` is present as a key and `undefined` in every sample.
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

Everything else is unobserved. `FriendInGame` and `FriendInvite` carry a
`steamid` and probably behave like the others, but have never been clicked.

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

## The open problem

Routing is currently two rules plus per-type gating, derived from four observed
types. That does not scale to 63 types and it is not what Steam does internally.

Steam clearly has universal navigation logic: every notification in the client,
the mobile app and the website knows where it goes. Find it rather than
reconstructing it type by type.

Expected shape of the answer, from the notification types themselves:

- **person-bound** — friend message, friend online, friend in game, friend
  invite, incoming voice chat, group chat
- **game-bound** — download complete, achievement, requested game added, playtest
  invite, an invite to play
- **store-bound** — wishlist, major sale, item announcement
- **account-bound** — trade offer, help request, family and parental requests,
  moderator message

### Leads worth pursuing, roughly in order

1. **Find Steam's own notification navigation function.** Millennium exposes
   webpack module search (`findModuleExport`, `findAllModules`, `classMap` in the
   SDK). Steam's UI bundle almost certainly contains a single function that takes
   a notification and navigates. Locate it, then call it and let Steam route. This
   is the most likely form of the universal mapping.
2. **Stringify the toast's click handler.** The React fiber chain has an `onClick`
   somewhere above the toast body. `Function.prototype.toString()` on it, even
   minified, reveals which function it delegates to; then search the modules for
   that name.
3. **Capture a web-schema notification.** The six clickable types Valve added in
   the [June 2023 client update](https://store.steampowered.com/oldnews/195171)
   come from `steammessages_notifications.steamclient.proto`, whose
   `SteamNotificationData.body_data` is a JSON blob. That JSON is how Steam routes
   them, and it has never been seen here. `eSource` on the React notification
   object distinguishes the two systems; only `eSource=1` has been observed.
4. **Check whether `fnNotificationResolved` is ever populated.** If some types
   supply it, it is Steam's own resolver and should be preferred over any URL.
5. **Enumerate the `steam://` scheme.** SteamTracking and the community have
   partial lists. A `steam://` route that Steam itself constructs is better
   evidence than one we invent.

### Constraint the user has been firm about, and was right about

**Mirror Steam, do not invent.** Every invented route in this project's history
had to be torn out. A notification whose click does nothing is correct if Steam's
own toast does nothing. When adding a route, cite the observation or the Steam
code path it came from.

## Recommended cleanup, agreed but not yet done

- Delete the feed subscription, index correlation, the protobuf byte decoder and
  `toBase64`. React supersedes all of it. Roughly 200 lines.
- Collapse `routeFor` to name-based rules and drop per-type gating.
- **Keep the generated schema.** `data.array` is positional, and shape-guessing
  without field names misroutes: `FriendInviteRollup` carries `new_invite_count`,
  so a count of 3 becomes `steam://nav/games/details/3`.

## Open question deferred

`steam://nav/...` reuses the existing Steam window, so nothing opens and nothing
raises. A focus call was implemented, then removed, and the case for it is now
stronger: Steam's own toast can only be clicked while Steam has focus, so
"clicked while looking at Steam" is the baseline. A best-effort focus in
`tools/notify-action` would be the only window-manager dependency in the project.
