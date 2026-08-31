# Platform support

Steam runs on Linux (native or Flatpak), macOS and Windows. This file is
where the plugin stands on each, what already branches per platform in the
code, and the plan for the platforms that do not deliver yet. Written to be
pasted into tracking issues. Every platform-specific claim carries a source
and a status: **verified** against a primary source (its own docs or code),
or **unverified**. Nothing here has run anywhere but native Linux.

## Matrix

| platform | status | delivery | click |
|---|---|---|---|
| Linux, native Steam | **shipped** | `notify-send` to the FreeDesktop daemon | `default` action, `.click` file, bridge |
| Linux, Flatpak Steam | paths ready; the host is unsupported by Millennium | same helper; inside the sandbox libnotify routes through the notification portal (plan) | same file contract; portal semantics unverified |
| macOS | backend paths ready; delivery refused, loudly | terminal-notifier `-execute` (plan) | `-execute` writes `.click` (plan) |
| Windows | backend paths ready; delivery refused, loudly | SnoreToast behind PowerShell (plan) | exit code 0 writes `.click` (plan) |

Refused means: the backend loads, logs `desktop delivery is not implemented
on <platform>` at load and `unsupported platform: <platform> delivery is not
implemented, notification dropped` per toast, and `Notify` answers
`"unsupported"`. Nothing is delivered and nothing is silent.

**One item comes before any delivery work on macOS or Windows.** The
frontend closes Steam's own toast (`hideSteamToast`, on by default) without
waiting for the backend's answer (`frontend/index.tsx`: `void notify(...)`,
then `win.close()`). On a refusing platform that swallows the toast and
delivers nothing. Gate the close on `Notify` resolving to `"ok"`. That is a
frontend change, so it needs Linux live verification (the repo's live-verify
skill) before it ships.

## What differs per platform

The frontend runs inside Steam's CEF and is OS-blind. The Lua backend and the
helper are the whole surface. Everything file-shaped lives in one runtime
directory per platform, and everything the backend knows and the helper
needs crosses in files there, never as a sixth argument: the five positional
slots (`title body image route ingame`) are the contract on every platform.

| piece | Linux | Linux, inside Steam's Flatpak sandbox | macOS | Windows |
|---|---|---|---|---|
| detection | `package.config` first char `/`, no `jit.os == "OSX"` | as Linux, plus `FLATPAK_ID` set | `jit.os == "OSX"`, else the SystemVersion.plist probe | `package.config` first char `\` |
| runtime directory | `$XDG_CACHE_HOME/steam-native-notify` (`~/.cache/...`) | `$XDG_CACHE_HOME` is `~/.var/app/com.valvesoftware.Steam/cache` there, so `.../cache/steam-native-notify` | `~/Library/Caches/steam-native-notify` | `%LOCALAPPDATA%\steam-native-notify` |
| `millennium.steam_path()` | `~/.steam/steam/` | `~/.steam/steam/` (resolves inside the sandbox) | `~/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS` | `HKCU\Software\Valve\Steam\SteamPath` |
| Steam data guesses, after `steam_path()` | `~/.steam/steam`, `~/.local/share/Steam`, then `~/.var/app/com.valvesoftware.Steam/{.local/share/Steam,.steam/steam}` | the same list; `$HOME`-relative entries resolve through `--persist=.` | `~/Library/Application Support/Steam` | none: the registry is the only source |
| helper spawn | `sh <helper> ... >/dev/null 2>&1 &` | same | same call would work; refused until the helper has a macOS branch | refused; `ffi` `CreateProcessW` with `CREATE_NO_WINDOW` (plan) |
| helper | `tools/notify-action` (POSIX sh, notify-send) | same, through the portal | Darwin branch of the same sh, terminal-notifier (plan) | `tools/notify-action.ps1` + `snoretoast.exe` (plan) |
| desktop entry / app identity | `steam` | `com.valvesoftware.Steam` | the sending bundle's identity | AUMID via a Start-menu shortcut (plan) |
| log | `<runtime>/plugin.log`; Millennium's loader lines in `~/.steam/steam/logs/console-linux.txt` | `<runtime>/plugin.log` in the per-app cache | `<runtime>/plugin.log` | `<runtime>\plugin.log` |
| dev tools | `tools/fire`, `tools/capture`, `tools/mep` | need a `--flatpak` path switch (plan) | need the macOS paths (plan) | `fire.ps1`, `capture.ps1` (plan) |

Files in the runtime directory: `plugin.log` (truncated at each backend
load; the helper appends its refusals there), `notify-action` (the
materialized helper, Linux only today), `steam-dir` (one line: Millennium's
`steam_path()` answer, rewritten at each load, removed when there is no
answer), `.click` and `.dev-fire` (consume-once handoffs), `icons/` (the
helper's avatar cache). `tools/test-backend` loads the backend three times,
under Linux, Windows and macOS configurations, and asserts every row above
that the backend owns.

### How the platform is detected

- **Windows:** `package.config`'s first line is the directory separator, `\`
  on Windows and `/` elsewhere; LuaJIT sets it like PUC Lua. **Verified:**
  [Lua 5.2 manual](https://www.lua.org/manual/5.2/manual.html#pdf-package.config),
  [LuaJIT lib_package.c](https://github.com/LuaJIT/LuaJIT/blob/v2.1/src/lib_package.c).
- **macOS:** `jit.os` is `"OSX"`. `jit.os` "Contains the target OS name:
  "Windows", "Linux", "OSX", "BSD", "POSIX" or "Other"". **Verified:**
  [LuaJIT jit.* library](https://luajit.org/ext_jit.html). Millennium's Lua
  host is LuaJIT and calls `luaL_openlibs`, which opens the `jit` library
  (the JIT compiler itself is switched off by default; the table stays).
  **Verified:**
  [src/lua_host/main.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/main.cc)
  (`#include <luajit.h>`, `luaL_openlibs(L)`, `luaJIT_setmode(... LUAJIT_MODE_OFF)`).
  **Unverified:** that the `jit` global reaches a plugin's `main.lua` on a
  macOS install; the backend falls back to opening
  `/System/Library/CoreServices/SystemVersion.plist`, which every macOS
  carries and no Linux does (a convention, not a documented contract:
  **unverified** as documentation, and untested because the test runner
  cannot create it). `tools/test-backend` plants a `jit` table for the macOS
  load. If both signals fail, the backend spawns the sh helper, which refuses
  on `uname -s` = `Darwin` with its own `plugin.log` line, so the failure is
  still loud.
