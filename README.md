# steam-native-notify

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon, keeping the artwork and the click. Toasts land
in your notification centre with everything else, and clicking one does
exactly what clicking Steam's own toast would — because it *is* Steam's own
click: at capture time the plugin stashes the click handler Steam attached to
the toast, and a click on the desktop notification re-runs it. There is no
per-type routing table to maintain; notification types Steam adds tomorrow
are clickable on day one.

`docs/architecture.md` is the full picture; `docs/notification-types.md`
lists every notification type and what Steam's click does for it.

## Why a plugin

Steam draws each toast as its own CEF window whose title is the only text
outside the process; the message exists only in that window's DOM. Compositor
rules, Steam's logs, and AT-SPI carry none of it, so the reader must run
inside Steam's UI.

## Install

Requires [Millennium](https://steambrew.app) >= v3.5 (the `.star` plugin
format) and [Bun](https://bun.com).

```sh
bun install
bun run build
```

The build packs the plugin into
`~/.local/share/millennium/plugins/me.tysmith.steam-native-notify.star`, so
building is installing. Restart Steam, then enable **Steam Native Notify**
under Millennium > Plugins. After rebuilding, restart Steam fully:
`plugin.restart` and disable/enable leave the plugin stopped.

Runtime dependencies: `notify-send`, `curl`, `steam`, `sh`.

## Settings

Two toggles, both on by default:

- **Use native notifications when outside of games**: send Steam
  notifications to the desktop daemon while no game has focus.
- **Use native notifications when inside games**: also send them while a
  game has focus, alongside Steam's in-game toast. Off keeps in-game
  notifications inside Steam only.

Steam's own toast is hidden once the native notification is confirmed
delivered — it replaces Steam's toast rather than duplicating it, and a
failed or unimplemented delivery leaves Steam's toast alone. That and the
`tools/fire` test-command door are developer toggles (`hideSteamToast`,
on by default; `devFire`, off), hidden unless `devMode` is set in the
plugin's stored settings — there is deliberately no UI for it (see
`docs/architecture.md`, testing methodology).

## Diagnosing

```sh
tools/capture   # is the running .star current, did the hook attach,
                # what did the last notifications carry
```

The plugin logs to `~/.cache/steam-native-notify/plugin.log` (truncated at
each backend load); Millennium's loader lines are in
`~/.steam/steam/logs/console-linux.txt` under `me.tysmith.steam-native-notify`.
Every stage of a click logs one line, and every failure mode names itself —
the vocabulary table is in `docs/architecture.md`.

## Compatibility and known gaps

- Linux with native Steam is the shipped target, with any FreeDesktop
  notification daemon that supports actions. Without action support the
  notification shows but the click does nothing. Flatpak and Snap Steam are
  not supported by Millennium itself; the plugin's paths already know the
  Flatpak layout, but nothing has run there. On macOS the backend loads,
  logs that delivery is not implemented, and delivers nothing.
- **Windows support is EXPERIMENTAL and display-only.** Notifications work,
  validated on real Windows 11: WinRT toasts through a PowerShell helper,
  branded "Steam" with the artwork, persisting in the Action Center; no
  vendored binaries, every registration per-user and reversible. **Clicking a
  Windows toast does nothing** — an unpackaged, binary-free sender cannot get
  toast-click activation on Windows (it needs a compiled COM activator);
  `docs/platforms.md` records the validation and the deferred click work. The
  in-game half is further limited by Focus Assist, which suppresses toasts
  during fullscreen games by default.
- The 64-bit SteamRT3 client does not work: Millennium installs and reports
  success there, but its hook does nothing
  ([Millennium #840](https://github.com/SteamClientHomebrew/Millennium/issues/840)).
- On Linux a notification is clickable only while its popup is up; the copy
  in the notification centre is inert. quickshell 1.2 expires the popup
  after about 8 seconds despite the no-timeout hint, which bounds the click
  window. (On Windows, protocol activation is designed to make Action
  Center clicks work too — unverified, like all Windows behaviour here.)
- The stashed click is frozen to the surface the toast rendered on: a
  notification captured while a game was focused, clicked after that game
  exits, does nothing. Clicks also expire 120 seconds after delivery and do
  not survive a Steam restart or full quit.
- A toast whose handler cannot be identified with proof stays unclickable by
  design — never the wrong action. Notification types whose Steam click does
  nothing are equally unclickable here: the plugin mirrors Steam, it does
  not invent.
- Some server-sent types (wishlist sales, comments, and others) never toast
  unless enabled under Steam Settings > Notifications. Steam suppresses them
  before this plugin sees anything.
