---
name: steam-update-smoke
description: Smoke-test the plugin after a Steam client update — proto drift check, hook attachment, one client + one server fire. Use for "Steam updated", "check nothing broke after the update", "the hook stopped working", "extraction broke", or any g_PopupManager / server-store lookup failure.
---

Steam updates move two things: the published protobuf (new notification types)
and the minified UI bundle (`g_PopupManager`, store shapes, module names all
reshuffle). All commands run from the repo root.

## 1. Proto drift

```sh
bun run proto:check
```

Exit 0 "proto is current" — move on. On drift it names new/removed types and
messages; then:

```sh
bun run proto:update && bun run gen && bun run gen:table
```

`gen:table` errors `no catalog entry for <Type> -- Steam added a type;
re-read the bundle` name exactly the types needing a new CATALOG row — each
needs a bundle citation first (see the `add-route` skill). Rebuild and
full-restart Steam after regenerating (`live-verify` skill, step 1); commit
`vendor/`, `frontend/generated/`, and `docs/notification-types.md` together.

## 2. Did the hook attach?

```sh
tools/capture
```

- Section 1 must say `current.` before anything else is trusted.
- Section 2 missing `hook installed`, or showing `g_PopupManager never
  appeared` / `hook failed` — the bundle renamed or moved the popup manager.
- `server store lookup failed` or a later `dev-fire: server notification store
  not found` — the webpack export search for `OnServerNotification` +
  `MarkItemRead` no longer matches; the server store shape moved.

**Millennium #840 caveat**: on the 64-bit SteamRT3 client the hook installs,
reports success, and does nothing. `hook installed` plus zero toast lines ever
captured despite real toasts on screen matches that bug, not this plugin.

## 3. Smoke pair: one client fire, one server fire

Toggle and log interpretation are in the `live-verify` skill.

```sh
tools/fire TestAchievement 570
tools/fire --server 2 '{"gifter_account":82140618}'
```

Both should produce `dev-fire:` then `from-toast ...` then `toast ... ->` in
`tools/capture`. A `dev-fire:` with no `from-toast` is a Steam gate, not
breakage (see `live-verify`); no `dev-fire:` at all is the toggle or a stale
bundle.

## 4. Bridge smoke: one chat click, one overlay-door call

The click path holds more minified surfaces than the capture path, and an
update can move any of them: `g_PopupManager` / `m_mapPopups` (the desktop
raise walks it for the "SP Desktop" window), the activate-overlay store
(export search for `OnGameOverlayActivateRequested` +
`OnSteamURLOpenExternalForPID`), its `GetNavigator` (the media and playtime
doors), the FriendsUI dispatcher (export search for `ShowChatRoomGroupDialog`
+ `ShowFriendChatDialog`), the browserInfo provider shape above the
notification fiber (the room door's context), and
`SteamClient.Overlay.GetOverlayBrowserInfo` /
`System.UI.RegisterForOverlayGameWindowFocusChanged` (focus and appid).

Two checks cover the halves, desktop only, no game needed:

```sh
tools/fire TestFriendMessage null '"bridge smoke"'   # then CLICK the desktop notification
tools/fire --overlay-media 0                         # navigator door, no toast involved
```

- The clicked chat must open its dialog; the log must show `click-bridge:`
  then `click-bridge: desktop steam://friends/message/...`. A `click-bridge:`
  with `desktop door failed` / `raise failed` after it means the popup walk
  or the URL executor moved.
- `--overlay-media 0` must open Recordings & Screenshots in the main window
  and log `overlay: media appid=0`. `overlay store lookup failed` or
  `overlay: navigator has no Media.Grid` means the export search or the
  navigator shape moved.
- The room door (FriendsUI dispatcher + stashed browserInfo) has no
  self-service trigger; a real group message is the only full check. A
  `chat dispatcher lookup failed` line at click time is the reshuffle signal.

## 5. If extraction broke

The fix starts in `docs/steam-routing.md` against the NEW bundle, not in the
code: beautify `~/.local/share/Steam/steamui/chunk~*.js`
(`bunx js-beautify -f <chunk> -o chunk.pretty.js`), re-find the shapes using
the quoted strings in that doc as search keys (minified identifiers are
worthless across builds), update the doc's provenance header (build number,
chunk name, sha256 prefix), and only then adjust the code to match.