- **Linux:** neither of the above. A BSD running Steam through Linux
  emulation reports as Linux, which is what its Steam is.
- **Flatpak sandbox:** flatpak sets `FLATPAK_ID` inside an app's sandbox
  (the per-app directory is `~/.var/app/$FLATPAK_ID`). **Verified:**
  [Sandbox Permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html).
  Logged in the load line (`platform: linux flatpak: com.valvesoftware.Steam
  runtime: ...`); the helper uses it for the desktop-entry name.
- Millennium's Lua API has no platform call; `millennium` exposes `ready`,
  `version`, `steam_path`, `get_install_path`, `call_frontend_method`,
  `cmp_version`, `is_plugin_enabled`, `config.*`, `assets.read`, and `utils`
  is arithmetic and time. **Verified:**
  [src/lua_host/api/types/millennium.lua](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/api/types/millennium.lua),
  [utils.lua](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/api/types/utils.lua).
  `fs.join(...)` exists in the stubs
  ([fs.lua](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/api/types/fs.lua));
  the backend keeps a three-line join of its own so the paths exist before
  any module can fail and the offline tests run the same code.

### Where `steam_path()` points

`millennium.steam_path()` reads `HKCU\Software\Valve\Steam\SteamPath` on
Windows (forward slashes, e.g. `C:/Program Files (x86)/Steam`, with a
`C:/Program Files (x86)/Steam` default when the key is unreadable), returns
`$HOME/.steam/steam/` on Linux, and on macOS
`$HOME/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS`.
**Verified:**
[src/system/filesystem.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/system/filesystem.cc).
The docs warn the Steam path "is not guaranteed to be the path Millennium is
installed to" ([docs](https://docs.steambrew.app/plugins/lua/millennium)),
which is fine: the files wanted are Steam's. The macOS answer is the app
bundle, not the data directory, which is why the backend and the helper both
keep `~/Library/Application Support/Steam` as the next candidate.

## Linux, native Steam: shipped

Everything in `docs/architecture.md` describes this platform. Two layout
facts the candidate order rests on:

- Valve's bootstrap makes `~/.steam/steam` a symlink to the install
  directory, `~/.local/share/Steam` on most distributions. **Verified** on
  this machine (`~/.steam/steam -> /home/<user>/.local/share/Steam`,
  2026-08-30).
