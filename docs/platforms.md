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
| Windows | **EXPERIMENTAL**: delivery shipped, unvalidated on real hardware | WinRT toast via notify-action.ps1 (Windows PowerShell 5.1, no vendored binary) | protocol activation: the snn: URI scheme's handler writes `.click` |

Refused (macOS today) means: the backend loads, logs `desktop delivery is
not implemented on <platform>` at load and `unsupported platform: <platform>
delivery is not implemented, notification dropped` per toast, and `Notify`
answers `"unsupported"`. Nothing is delivered and nothing is silent.

**Shipped:** the frontend closes Steam's own toast only after `Notify`
answers `"ok"` (frontend/index.tsx), so a platform that cannot deliver -- or
a failed spawn anywhere -- leaves Steam's own toast alone instead of
swallowing the notification. Linux live verification rides the branch that
shipped it.

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
| helper spawn | `sh <helper> ... >/dev/null 2>&1 &` | same | same call would work; refused until the helper has a macOS branch | `ffi` `CreateProcessW` with `CREATE_NO_WINDOW`, payload in a `<id>.notify` file (EXPERIMENTAL) |
| helper | `tools/notify-action` (POSIX sh, notify-send) | same, through the portal | Darwin branch of the same sh, terminal-notifier (plan) | `tools/notify-action.ps1` (WinRT toast) + `tools/click-handler.js` (snn: URI handler), no vendored binary (EXPERIMENTAL) |
| desktop entry / app identity | `steam` | `com.valvesoftware.Steam` | the sending bundle's identity | registry-only AUMID under HKCU, icon extracted from the user's steam.exe (EXPERIMENTAL) |
| log | `<runtime>/plugin.log`; Millennium's loader lines in `~/.steam/steam/logs/console-linux.txt` | `<runtime>/plugin.log` in the per-app cache | `<runtime>/plugin.log` | `<runtime>\plugin.log` |
| dev tools | `tools/fire`, `tools/capture`, `tools/mep` | need a `--flatpak` path switch (plan) | need the macOS paths (plan) | `fire.ps1`, `capture.ps1` (plan) |

