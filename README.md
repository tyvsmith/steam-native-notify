# steam-native-notify

Mirrors Steam's in-client notification toasts to the desktop notification
daemon, so they land in your notification centre with everything else.

Status: **prototype under test.** Capture, artwork and delivery are verified
against a live client, and clicks for four types match Steam's own behaviour.
Routing is built on Steam's own click logic, read out of the shipped UI bundle:
31 of 62 notification types route, the rest are inert in Steam itself or open
dialogs no URL can reach. `docs/steam-routing.md` is the analysis every route
cites; most routes still await runtime verification.

Steam's own toasts are left visible alongside these by default, so the two can
be compared; the plugin's settings panel has the toggle that hides them.

## Why this has to be a plugin

Steam draws every notification as its own top-level XWayland window titled
`notificationtoasts_<N>_desktop`. That title is the only text outside the
process; the message a person reads is rendered inside CEF. A compositor rule can
move, hide, or float that window, but it cannot read it.

Nothing else on the system can either, which was checked rather than assumed:

- **AT-SPI** publishes nothing for Steam. Chromium only builds an accessibility
  tree when asked via `--force-renderer-accessibility`, and Steam exposes no way
  to pass it.
- **Steam's logs** never contain toast text. Every `notification` string in
  `~/.steam/steam/logs/` is `OnAppLifetimeNotification`, a game session event.

## How it works

```
Toast window (notificationtoasts_<N>_desktop)
   |    innerText -> title / body,  <img>.src -> artwork
   |    React tree -> Steam's own decoded notification -> steam:// route (or none)
   |  callable('Notify') with one JSON argument
backend/main.lua
   |  spawns tools/notify-action, detached
        |  resolves the icon (library cache, or fetch and cache from the CDN)
        |  notify-send -A default=Open -t 0
        |  on click: steam <route>
```

Four pieces: `frontend/index.tsx` captures and decodes, `backend/main.lua`
escapes and spawns, `tools/notify-action` delivers and acts, and `tools/capture`
reports what happened.

## Build and install

```bash
npm install
npm run build     # regenerates proto types, then bundles to .millennium/Dist
ln -s "$PWD" ~/.local/share/millennium/plugins/steam-native-notify
```

Restart Steam, then enable **Steam Native Notify** under Millennium > Plugins.

A **full Steam restart is required for any frontend change**. `plugin.restart`
and disable/enable both reload the backend but leave the frontend loaded and not
executing. `tools/mep plugin.restart name=steam-native-notify` is enough for a
backend-only change.

## Diagnosing

```bash
tools/capture          # is the running bundle current, did the hook attach,
                       # and what did the last notifications carry
tools/fire TestFriendOnline   # push a real test toast through Steam's pipeline
tools/mep --methods    # talk to Millennium's external protocol (dev only)
tools/notify-action --resolve-icon <url>
npm run proto:check    # has Steam's protobuf drifted from the vendored copy
```

## Design decisions

**Mirror Steam, do not improve on it.** A click does what Steam's own toast
does, and nothing more. Every route is taken from the click handler in Steam's
shipped UI bundle -- the same chat dialog, the same library page, the same URL
built from the same `SteamClient.URL` template table Steam's own code resolves.
Where Steam's click opens something no URL can reach (a group chat room dialog,
a Media item, a modal), the click here does nothing rather than something
nearby. `docs/steam-routing.md` records the analysis, per type, with
provenance.

**No window-manager code.** A click both surfaces the client and navigates it,
without touching the compositor: an argless `steam` is the launcher-activation
path, on which the running client shows and focuses its main window itself.
Steam's own nav and web handlers never raise a window -- its toasts are only
clickable while Steam is focused, so its code never needed to -- and chat
routes skip the activation because the client force-focuses the chat dialog on
its own. The project depends on nothing beyond `notify-send`, `curl` and
`steam`.

**Protobuf types are generated, not written.** `vendor/` holds Steam's published
`.proto`; `tools/gen-proto.mjs` turns it into `frontend/generated/`. Hand-writing
the enum drifted six values behind, and matching fields by position read the
wrong field for two messages. `npm run proto:check` reports upstream drift rather
than letting it pass silently. The npm package that ships these definitions has
two downloads a week and distributes generated JavaScript, which is a poor trade
for a 9KB file that can be read in full.

**The backend takes one JSON argument.** Millennium does not map an argument
object's keys onto Lua parameter names; two keys arrived in the wrong order and
produced a notification with its summary and body swapped, silently.

## Verified against a live client

- Toasts are windows titled `notificationtoasts_<N>_desktop`, and the feed's
  index matches that counter.
- Persistent Steam windows arrive titled; transient popups arrive untitled.
- `g_PopupManager.AddPopupCreatedCallback` fires for every popup.
- The feed works inside a plugin's isolated CDP world, and its payload is real
  protobuf: a DownloadCompleted decoded to `{appid: 1073390, dlc_appid: 0}`.
- Toast artwork resolves without downloading:
  `steamloopback.host/assets/<appid>/<file>` maps to
  `~/.local/share/Steam/appcache/librarycache/<appid>/<file>`. Friend avatars are
  public CDN URLs and are fetched once, then cached.
- Notification actions must be named `default` to fire on a body click, and only
  while the popup is live. An expired popup becomes a "restored row" with no live
  actions, hence `-t 0`.
- `OnRespondToClientNotification` ignored every notification passed to it. Only
  2 of 45 messages carry a `notificationid`, so there is usually no id to give it.
- A callable's return value arrives JSON-encoded, so a Lua string comes back
  wrapped in literal quote characters.
- **A Steam toast is only clickable while a Steam window has focus.** Unfocused,
  it takes no click at all: no cursor change, no highlight. Every earlier reading
  of "Steam's toast does nothing" was taken unfocused and was therefore wrong,
  including for downloads and friend-online. Test clicks with the client in
  focus or the result means nothing.
- With focus, the observed behaviour is: FriendMessage, FriendOnline and
  IncomingVoiceChat all open the chat with that person; DownloadCompleted
  switches the library to that game. A voice request opens the chat rather than
  accepting the call.
- `response_steamurl` is declared on CClientNotificationFriendMessage and
  arrives empty. It is the only route-shaped field in the schema, which made it
  look authoritative; routing has to come from `steamid` instead.
- The notification feed does not deliver every notification. An incoming voice
  chat renders as `notificationtoasts_10000_desktop` and produces no feed event,
  so extraction reads Steam's notification object out of the React tree, where
  `data` is already a decoded protobuf wrapper.

## Known gaps

- **Friend messages are unobserved.** The one type with an action, and the only
  path `response_steamurl` exercises. Everything about click behaviour rests on
  it.
- **Six clickable types are out of reach.** Valve's June 2023 client update made
  Wishlist, Trade Offer, Steam Turn, Help Request, Major Sale and Comment toasts
  clickable. None of them has a protobuf message, so no route can be derived from
  the feed. Their routing lives outside this schema.
- **In-game is untested.** Whether toasts are capturable while a game has focus
  is unknown.
- **The click action outlives nothing.** Despite `-t 0`, quickshell 1.2
  expires the popup after ~8 seconds and closes the notification, which ends
  `notify-send` without firing the action (verified: expiry prints no action).
  A notification is clickable only while the popup is up; the copy in the
  notification centre is inert.
- Millennium's hook preloads into the 32-bit Steam client. On the SteamRT3
  64-bit client it installs, reports success, and does nothing
  ([Millennium #840](https://github.com/SteamClientHomebrew/Millennium/issues/840)).