- Debian's `steam-installer` installs into `~/.steam/debian-installation`
  and symlinks `~/.steam/steam` to it (`STEAMDIR="$HOME/.steam/debian-installation"`,
  `ln -fns "$STEAMDIR" "$STEAMCONFIG/steam"`). **Verified:**
  [debian/scripts/steam.in](https://sources.debian.org/src/steam-installer/1:1.0.0.87~ds-3/debian/scripts/steam.in/).
  The helper used to hard-code `~/.local/share/Steam`, which finds no
  library cache on such a system; `~/.steam/steam` now leads the guesses,
  behind the `steam-dir` the backend publishes (the same path).

The one visible change from the per-platform work: a library-cache icon now
resolves through `~/.steam/steam/appcache/librarycache/...` (Millennium's
answer) rather than `~/.local/share/Steam/appcache/librarycache/...`. Same
file, and the daemon copies it or reads it in place either way.

## Linux, Flatpak Steam: paths ready, host unsupported

### Status

Millennium: "We don't support Steam installed via Flatpak or Snap. We also
don't support any ARM based distributions". **Verified:**
[Installation](https://docs.steambrew.app/users/getting-started/installation).
Millennium hooks the Steam process, so a Millennium that supported Flatpak
Steam would run inside the sandbox, and so would this backend and its
helper. The code is ready for that shape; nothing has run in it.

### Sandbox facts

From Steam's Flathub manifest, **verified:**
[com.valvesoftware.Steam.yml](https://github.com/flathub/com.valvesoftware.Steam/blob/master/com.valvesoftware.Steam.yml):

- `--persist=.`: the whole home directory is persisted per app. Flatpak's
  rule: "A `--persist=.foo` bind mounts `~/.foo` inside the sandbox to
  `~/.var/app/$FLATPAK_ID/.foo` on host". Inside the sandbox `$HOME` keeps
  its name and `~/.local/share/Steam` works; on the host that directory is
  `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`. **Verified:**
  [Sandbox Permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html).
- "Inside the sandbox `$XDG_CACHE_HOME`, `$XDG_CONFIG_HOME` and
  `$XDG_DATA_HOME` is set to `$HOME/.var/app/$FLATPAK_ID/{cache, config,
  data}` respectively" (same page). So the runtime directory lands in
  `~/.var/app/com.valvesoftware.Steam/cache/steam-native-notify` with no
  code change, and Millennium's plugin directory (`$XDG_DATA_HOME/millennium/plugins`,
  **verified:**
  [src/system/environment.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/system/environment.cc))
  would be `~/.var/app/com.valvesoftware.Steam/data/millennium/plugins`.
  **Unverified:** starlight's `output_path = "auto"` writing there.
- `--talk-name=org.freedesktop.Notifications`: the daemon's bus name is
  reachable directly from the sandbox. `--socket=wayland`, `--socket=x11`,
  `--share=ipc` are also granted.
- `rename-desktop-file: steam.desktop`: the exported desktop file is
  `com.valvesoftware.Steam.desktop`, so the `desktop-entry` hint must say
  `com.valvesoftware.Steam` there. The helper does when `FLATPAK_ID` is
  Steam's, or when the Steam directory it found is the per-app one.
- `--env=FLATPAK_STEAM_XDG_DIRS_PREFIX=~/.var/app/com.valvesoftware.Steam`
  and a `steam_wrapper` that manages the XDG directories: the wrapper's exact
  symlinking of `~/.steam` is **unverified**. The helper and the backend try
  the per-app `.local/share/Steam` before the per-app `.steam/steam`, because
  a `~/.steam/steam` symlink created inside the sandbox points at an
  absolute `/home/<user>/.local/share/Steam`, which resolves inside but may
  dangle on the host.

### How delivery would go inside the sandbox

libnotify 0.8.0: "Use Desktop Portal Notification when running confined
(snap and flatpak). Now the library acts like a wrapper in such scenario,
with some limited capabilities". **Verified:**
[libnotify NEWS](https://gitlab.gnome.org/GNOME/libnotify/-/blob/master/NEWS).
So `notify-send` inside the sandbox goes through
`org.freedesktop.portal.Notification`, whatever `--talk-name` grants, if the
runtime's libnotify is 0.8 or later. **Unverified:** the libnotify version in
`org.freedesktop.Platform 25.08`, the runtime the manifest pins.

The portal (version 2): `AddNotification(id, vardict)`, an `ActionInvoked`
signal, and a `default-action` "that will be activated when the user clicks
on the notification"; icons are themed names, a sealed memfd holding PNG,
JPEG or SVG, or (deprecated) bytes. **Verified:**
[org.freedesktop.portal.Notification](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Notification.html).
What that changes, all **unverified** until run:

- `-A default=Open` should map onto the portal's default action and
  `notify-send` should still print `default` on activation; the click
  contract (`<epoch>|<payload>` into `.click`) is unchanged if so
- the `image-path` hint (a `file://` path) is not a portal concept; the
  portal wants the icon serialized, and a sandbox path means nothing to the
  host. libnotify 0.8.x "Improve reading images when inside a portal" (same
  NEWS) suggests it converts; the history-row survival that motivated the
  hint (`docs/architecture.md`) needs re-measuring
- `-t 0` (no expiry) has no portal equivalent; the banner lifetime is the
  desktop's, so the click window is whatever the desktop allows
- the `desktop-entry` hint is redundant: the portal brands from the app id

### Validation needs

A Flatpak Steam with a Millennium build inside it. None exists. When one
does: expect `platform: linux flatpak: com.valvesoftware.Steam runtime:
/home/<user>/.var/app/com.valvesoftware.Steam/cache/steam-native-notify`,
then `helper:`, then a `toast ... ->` line for any Steam toast; then a
banner; then a click printing `default`. `tools/capture` needs a `--flatpak`
switch that reads the per-app cache and log paths.

### Risks and open questions

- Snap Steam is a third layout (`~/snap/steam/common/.local/share/Steam`,
  **unverified**) that nothing here guesses; Millennium does not support it
  either. Left out until someone asks.
- A Millennium that runs on the host and reaches into a Flatpak Steam is not
  a shape Millennium has; the host-side candidates exist for tooling and for
  a helper run by hand (`tools/notify-action --resolve-icon`).
- Does the portal deliver the `default` action back through `notify-send`'s
  stdout in the same form? If not, the helper needs a portal-aware branch.

## macOS: backend paths ready, delivery planned

### Status

Millennium carries a macOS bootstrap in its tree (`src/bootstrap/macos/`,
`src/platform/macos.cc`, `scripts/macos/install_macos.sh`). **Verified:**
[Millennium/src/bootstrap/macos](https://github.com/SteamClientHomebrew/Millennium/tree/main/src/bootstrap/macos).
Its README badges list Windows and Linux only and the installation docs have
Windows and Linux sections only. **Verified:**
[README](https://github.com/SteamClientHomebrew/Millennium#readme),
[Installation](https://docs.steambrew.app/users/getting-started/installation).
**Unverified:** that a released Millennium runs on macOS, and which Steam
build (`Steam.AppBundle` in `filesystem.cc`, `Steam.app/Contents/MacOS/steam_osx`
in `environment.cc`; the two files disagree on the bundle name).

What the backend does today on macOS: detects the platform, logs
`platform: macos runtime: /Users/<user>/Library/Caches/steam-native-notify`,
publishes `steam-dir`, reports delivery as not implemented, refuses each
toast with `unsupported platform: macos`, and answers `"unsupported"`.
`Identity` finds `loginusers.vdf` under `~/Library/Application Support/Steam/config/`.

### Paths

- Millennium on macOS: plugins under `~/Library/Application Support/Millennium/plugins`,
  config and data under `~/Library/Application Support`, logs under
  `~/Library/Logs`. **Verified:**
  [src/system/environment.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/system/environment.cc).
- Runtime directory `~/Library/Caches/steam-native-notify`: Apple's rule for
  `~/Library/Caches` is "app-specific support files that your app can
  re-create easily", and `Application Support` is for data the user would
  miss. Everything here is re-creatable (the helper is re-materialized at
  load; icons re-download). **Verified:**
  [File System Programming Guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html).
- Steam data at `~/Library/Application Support/Steam`: Millennium's own
  constant (the bundle lives under it; `environment.cc` above). That
  `config/loginusers.vdf` and `appcache/librarycache/<appid>/` sit beneath it
  as on Linux is **unverified** on hardware; the client is one codebase, so
  the layout is expected, not proven.

### Delivery options

Three tools, in order of fit. All **verified** from their READMEs unless
marked.

1. **terminal-notifier 3.x** (recommended).
   [julienXX/terminal-notifier](https://github.com/julienXX/terminal-notifier),
   3.1.0 released 2026-08-30, rebuilt on Apple's `UserNotifications`
   framework because `NSUserNotification` was deprecated in macOS 11;
   requires macOS 10.14 or later.
   - `-execute COMMAND` is stored with the notification and runs through
     `/bin/sh -c` when the notification is clicked, "in the graphical
     session's environment", even after terminal-notifier has exited. That
     is the click: a one-line command that writes `<epoch>|<route>` to
     `.click.<pid>` and moves it over `.click`. No blocking, no `-A`. The
     notification survives in Notification Center; a click there after the
     bridge's 120 s window writes a click the bridge drops as stale, never
     a wrong action.
   - `-contentImage PATH` shows an image inside the notification: the game
     art or the avatar, resolved and cached exactly as on Linux.
   - `-appIcon` is gone: "macOS has no API to override a notification's
     icon. It always comes from the sending app's bundle". A custom icon is a
     custom copy of the app (`make icon ICON=... APP_NAME=...`), with its
     own bundle identifier and its own permission prompt. A copy named
     "Steam Notifications" with Steam's icon is the branding plan; the
     source icon (`Steam.app/Contents/Resources/*.icns`) is **unverified**.
   - `-action` waits and prints `@ACTIONCLICKED`, `@CLOSED`, `@TIMEOUT`
     (exit 6), the same shape as `notify-send --action`, if the `-execute`
     route proves unreliable.
   - Exit codes 3 (notifications not authorized), 4 (no GUI session), 5
     (service refused) name the failure for the log.
   - Banners auto-dismiss; keeping them until dismissed is the user's
     per-app alert style ("Alerts") in System Settings. The README says
     "macOS quarantines anything you download so the first run is blocked".
2. **alerter** ([vjeantet/alerter](https://github.com/vjeantet/alerter),
   v26.5, 2026-02-19, macOS 13 or later). Blocks and prints
   `@CONTENTCLICKED`, `@CLOSED`, `@TIMEOUT`, the exact `notify-send --wait`
   shape; `--app-icon` and `--content-image` go through a private API the
   README says "may break in future releases". Second choice.
3. **osascript `display notification`**: title, subtitle, sound name; no
   icon, no click callback. **Verified:**
   [Mac Automation Scripting Guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html).
   Last resort, unclickable by construction; the plugin would rather refuse.

### Shape

```
backend/main.lua      spawn_helper: sh <helper> ... & (as on Linux; IS_MACOS
                      stops refusing once the helper has its branch)
tools/notify-action   Darwin branch after the seams: resolve the icon as now,
                      then <app>/Contents/MacOS/terminal-notifier
                        -title -message -contentImage <icon>
                        -execute '<absolute-path-to-a-tiny-click-writer> <route>'
                      no blocking, exit 0 on a delivered banner
frontend/clickbridge.ts   unchanged
```

Decisions:

- **One sh helper, one Darwin branch.** macOS has `sh`, `curl`, `find`,
  `sed`, `mv`, `date +%s`. `sha1sum` is GNU; macOS ships `shasum`
  (**unverified** that `sha1sum` is absent): the cache key falls back to
  `shasum` when `sha1sum` is missing. The `LD_LIBRARY_PATH` scrub is
  harmless there; whether Steam's macOS launcher sets `DYLD_*` variables that
  poison `curl` is **unverified** and is checked in validation step 2.
- **The click writer is a separate tiny script**, materialized next to the
  helper, because `-execute` runs later in another environment: absolute
  paths only, no dependence on the helper's variables.
- **Retry:** none needed. terminal-notifier reports "not authorized" (3) and
  "no GUI session" (4) as exit codes; log them.
- **Focus:** macOS Focus modes (including the automatic gaming one) hold
  banners in Notification Center. **Unverified** which conditions are on by
  default; the same limitation text as Windows applies, and the
  `-execute` click still works from Notification Center within the bridge's
  window.

### Packaging

- An app bundle is a directory of files with a signed Mach-O inside;
  `millennium.assets.read` returns one file at a time and `io.open` cannot
  set an executable bit, so materializing a bundle means several writes plus
  an `os.execute("chmod +x ...")`. Whether an ad-hoc signature survives
  being rewritten file by file, and whether files written by the Lua host
  get a quarantine attribute (they should not: quarantine is stamped by
  downloading apps), are both **unverified**.
- The alternative that avoids all of it: require `brew install
  terminal-notifier` (or the `.app` in `/Applications`), find it on `PATH`
  or in `/opt/homebrew/bin`, and refuse with `terminal-notifier not found`
  when absent. Loud, zero packaging risk, and the user answers the
  permission prompt once. Start there; bundle later if it matters.
- The branded copy (custom icon) has to be built on a Mac (`make icon`);
  commit it or build it in a macOS CI job (whoever owns `.github/`).

### Validation

A macOS tester, in order. Pass signals are in
`~/Library/Caches/steam-native-notify/plugin.log`.

1. **Groundwork (this branch).** Build, install under
   `~/Library/Application Support/Millennium/plugins`, enable, restart Steam.
   Expect `platform: macos runtime: /Users/...`, `desktop delivery is not
   implemented on macos`, a `steam-dir` file, then `hook installed` and a
   `toast <name> -> {...}` line for any Steam toast. That proves capture,
   replay stashing and the ffi bridge on macOS, and whether `jit.os` reached
   the plugin (add `type(jit)` to the load log for this step).
2. **Helper environment.** With the Darwin branch reduced to `curl` of an
   avatar URL: confirm the download works from Steam's child environment.
3. **Delivery.** `tools/fire TestFriendOnline` (the macOS `tools/fire` writes
   `.dev-fire` under `~/Library/Caches`): expect a banner from
   terminal-notifier, then `TestDownloadComplete 1073390` for library art
   through `-contentImage`, `TestFriendMessage` for a CDN avatar, and a
   body with quotes, backslashes and non-ASCII text.
4. **Click.** Click the banner: expect `click-bridge: replay:<name>` and
   `replay: invoke ... returned without throwing`. Click the same
   notification in Notification Center after 120 s: expect `stale click
   dropped`.
5. **Branding.** Swap in the "Steam Notifications" copy; expect the name and
   icon on the banner and a new permission prompt.
6. **Focus.** Turn on a Focus, fire: expect no banner, an entry in
   Notification Center, and whatever exit code the helper logs; record it
   here.
7. **Real event.** `steam://uninstall/1073390` then `steam://install/1073390`.

### Effort

| item | estimate |
|---|---|
| frontend: close Steam's toast only on `"ok"` (shared with Windows) | 0.5 d |
| Darwin branch of `tools/notify-action`, click writer, `shasum` fallback | 1 d |
| `tools/fire` and `tools/capture` macOS paths | 0.5 d |
| branded terminal-notifier copy, or the Homebrew-only route | 0.5 to 1 d |
| validation pass, steps 1 to 7 | 1 d |

Three to four days with a Mac. Without one, only the first row.

### Open questions

- Does the `jit` global reach a plugin's Lua on Millennium's macOS build?
- Does Steam's macOS launcher set `DYLD_LIBRARY_PATH` or
  `DYLD_INSERT_LIBRARIES` for children, and does the system `curl` mind?
- Does a released Millennium run on macOS at all, and against which Steam
  bundle layout?
- Does `-execute` fire for a body click on a banner, or only from
  Notification Center? (The README says "when the notification is clicked".)

## Windows: backend paths ready, delivery planned

The plan for delivering Steam's toasts to Windows' own notification system.
Nothing here has run on Windows.

### Scope

- deliver every captured toast as a WinRT toast notification, with the
  artwork, and re-run Steam's own click handler when the banner is clicked
- keep the frontend, the click-file contract, and the log vocabulary
  unchanged, so `tools/capture`-style triage reads the same on every OS
- keep Linux delivery byte-for-byte as it is today

Non-goals:

- clicks from the Action Center after the banner has gone (phase 2, below)
- a signed installer, Start menu entry, or any per-machine setup beyond what
  the plugin can do itself at load
- 32-bit Windows

### Where things stand

The groundwork already on this branch: platform detection off
`package.config`, the per-OS runtime directory, `steam_path()`-first
discovery, the published `steam-dir`, binary-mode materialization, and the
`spawn_helper` seam whose Windows branch logs `unsupported platform` and
returns. A Windows install today fails in `plugin.log`, never silently.
`tools/test-backend` loads the backend under a Windows `package.config` and
asserts all of it.

### How the backend runs on Windows

These facts shape every decision below.

- Millennium runs each plugin's Lua backend in its **own child process**
  (`millennium_luavm`), a LuaJIT VM that talks to Steam over a socket. On
  Windows that executable is built `WIN32_EXECUTABLE TRUE`: GUI subsystem,
  no console. **Verified:**
  [src/lua_host/main.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/main.cc)
  (header comment: "standalone child process for a single plugin backend"),
  [src/lua_host/CMakeLists.txt](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/CMakeLists.txt).
  A blocking call in the backend therefore stalls this plugin's RPC loop
  (its own `TakeClick`/`TakeDevCommand` polls), not Steam's UI thread. The
  existing "never block the Steam UI thread" comments in `main.lua` overstate
  it; the constraint still holds because the bridge polls every second.
- LuaJIT is built 32-bit (`-m32`) with the vendored `LuaJIT.cmake`, whose
  `LUAJIT_DISABLE_FFI` defaults to `OFF`; a code search finds no override.
  **Unverified** that `require("ffi")` works inside a plugin: confirm with
  `pcall(require, "ffi")` on a Windows install before building on it.
  Sources:
  [thirdparty/forks/luajit/LuaJIT.cmake](https://github.com/SteamClientHomebrew/Millennium/blob/main/thirdparty/forks/luajit/LuaJIT.cmake),
  [src/CMakeLists.txt](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/CMakeLists.txt).
- `os.execute` is the C runtime's `system()`, which runs `cmd.exe`.
  **Verified:** [LuaJIT lib_os.c](https://github.com/LuaJIT/LuaJIT/blob/v2.1/src/lib_os.c)
  (`int stat = system(cmd)`),
  [system, _wsystem](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/system-wsystem)
  ("uses the COMSPEC and PATH environment variables to locate the
  command-interpreter file CMD.exe").
- `io.popen` and Millennium's `utils.exec` are `_popen`. Microsoft's own
  note: "If used in a Windows program, the `_popen` function returns an
  invalid file pointer that causes the program to stop responding
  indefinitely. `_popen` works properly in a console application."
  **Verified** as documentation:
  [_popen, _wpopen](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/popen-wpopen);
  **unverified** whether the modern CRT still behaves that way. Treat both
  as unusable from the GUI-subsystem host until proven otherwise.
- `millennium.yield_readable(fd)` parks a coroutine until an fd is readable,
  but the Windows build polls with `WSAPoll`, which takes sockets only. It
  cannot wait on a pipe or process handle. **Verified:**
  [src/include/millennium/plugin_ipc.h](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/include/millennium/plugin_ipc.h),
  [src/lua_host/rpc.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/rpc.cc).
- The stdlib has `http.download(url, path [, opts])`, streamed to disk by the
  parent process over RPC, alongside `http.get`. It is missing from the LSP
  stubs starlight generates. **Verified:**
  [src/lua_host/api/http.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/lua_host/api/http.cc).
- Plugins install to `<steam>\millennium\plugins` on Windows. **Verified:**
  [src/system/environment.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/system/environment.cc).
  **Unverified:** that starlight's `output_path = "auto"` resolves to that
  directory.

### The Windows helper

#### SnoreToast, what it actually does

[KDE/snoretoast](https://github.com/KDE/snoretoast) is a small C++ CLI over
the WinRT toast API. **Verified** from its README and source:

- **there is no `-w` flag.** It always blocks: `userAction()` waits on an
  event until the toast is clicked, dismissed, hidden, or times out, capped
  by `EVENT_TIMEOUT = 60 * 1000` ms
  ([snoretoasts.cpp](https://github.com/KDE/snoretoast/blob/master/src/snoretoasts.cpp)).
  This is the same blocking shape as `notify-send --action`, which is what
  the helper design needs; the correction only matters for the wrapper's
  argument list.
- the exit code is the action
  ([snoretoastactions.h](https://github.com/KDE/snoretoast/blob/master/src/snoretoastactions.h)):
  `0` Clicked (the README calls it Success), `1` Hidden, `2` Dismissed,
  `3` TimedOut, `4` ButtonPressed, `5` TextEntered, `-1` Error. A body click
  is `0`; the wrapper treats only `0` as a click.
- options are lowercased before matching; `-t` title, `-m` message,
  `-p <image>` "local files only", `-d short|long` (7 s or 25 s banner),
  `-id`, `-silent`, `-appID`, `-install <shortcut> <exe> <appID>`,
  `-pipeName`/`-application` for callbacks after the process has exited,
  `-close <id>`.
- without `-appID` it creates its own Start menu shortcut
  (`SnoreToast\<version>\SnoreToast.lnk`, AUMID
  `Snore.DesktopToasts.<version>`) and the toast is branded "SnoreToast".
  With an AUMID that is "not properly registered" it runs in a fallback
  mode with "no text replies or buttons" (comment in `snoretoasts.h`).
- LGPL-3.0, Windows 8 or later. Latest tag `v0.9.1`; KDE publishes only the
  source tarball (`snoretoast-v0.9.1.tar.bz2`, 2025-10-27, at
  `download.kde.org/stable/snoretoast/`) and the GitHub releases carry no
  binaries. `node-notifier` vendors `snoretoast-x64.exe` (2.5 MB) and
  `snoretoast-x86.exe` (2.0 MB) of an unstated version.

#### Shape

```
backend/main.lua      Notify -> write <id>.notify (five slots, JSON, UTF-8)
                      -> spawn_helper: powershell.exe -File notify-action.ps1 <id>.notify
tools/notify-action.ps1
                      read + delete the .notify file; read steam-dir
                      resolve the icon (<steam>\appcache\librarycache, or CDN download into icons\)
                      snoretoast.exe -t -m -p -appID -d long -id <id>
                      exit 0  -> write <epoch>|<route> to .click.<pid>, Move-Item -Force to .click
frontend/clickbridge.ts   unchanged: polls TakeClick, replays by toast name
```

Decisions, each with the reason:

- **Hand the payload over in a file, not on the command line.** Windows
  command lines are UTF-16 and parsed by the C runtime's own quoting rules;
  a chat message with quotes, backslashes, or non-ASCII would need a second
  quoting function and a codepage conversion. A JSON file in the runtime
  directory needs neither, and the command line stays ASCII apart from the
  two paths below. The five slots (title, body, image, route, ingame) stay
  the contract; only the transport changes, and only on Windows.
- **The Steam directory comes from `steam-dir`,** the same one-line file the
  Linux helper reads, published by the backend from `steam_path()` at load.
  One mechanism on every platform; the `.notify` file carries the five slots
  only.
- **Windows PowerShell 5.1, not pwsh.** It ships with every supported
  Windows; `pwsh` does not. Run with `-NoProfile -NonInteractive
  -ExecutionPolicy Bypass -File`.
- **`-d long`** (25 s). Linux uses `-t 0` (no expiry), which quickshell
  ignores at ~8 s. The banner is the click window on both OSes; 25 s is the
  most WinRT allows without a "scenario" flag.
- **Icon download without curl:** `Invoke-WebRequest -OutFile` into
  `icons\<sha1>.<ext>` with the same download-to-`.part`-then-rename and
  30-day prune as `tools/notify-action`. Game art needs no download:
  `steamloopback.host/assets/<appid>/<file>` maps to
  `<steam>\appcache\librarycache\<appid>\<file>`, the same layout as Linux.
  `-p` accepts local files only, so the file must exist before
  `snoretoast.exe` starts; there is no `file://` hint to learn.
- **`http.download` in the backend instead:** evaluated, deferred. It would
  drop the download from both helpers and the Linux loader-environment scrub
  with it, but it blocks the backend's single loop for up to the timeout
  (5 s) per notification, and it changes Linux delivery. Worth a separate
  experiment once Windows works: measure the stall, then decide for both
  OSes at once.
- **Click file byte-identical:** `<epoch-seconds>|<payload>`, written to a
  temp name and moved over `.click` (`Move-Item -Force` replaces atomically
  enough for a 1 s poll). Epoch via
  `[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()`. `TakeClick` reads and
  `os.remove`s it, unchanged.
- **Retry:** none. The WinRT notification platform is always up; a
  `-1` from `snoretoast.exe` is logged, not retried.
- **Log:** the wrapper appends nothing to `plugin.log`; `spawn_helper` logs
  the spawn, and a `--verbose` switch on the wrapper writes its own
  `helper.log` next door for triage.

#### AUMID

A desktop app cannot raise a toast without an AppUserModelID. **Verified:**
[How to enable desktop toast notifications through an AppUserModelID](https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid):
"Without a valid shortcut installed in the Start screen or in **All
Programs**, you cannot raise a toast notification from a desktop app." The
shortcut carries `System.AppUserModel.ID`; the toast shows that
registration's name and icon.

Options:

1. **Let SnoreToast self-register.** Zero work; toasts read "SnoreToast" with
   its icon. Unacceptable as shipped UX, fine for the first smoke test.
2. **Register our own shortcut at load** (recommended):
   `snoretoast.exe -install "Steam Notifications\Steam Notifications.lnk"
   "<steam>\steam.exe" "me.tysmith.steam-native-notify"`, once, idempotent
   (skip when the `.lnk` exists). The shortcut's target supplies the icon,
   so pointing it at `steam.exe` should brand the toast with Steam's logo
   under the name "Steam Notifications". **Unverified:** that the toast icon
   follows the shortcut target's icon rather than the registering process;
   confirm on hardware. Do not name it "Steam": Valve's own
   `Programs\Steam\Steam.lnk` already exists, and a second Start entry with
   the same name would sit next to it. `-install` also stamps SnoreToast's
   COM activator CLSID into the shortcut, which is what phase 2 needs.
3. **Registry-only registration** (`Software\Classes\AppUserModelId\<AUMID>`
   with `DisplayName` and `IconUri`). Microsoft documented this for
   "other types of unpackaged apps"; the page
   (`.../send-local-toast-other-apps`) returns 404 at the time of writing
   and a search snippet places the key under `HKLM`, which the plugin cannot
   write. **Unverified**; revisit if the shortcut proves fragile.

Uninstall: nothing removes the shortcut today. Record it in the README; a
`tools/uninstall.ps1` is a phase-2 nicety.

#### The console-window flash

`os.execute` runs `cmd.exe`, a console application, from a parent that has
no console. Windows gives it a new console window, which flashes and closes
per notification. `powershell.exe` is a console application too, so wrapping
does not help; the process must be created with `CREATE_NO_WINDOW`
("The process is a console application that is being run without a console
window"). **Verified** as documentation:
[Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags);
the flash itself is **unverified** on hardware but is the same failure every
Windows project that spawns `powershell.exe` from a GUI process reports.

Candidates, in order:

1. **LuaJIT `ffi` to `CreateProcessW` with `CREATE_NO_WINDOW`** (recommended).
   About forty lines of `ffi.cdef` (`STARTUPINFOW`, `PROCESS_INFORMATION`,
   `CreateProcessW`, `CloseHandle`, `MultiByteToWideChar` for the command
   line) in the Windows branch of `spawn_helper`. No `cmd.exe`, no extra
   binary, no console at all. The handles are closed immediately; the
   helper runs detached. Risk: a wrong `cdef` crashes the Lua host, which is
   its own process ("If we segfault the parent keeps running", `main.cc`).
   Gated on the `ffi` check above.
2. **A `spawn` primitive upstream in Millennium's `utils`**, with `hidden` and
   `detached` options. The right long-term answer for every plugin; slower,
   and this project would wait on a release. File the request either way.
3. **`wscript.exe` + `.vbs` (`Run cmd, 0, False`)**, the usual community
   trick, does not apply: it still has to be started by `os.execute`, and
   the `cmd.exe` that starts it is the flash.
4. **`utils.exec` / `io.popen`:** flashes, and carries the `_popen` hang
   warning. No.

If `ffi` turns out to be disabled, stop and pursue candidate 2 before
writing any wrapper code; a flashing console per notification is worse than
no delivery.

**Quoting the `CreateProcessW` call.** Both paths on the command line can
hold spaces and non-ASCII (`%LOCALAPPDATA%` carries the user name;
`%SystemRoot%` can be anywhere). Microsoft: with `lpApplicationName` NULL
"the module name must be the first white space–delimited token in the
lpCommandLine string. If you are using a long file name that contains a
space, use quoted strings", and the security remark: "do not pass NULL for
lpApplicationName". **Verified:**
[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw).
So: `lpApplicationName` is the full path of `powershell.exe`
(`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`),
`lpCommandLine` is built as `"<powershell.exe>" -NoProfile -NonInteractive
-ExecutionPolicy Bypass -File "<script>" "<notify-file>"` with every path in
double quotes (neither can contain a double quote: both live under
`%LOCALAPPDATA%` and `%SystemRoot%`, whose names Windows forbids `"` in),
converted UTF-8 to UTF-16 with `MultiByteToWideChar(CP_UTF8, ...)` into a
writable buffer (the W function may modify it). `tools/test-backend` asserts
the produced command line for a runtime directory with a space and one with
a non-ASCII user name when the branch lands.

#### Focus Assist and Do not disturb

Windows suppresses banners during games by default. **Verified:**

- Windows 10, Focus assist: "It's set by default to activate automatically
  when you're duplicating your display, playing a game, or using an app in
  full screen mode"; suppressed notifications are "redirected to Action
  Center"
  ([Focus: stay on task without distractions](https://support.microsoft.com/en-us/windows/focus-stay-on-task-without-distractions-in-windows-cbcc9ddb-8164-43fa-8919-b9a2af072382)).
- Windows 11, Do not disturb: automatic conditions include "When playing a
  game" and "When using an app in full-screen mode"; while on, "Other
  notifications are sent directly to the notification center until you
  turn it off"
  ([Notifications and Do Not Disturb in Windows](https://support.microsoft.com/en-us/windows/experience/notifications-and-do-not-disturb-in-windows)).
  **Unverified:** whether those two conditions are on by default on
  Windows 11; the page lists them without stating defaults.

What that means for the plugin, to be documented as a limitation rather
than worked around:

- the `notifyInGame` half of the value proposition is weaker on Windows:
  during a fullscreen game the toast lands silently in the notification
  center, and its click is inert once `snoretoast.exe` has returned
- the outside-game half works as on Linux, plus a persistent, scrollable
  history the Linux daemons mostly lack
- **unverified:** what `snoretoast.exe` returns when the banner is
  suppressed (TimedOut after the banner duration, or immediately). It
  decides whether the wrapper can tell "suppressed" from "ignored" for the
  log
- users who want in-game banners can clear the rule under Settings >
  System > Notifications; the README should say so and say nothing else

### Backend branch points

Already seamed on this branch; the Windows work fills them in:

- `spawn_helper`: replace the refusal with the `ffi` spawn; write the
  `.notify` file first
- `install_helper`: materialize a per-OS asset list
  (`tools/notify-action.ps1`, `tools/snoretoast.exe`). Skip the 2.5 MB
  rewrite when the installed file already matches the asset byte for byte:
  read both and compare the strings (`millennium.assets.read` already holds
  the asset in memory; a 2.5 MB comparison per load is nothing next to the
  write it saves). A size comparison is not enough: a revised script of the
  same length would never be rewritten.
- `on_load`: replace the "not implemented" error with the AUMID
  registration and a `helper: <path>` line, so `tools/capture`'s grep holds
- `shell_quote` stays POSIX-only and unused on Windows (the file transport
  needs no quoting)
- `TakeClick`/`TakeDevCommand`: unchanged; `os.remove` on Windows fails
  while the writer still holds the file, which the temp-and-move write
  rules out

### Packaging

- assets: add `tools/notify-action.ps1` and `tools/snoretoast.exe` to
  `[assets] resources` in `millennium.toml`. `millennium.assets.read`
  returns raw bytes and the backend writes in binary mode, so a packed
  executable survives; **unverified** that starlight packs a binary asset
  without mangling it (test: byte-compare after materialization, the same
  check `tools/test-backend` runs for the sh helper)
- the `.star` grows by about 2.5 MB; only the Windows load reads it
- x64 only. Steam is 32-bit on Windows, but the helper is a separate process
  and every supported Windows runs x64 binaries (natively or emulated)
- binary provenance: no official build exists. Either build `v0.9.1` from
  the KDE tarball in a Windows CI job (CMake + MSVC) and commit the
  artifact with its checksum, or vendor `node-notifier`'s binary and record
  its version. Ship `COPYING.LGPL` and a source link with it (LGPL-3.0)
- **unverified:** SmartScreen and Defender behaviour for an unsigned
  executable written by the Lua host and launched from it. The file has no
  Mark-of-the-Web, so SmartScreen should not prompt; Defender may quarantine
  a 2 MB unsigned binary, which shows as `-1` from the wrapper. A pinned
  checksum in the log line helps a tester tell the cases apart
- Windows Millennium version parity with the `.star` format (v3.5+):
  **unverified**

### Validation

What a Windows tester runs, in order. Each step has a pass signal in
`%LOCALAPPDATA%\steam-native-notify\plugin.log`.

1. **Groundwork (this branch, no helper yet).** Build with
   `bun run build` on Windows (starlight ships `starlight-win32-x64.exe`),
   confirm the `.star` under `<steam>\millennium\plugins`, enable the
   plugin, restart Steam. Expect `platform: windows runtime: C:\Users\...`
   and the `not implemented on windows` error at load; then `hook
   installed` and a `toast <name> -> {...}` line for any Steam toast. That
   proves capture, replay stashing, and the ffi bridge on Windows before a
   single line of delivery exists. Also confirms `pcall(require, "ffi")`
   (add it to the load log for this step).
2. **Spawn.** With the `ffi` spawn in place and the wrapper reduced to
   `exit 0`: fire a toast, expect a `spawn:` line, and no console flash.
   `Get-Process conhost` count before and after is the objective check.
3. **Delivery.** Wrapper complete, SnoreToast self-registered (option 1):
   `tools\fire.ps1 TestFriendOnline`, expect a banner. Then
   `TestDownloadComplete 1073390` for library art, `TestFriendMessage` for a
   CDN avatar, and a body with quotes, backslashes, and non-ASCII text.
4. **Click.** Click the banner within 25 s: expect `click-bridge:
   replay:<name>` and `replay: invoke ... returned without throwing`, and
   Steam doing what its own toast click does. Click after the banner is
   gone: expect nothing (phase 2 territory).
5. **Branding.** Register the shortcut (option 2), restart Steam, repeat
   step 3; the toast reads "Steam Notifications" with Steam's icon.
6. **Focus Assist.** Launch a fullscreen game, fire a toast: expect no
   banner, an entry in the notification center, and whatever exit code the
   wrapper logs; record it in this file. Clear the rule, repeat.
7. **Real event.** `steam://uninstall/1073390` then
   `steam://install/1073390`, the only self-service real trigger.
8. **Restart cycle.** Rebuild, restart Steam, confirm the helper is
   rewritten only when its bytes changed.

Tooling for the tester, all PowerShell, all writing the same JSON the Linux
tools write:

- `tools\fire.ps1 <TestMethod> [args]`, `-Server <type> <json>`,
  `-Replay inspect|invoke`: writes `.dev-fire` under `%LOCALAPPDATA%`
- `tools\capture.ps1`: the `.star` mtime versus Millennium's loader log
  under `<steam>\millennium\logs`, then the same grep vocabulary over
  `plugin.log`
- Steam restart: `steam.exe -shutdown`, wait, relaunch; the "full restart
  for any change" rule is assumed to hold on Windows (**unverified**)

### Effort

Estimates assume a Windows machine with Steam and Millennium, and one
person. Without the machine, only the first item is possible.

| item | estimate | notes |
|---|---|---|
| frontend: close Steam's toast only on `"ok"` | 0.5 d | shared with macOS; needs Linux live verification |
| `ffi` spawn with `CREATE_NO_WINDOW`, `.notify` transport | 1 to 2 d | blocked on the `ffi` check |
| `notify-action.ps1`: icon resolve, cache, prune, snoretoast, click file | 1 to 2 d | mirror of `tools/notify-action` |
| AUMID shortcut registration and branding | 0.5 to 1 d | includes the icon question |
| packaging: binary build or vendoring, assets, byte-compared materialization | 1 d | CI job belongs to whoever owns `.github/` |
| `fire.ps1`, `capture.ps1` | 0.5 d | |
| README and architecture updates, limitation text | 0.5 d | |
| validation pass, steps 1 to 8 | 1 to 2 d | |

Six to ten days end to end.

### Risks

- `ffi` disabled in Millennium's LuaJIT: no console-free spawn exists from
  Lua; the work stalls on an upstream `utils.spawn`
- SnoreToast binary provenance and antivirus reaction to an unsigned
  executable launched by Steam's child process
- Windows Steam's toast popups may not use the `notificationtoasts_` names
  or the same fiber conventions; step 1 of validation finds out before any
  delivery work is spent
- the toast icon may not follow the shortcut's target; fallback is
  SnoreToast's own icon or a bundled `.ico`
- `Move-Item -Force` over a file the bridge is mid-read: the bridge polls at
  1 s and reads whole files, so a torn read is a dropped click, not a wrong
  one
- Windows path length and codepage: every path the plugin builds stays
  under `%LOCALAPPDATA%` and ASCII except the user name; the wrapper reads
  the `.notify` file and `steam-dir` as UTF-8 explicitly

### Open questions

- does `require("ffi")` work inside a Millennium plugin backend on Windows?
- what does `snoretoast.exe` return when Focus Assist suppresses the banner,
  and how long does it block?
- does the toast take the shortcut target's icon (`steam.exe`) or the
  registering process's?
- does starlight pack a 2.5 MB binary asset intact, and does
  `output_path = "auto"` land in `<steam>\millennium\plugins` on Windows?
- is the `_popen` hang warning real on the current CRT? (only matters if
  the `ffi` route fails)
- `http.download` for both platforms: what is the measured stall per
  notification, and is it acceptable on Linux?
- phase 2: `snoretoast -application <exe>` launches a program when the
  toast is activated after the process has exited. Pointing it at a tiny
  script that writes `.click` would make notification-center clicks work
  for the bridge's 120 s window, which Linux cannot offer. Needs the COM
  activator from `-install`, and a look at what arguments it passes.