Files in the runtime directory: `plugin.log` (truncated at each backend
load; the helper appends its refusals there), the materialized helper
(`notify-action` on Linux; `notify-action.ps1` plus `click-handler.js` on
Windows), `steam-dir` (one line: Millennium's `steam_path()` answer,
rewritten at each load, removed when there is no answer), `.click` and
`.dev-fire` (consume-once handoffs), `icons/` (the helper's avatar cache),
and on Windows `<id>.notify` payload files (helper-consumed), `steam.ico`
(the extracted branding icon) and `.wpn-backoff` (the platform-wedge
back-off stamp). `tools/test-backend` loads the backend under Linux,
Windows (with and without a stubbed ffi) and macOS configurations, and
asserts every row above that the backend owns.

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
  `cmp_version`, `is_plugin_enabled`, `config.*`, `assets.read`. `utils`
  carries arithmetic and time plus `getenv`/`setenv`, `exec`,
  `url_encode`/`hex_encode`/`base64_encode`, `uuid`, `hash` and file
  read/write helpers (`exec` is `_popen`-backed, which is why the Windows
  spawn does not use it). **Verified:**
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
| frontend: close Steam's toast only on `"ok"` -- shipped with the Windows branch | done |
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

## Windows: EXPERIMENTAL delivery shipped, unvalidated

Every piece below ships in the plugin, and none of it has run on a real
Windows machine. The backend says so at load ("windows delivery is
EXPERIMENTAL and unvalidated"), README carries the same warning, and the
validation pass at the end is the gate out of the mark.

An earlier draft vendored SnoreToast behind a Start-menu shortcut. An
adversarial review took that apart against primary sources: the shortcut
requirement is Windows-8-era documentation that Microsoft's own
ToastNotificationManagerCompat no longer follows (it registers a per-user
registry key), and nothing in the click contract needs a process waiting on
the toast. What ships instead is native end to end: no vendored binary, no
shortcut, every registration per-user and reversible.

### Scope

- deliver every captured toast as a WinRT toast notification, with the
  artwork, and re-run Steam's own click handler when the banner is clicked
- keep the frontend, the click-file contract, and the log vocabulary
  unchanged, so capture-style triage reads the same on every OS
- keep Linux delivery byte-for-byte as it is today

Non-goals: a signed installer, a Start-menu entry, or any per-machine setup
beyond what the plugin does itself at load; 32-bit Windows.

### Shape

    backend (main.lua), one per notification
      writes <id>.notify      the five slots as JSON; a file, not a command
                              line, so quoting stays out of the contract
      CreateProcessW          LuaJIT ffi, CREATE_NO_WINDOW. os.execute is
                              the CRT's system(), which runs cmd.exe and
                              flashes a console from Millennium's
                              GUI-subsystem host; io.popen is _popen,
                              documented to hang in GUI programs. Without
                              ffi this degrades to a log line.
        powershell.exe -File notify-action.ps1 -Id <id>
          reads + deletes <id>.notify
          resolves the icon   library cache via the published steam-dir;
                              CDN avatars downloaded once, sha1-named,
                              30-day prune -- the POSIX helper's scheme
          re-encodes >190KB   Windows drops oversized toast images
                              SILENTLY; a 256px PNG re-encode keeps
                              Steam's JPEG art visible
          builds ToastGeneric appLogoOverride, hint-crop="circle" for
                              avatars; activationType="protocol"
                              launch="snn:replay/<toast-name>" only when a
                              route exists -- no route, no launch: the
                              click only dismisses, mirroring Steam
          Show(), exit        no waiting process, ever

    a click (banner; Action Center too if persistence holds, see pass 7)
      Windows ShellExecutes the snn: handler registered at setup:
        wscript //B click-handler.js "snn:replay/<name>"
          validates ^snn:replay/[A-Za-z0-9_.-]+$   the one security-
                              sensitive line: the argument arrives through
                              the shell, so anything else is dropped
          writes <epoch>|replay:<name> -> .click.tmp -> .click
      the in-Steam bridge consumes it exactly as on Linux

Only `replay:` routes carry on Windows, which is not a loss: the bridge
refuses every other shape on Linux too (`click-bridge: unbridgeable route`),
and the frontend has emitted nothing but replay tokens since the routing
catalog left. The POSIX helper writes any non-empty route to the click file
and lets the bridge refuse; the Windows toast simply omits the launch
attribute instead, so the click dismisses -- same outcome, decided one step
earlier.

### Setup, run at every load (idempotent, reversible)

`notify-action.ps1 -Setup`, spawned by on_load:

- `HKCU\Software\Classes\AppUserModelId\me.tysmith.steam-native-notify`:
  `DisplayName` "Steam", `IconUri` an icon extracted from the user's own
  steam.exe (System.Drawing) -- branding without shipping Valve artwork and
  without a Start-menu shortcut. HKCU merges over HKLM in the classes view,
  so no elevation. This is the registration Microsoft's compat layer
  performs.
- `HKCU\Software\Classes\snn`: `URL Protocol` plus `shell\open\command`
  pointing wscript at the materialized click-handler.js.
- `-Teardown` removes both keys and the icon; nothing else is left behind.

### Facts under the design (sourced by the adversarial review)

- An AUMID string is required to Show(); a *registered* one is required
  only for branding. Registry-only registration is what
  ToastNotificationManagerCompat performs; the Start-menu-shortcut
  requirement is Windows-8-era text.
- Protocol activation is the documented path for unpackaged apps: banner
  (and Action Center) clicks ShellExecute the launch URI with no COM
  activator and no living sender ("ToastGeneric Protocol: Supported").
- Windows PowerShell 5.1, never pwsh: .NET 5+ removed WinRT projection
  (PlatformNotSupportedException). In-process add_Activated events on 5.1
  are folklore -- BurntToast gates them to pwsh 7.1+ -- which is why clicks
  ride the URI scheme instead of a waiting process.
- The notification platform can wedge under bursts ("The notification
  platform is unavailable"; documented recovery is a service restart or a
  reboot). After one such failure the helper drops sends for 60 s, one log
  line each, instead of hammering the service.
- `scenario="urgent"` exists in the toast schema to break through Focus
  Assist per app -- the documented answer to in-game suppression. Not sent
  yet; first candidate once validation passes.

### Validation pass (the gate out of EXPERIMENTAL; about one sitting)

Order matters: the first two decide the design, the rest exercise it.

1. `pcall(require, "ffi")` in the plugin backend -- the load log already
   answers it. Missing: fall back to a resident helper (one console flash
   per session) or an upstream utils.spawn; stop here.
2. A protocol toast with no stub CLSID: click the banner, confirm the snn:
   handler ran (`.click` appears). The whole click design rests on this
   one experiment.
3. The toast appears, branded "Steam" with the extracted icon
   (registry-only AUMID).
4. Library-cache art and a CDN avatar both render; an oversized JPEG
   re-encodes rather than vanishing.
5. Click -> `.click` -> bridge consumes -> `replay: invoke` in the log,
   with Steam focused.
6. hideSteamToast: Steam's own toast closes only after `Notify` answers
   "ok"; on a failed spawn it stays open.
7. Action Center: does the toast persist, and does a click there still
   protocol-activate? Expected to need the stub-CLSID registration; if so
   it is one more HKCU key in -Setup.
8. Focus Assist on, game fullscreen: confirm suppression, then retest with
   `scenario="urgent"`.
9. `-Teardown` leaves no keys and no icon behind.

### Open questions

- does `require("ffi")` work inside a Millennium plugin backend on Windows?
- does a banner click protocol-activate with no stub CLSID registered?
- does `Get-StartApps` show a Steam AUMID? (Not to borrow -- muting Steam
  in Windows settings would then mute the plugin whose job is replacing
  Steam's toasts -- but to know the namespace.)
- what are the real local-image limits on current Windows 10/11; is the
  190 KB re-encode threshold right?
- Constrained Language Mode / WDAC machines kill the script route outright;
  is that population worth a fallback?

### Effort remaining

| item | estimate |
|---|---|
| validation pass 1-9 on a Windows machine | 1 d |
| fixes it surfaces (stub CLSID, image limits, quoting) | 0.5-1 d |
| `fire.ps1` / `capture.ps1` tester tooling | 0.5 d |

The implementation is shipped; a day or two with hardware stands between
this section and dropping the EXPERIMENTAL mark.
