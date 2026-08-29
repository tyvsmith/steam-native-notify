# steam-native-notify

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon, keeping the artwork and the click action. Toasts
land in your notification centre with everything else, and a click does what
clicking Steam's own toast does: open the chat, the library page, the
achievements page. The click also surfaces the Steam window first, which
Steam's own toasts never do.

Routing mirrors Steam's own click logic, read out of the shipped UI bundle:
31 of 62 notification types route; the rest are inert in Steam itself or open
dialogs no URL can reach. `docs/notification-types.md` lists every type and
what a click does.

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
`plugin.restart` and disable/enable do not reload the frontend.

Runtime dependencies: `notify-send`, `curl`, `steam`, `sh`.

## Settings

Two toggles in the plugin's settings panel, both off by default:

- **Hide Steam's own notification toasts**: close Steam's toast once it has
  been read, so only the desktop notification shows.
- **Accept test commands from tools/fire**: the development door for firing
  test notifications. Leave it off unless you are working on the plugin.

## Diagnosing

```sh
tools/capture   # is the running .star current, did the hook attach,
                # what did the last notifications carry
```

The plugin logs to `~/.cache/steam-native-notify/plugin.log` (truncated at
each backend load); Millennium's loader lines are in
`~/.steam/steam/logs/console-linux.txt` under `me.tysmith.steam-native-notify`.

## Compatibility and known gaps

- Linux only, native Steam only (not Flatpak or Snap), with any FreeDesktop
  notification daemon that supports actions. Without action support the
  notification shows but the click does nothing.
- The 64-bit SteamRT3 client does not work: Millennium installs and reports
  success there, but its hook does nothing
  ([Millennium #840](https://github.com/SteamClientHomebrew/Millennium/issues/840)).
- A notification is clickable only while its popup is up; the copy in the
  notification centre is inert. quickshell 1.2 expires the popup after about
  8 seconds despite the no-timeout hint, which bounds the click window.
- Some server-sent types (wishlist sales, comments, and others) never toast
  unless enabled under Steam Settings > Notifications. Steam suppresses them
  before this plugin sees anything.
