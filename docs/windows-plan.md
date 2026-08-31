# Windows support

The plan for delivering Steam's toasts to Windows' own notification system,
and the current state of the code. Written to be pasted into a tracking
issue. Nothing here has run on Windows; every Windows-specific claim carries
a source and a status (**verified** against a primary source, or
**unverified**).

## Scope

- deliver every captured toast as a WinRT toast notification, with the
  artwork, and re-run Steam's own click handler when the banner is clicked
- keep the frontend, the click-file contract, and the log vocabulary
  unchanged, so `tools/capture`-style triage reads the same on both OSes
- keep Linux delivery byte-for-byte as it is today

Non-goals:

- clicks from the Action Center after the banner has gone (phase 2, below)
- macOS (Millennium supports it; nothing here rules it out, nothing plans it)
- a signed installer, Start menu entry, or any per-machine setup beyond what
  the plugin can do itself at load
- 32-bit Windows

## Where things stand

Everything platform-specific is delivery-side. The frontend runs inside
Steam's CEF and is OS-blind. The Lua backend and the helper are the whole
surface:

| piece | Linux today | Windows |
|---|---|---|
| runtime directory | `$XDG_CACHE_HOME/steam-native-notify` | `%LOCALAPPDATA%\steam-native-notify` (done) |
| helper materialization | `io.open(.., "wb")` from a packed asset | same call; a different asset (planned) |
| helper spawn | `os.execute("sh <helper> ... &")` | `spawn_helper` refuses and logs (done); real spawn (planned) |
| helper | `tools/notify-action` (POSIX sh, notify-send) | `tools/notify-action.ps1` + `snoretoast.exe` (planned) |
| click handoff | `<epoch>\|<payload>` in `.click` | identical (planned) |
| steamid discovery | `~/.steam/...` guesses | `millennium.steam_path()` first, both OSes (done) |

The groundwork already on this branch: platform detection off
`package.config`, the per-OS runtime directory, `steam_path()`-first
discovery, binary-mode materialization, and the `spawn_helper` seam whose
Windows branch logs `unsupported platform` and returns. A Windows install
today fails in `plugin.log`, never silently. `tools/test-backend` loads the
backend a second time under a Windows `package.config` and asserts all of it.

