---
name: live-verify
description: End-to-end runtime verification against the live Steam client — build, restart Steam, confirm the running bundle with tools/capture, fire test notifications with tools/fire, interpret the log. Use for "verify on the live client", "fire a test notification", "test this route in Steam", "did the change land", or after ANY frontend change.
---

All commands run from the repo root. Plugin log:
`~/.cache/steam-native-notify/plugin.log` (mirrored by the backend, truncated
at each backend load); Millennium's loader lines are in
`~/.steam/steam/logs/console-linux.txt` under `me.tysmith.steam-native-notify`.

## 1. Build, then full-restart Steam

```sh
bun run build
```

The build packs and installs
`~/.local/share/millennium/plugins/me.tysmith.steam-native-notify.star`
(starlight `output_path = "auto"`); there is no separate install step.

**A full Steam restart is required for ANY change, backend included.** Under
the .star format `plugin.restart` and disable/enable leave the backend
STOPPED — the log shows "backend loaded" then "backend unloaded" immediately,
`tools/mep plugin.status name=me.tysmith.steam-native-notify` reports
`running: false`, and `.dev-fire` sits unconsumed. Only a full Steam restart
recovers it. The frontend was already unreloadable ("Delegating frontend
load" logs and does not execute).

```sh
steam -shutdown && sleep 15 && setsid uwsm-app -- gtk-launch steam.desktop
sleep 20; pgrep -x steam >/dev/null || setsid uwsm-app -- gtk-launch steam.desktop
```

`steam -shutdown` returns before shutdown finishes; a launch while the old
instance is still dying pings it and exits **silently**. Hence the pgrep
re-launch — it has been needed twice in one session.

## 2. `tools/capture` first, always

```sh
tools/capture        # or: tools/capture 20  for more notification lines
```

A stale bundle is indistinguishable from a broken feature; never diagnose past
this step.

| capture says | meaning / next step |
|---|---|
| `STALE — Steam is running an older build` | restart Steam (step 1), re-run capture. Ignore capture's own "toggle the plugin off and on" hint — toggling reloads only the Lua backend, never the frontend |
| `loaded (never)` | enable the plugin in Millennium > Plugins |
| no `hook installed` in section 2 | bridge inactive — see the `steam-update-smoke` skill |
| `url templates:` / `identity:` missing | openurl/profile routes will emit null; check those lines' errors |
| section 3 empty | nothing captured yet — fire something (step 4) |

## 3. The tools/fire toggle

The dev poll is gated on **"Accept test commands from tools/fire"** in
Millennium > Plugins > Steam Native Notify. Ships OFF. Flipping it in the UI
takes effect immediately, no restart.

Preset it externally (needs Steam running for the socket; `tools/mep` needs
python3-msgpack):

```sh
tools/mep plugin.config.get name=me.tysmith.steam-native-notify key=settings   # read current first
tools/mep plugin.config.set name=me.tysmith.steam-native-notify key=settings \
  value='"{\"hideSteamToast\":false,\"devFire\":true}"'
```

With Steam stopped, the same document can be seeded directly in
`~/.config/millennium/config.json` under
`plugins."me.tysmith.steam-native-notify".config.settings` (a JSON string).

- The value must arrive as a JSON-encoded **string** (the whole settings
  document). mep parses values as JSON, so a bare `{...}` arrives as a map and
  `LoadSettings` silently falls back to defaults.
- MEP config writes never reach a running frontend (verified dead end): the
  preset takes effect at the next frontend load, i.e. the next Steam restart.
- The write replaces the whole document — carry `hideSteamToast` too.

## 4. Fire

Client types (Steam's own NotificationStore Test* methods; args are JSON
values — bare numbers and `null` pass through, quote strings):

```sh
tools/fire TestAchievement 570
tools/fire TestFriendOnline
tools/fire TestDownloadComplete 1073390
tools/fire TestSystemUpdate 1                # 1 = update available, 2 = restart required
tools/fire TestFriendMessage null '"Ready to play?"'
```

Also: `TestFriendIngame`, `TestIncomingVoiceChat`, `TestFriendInviteRollup`,
`TestCloudSyncConflict/Failure`; search `strTest:` in the bundle for the rest.

Server (eSource=2) types — their shipped test methods are stubbed, so these
inject through Steam's real `OnServerNotification` ingestion:

```sh
tools/fire --server 2 '{"gifter_account":82140618}'       # Gift
tools/fire --server 9 '{"sender":"76561198257837083"}'    # TradeOffer
tools/fire --wishlist 1073390                             # Wishlist (appid must be known to the client)
```

body_data fields per type: `docs/steam-routing.md`, server catalog.
"queued" only means the file was written; the poll picks it up within ~3s
**if** the toggle is on.

The only real-event self-service trigger is download completion:

```sh
steam steam://uninstall/1073390 && steam steam://install/1073390   # Aircar, 0.89GB
```

## 5. Read the verdict (`tools/capture`, section 3)

| log signature | meaning |
|---|---|
| no `dev-fire:` line at all | toggle off (or stale bundle — step 2 first) |
| `dev-fire:` but no `from-toast` after it | a **Steam gate**, not a break — see below |
| `dev-fire: NotificationStore.X is not a function` | wrong test method name |
| `dev-fire: server notification store not found` | bundle reshuffle — see `steam-update-smoke` |
| `from-toast ... type=N (Name) source=... fields=...` | extraction worked; check the fields |
| `toast ... -> {"title":...,"route":...}` | what was delivered, including the computed route |

Known gates that swallow fires silently:

- **SystemUpdate**: same update type at most once a week; type 1 suppressed
  outright after a type 2. Both in-memory until Steam restarts.
- **Server types obey the user's notification preferences**
  (`CachedNotificationPreferences` in localconfig.vdf). On this machine
  Wishlist, Comment, Item, HelpRequest, PlaytestInvite have the toast bit OFF —
  enable in Steam Settings → Notifications or the fire never toasts.
- **Gift/TradeOffer need a sender persona loaded** (use a friend's account id);
  server FriendInvite needs the requestor's.

## 6. Click testing rules

- **A Steam toast is only clickable while a Steam window has focus.** Unfocused
  it takes no click at all. Any "Steam's toast does nothing" observation taken
  unfocused is meaningless (three wrong conclusions came from this).
- **Watch the client while clicking**: `steam://nav/...` changes a page inside
  the existing window; unwatched, a working navigation looks like nothing.
- **The desktop notification's click window is bounded**: quickshell expires
  the popup after ~8s despite `-t 0`, the action dies with it, and the
  notification-centre copy is inert. Click within ~8s.
- A click that does nothing is CORRECT when the route is null — mirror Steam.