**First work item, before any helper:** the frontend closes Steam's own toast
(`hideSteamToast`, on by default) without waiting for the backend's answer.
On Windows today that would swallow the toast and deliver nothing. Gate the
close on `Notify` resolving to `"ok"`. That is a frontend change, so it needs
Linux live verification (the repo's live-verify skill).

## How the backend runs on Windows

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
- `millennium.steam_path()` reads `HKCU\Software\Valve\Steam\SteamPath` on
  Windows (forward slashes, e.g. `C:/Program Files (x86)/Steam`) and returns
  `$HOME/.steam/steam/` on Linux. Plugins install to
  `<steam>\millennium\plugins` on Windows and
  `$XDG_DATA_HOME/millennium/plugins` on Linux. **Verified:**
  [src/system/filesystem.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/system/filesystem.cc),
  [src/system/environment.cc](https://github.com/SteamClientHomebrew/Millennium/blob/main/src/system/environment.cc);
  the docs warn the Steam path "is not guaranteed to be the path Millennium
  is installed to" ([docs](https://docs.steambrew.app/plugins/lua/millennium)).
  **Unverified:** that starlight's `output_path = "auto"` resolves to that
  Windows directory.
- `package.config`'s first line is the directory separator, `\` on Windows
  and `/` elsewhere; LuaJIT sets it. **Verified:**
  [Lua 5.2 manual](https://www.lua.org/manual/5.2/manual.html#pdf-package.config),
  [LuaJIT lib_package.c](https://github.com/LuaJIT/LuaJIT/blob/v2.1/src/lib_package.c).

## The Windows helper

### SnoreToast, what it actually does

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

### Shape

```
backend/main.lua      Notify -> write <id>.notify (five slots, JSON, UTF-8)
                      -> spawn_helper: powershell.exe -File notify-action.ps1 <id>.notify
tools/notify-action.ps1
                      read + delete the .notify file
                      resolve the icon (librarycache path, or CDN download into icons\)
                      snoretoast.exe -t -m -p -appID -d long -id <id>
                      exit 0  -> write <epoch>|<route> to .click.<pid>, Move-Item -Force to .click
frontend/clickbridge.ts   unchanged: polls TakeClick, replays by toast name
```

Decisions, each with the reason:

- **Hand the payload over in a file, not on the command line.** Windows
  command lines are UTF-16 and parsed by the C runtime's own quoting rules;
  a chat message with quotes, backslashes, or non-ASCII would need a second
  quoting function and a codepage conversion. A JSON file in the runtime
  directory needs neither, and the command line stays ASCII. The five slots
  (title, body, image, route, ingame) stay the contract; only the transport
  changes, and only on Windows.
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
  `<steam>\appcache\librarycache\<appid>\<file>`, the same layout as Linux
  (the wrapper takes `<steam>` from the `.notify` file, which the backend
  fills from `steam_path()`). `-p` accepts local files only, so the file
  must exist before `snoretoast.exe` starts; there is no `file://` hint to
  learn.
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

### AUMID

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

### The console-window flash

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

### Focus Assist and Do not disturb

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

## Backend branch points

Already seamed on this branch; the Windows work fills them in:

- `spawn_helper`: replace the refusal with the `ffi` spawn; write the
  `.notify` file first
- `install_helper`: materialize a per-OS asset list
  (`tools/notify-action.ps1`, `tools/snoretoast.exe`); compare
  `millennium.assets.size` with `fs.file_size` and skip the 2 MB rewrite
  when the sizes match
- `on_load`: replace the "not implemented" error with the AUMID
  registration and a `helper: <path>` line, so `tools/capture`'s grep holds
- `shell_quote` stays POSIX-only and unused on Windows (the file transport
  needs no quoting)
- `TakeClick`/`TakeDevCommand`: unchanged; `os.remove` on Windows fails
  while the writer still holds the file, which the temp-and-move write
  rules out

## Packaging

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

## Validation

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
   rewritten only when its size changed.

Tooling for the tester, all PowerShell, all writing the same JSON the Linux
tools write:

- `tools\fire.ps1 <TestMethod> [args]`, `-Server <type> <json>`,
  `-Replay inspect|invoke`: writes `.dev-fire` under `%LOCALAPPDATA%`
- `tools\capture.ps1`: the `.star` mtime versus Millennium's loader log
  under `<steam>\millennium\logs`, then the same grep vocabulary over
  `plugin.log`
- Steam restart: `steam.exe -shutdown`, wait, relaunch; the "full restart
  for any change" rule is assumed to hold on Windows (**unverified**)

## Effort

Estimates assume a Windows machine with Steam and Millennium, and one
person. Without the machine, only the first item is possible.

| item | estimate | notes |
|---|---|---|
| frontend: close Steam's toast only on `"ok"` | 0.5 d | needs Linux live verification |
| `ffi` spawn with `CREATE_NO_WINDOW`, `.notify` transport | 1 to 2 d | blocked on the `ffi` check |
| `notify-action.ps1`: icon resolve, cache, prune, snoretoast, click file | 1 to 2 d | mirror of `tools/notify-action` |
| AUMID shortcut registration and branding | 0.5 to 1 d | includes the icon question |
| packaging: binary build or vendoring, assets, size-checked materialization | 1 d | CI job belongs to whoever owns `.github/` |
| `fire.ps1`, `capture.ps1` | 0.5 d | |
| README and architecture updates, limitation text | 0.5 d | |
| validation pass, steps 1 to 8 | 1 to 2 d | |

Six to ten days end to end.

## Risks

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
  the `.notify` file as UTF-8 explicitly

## Open questions

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
