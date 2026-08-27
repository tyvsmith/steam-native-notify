# steam-native-notify

Mirrors Steam's in-client notification toasts to the desktop notification
daemon, so they land in your notification centre with everything else.

Status: **prototype**. Text extraction, image resolution, and the click bridge
are verified working against a live Steam. The action replay is built but has
never run, because Steam's notification feed has not yet been observed firing.

## Why this has to be a plugin

Steam draws every notification as its own top-level XWayland window titled
`notificationtoasts_<N>_desktop`. That title is the only text outside the
process — the message a person reads is rendered inside CEF. A compositor rule
can move, hide, or float that window, but it cannot read it.

Nothing else on the system can either, which was checked rather than assumed:

- **AT-SPI** — Steam publishes no accessibility tree. Chromium only builds one
  when asked via `--force-renderer-accessibility`, and Steam exposes no way to
  pass it.
- **Steam's logs** — every `notification` string in `~/.steam/steam/logs/` is
  `OnAppLifetimeNotification`, a game session event. Toast text is never logged.

So the reader has to run where the DOM is. Two places qualify: inside Steam's JS
context (this plugin), or attached to Steam's CEF debugger over CDP. This is the
first.

## How it works

```
g_PopupManager
  └─ AddPopupCreatedCallback
       └─ popup.window.name starts with "notificationtoasts_"
            └─ poll document.body.innerText until it paints
                 └─ callable('Notify') → backend/main.lua → notify-send
```

`g_PopupManager` is not public API. It is what
[kitsune-notifications](https://github.com/K1tsune12/kitsune-notifications) uses
to find the same windows in order to reposition them, which is the only reason
to rely on it. If Valve renames it the hook retries for 30 seconds and then goes
quiet — no exceptions thrown into Steam's UI.

The frontend polls for painted text rather than waiting a fixed delay, so a slow
frame delays a notification instead of dropping it.

## Build

```bash
npm install
npm run build     # writes .millennium/Dist/index.js
```

`pnpm` works too if you have it; the scripts only shell out to `millennium-ttc`.

## Install

Millennium loads plugins from `~/.local/share/millennium/plugins/`. Build first —
the compiled bundle is what gets loaded, not the TypeScript.

```bash
npm run build
ln -s ~/Code/steam-native-notify ~/.local/share/millennium/plugins/steam-native-notify
```

If Millennium does not pick up the symlink, copy the directory instead. It needs
`plugin.json`, `backend/`, and `.millennium/`; `frontend/` and `node_modules/`
are build-time only.

Then restart Steam and enable **Steam Native Notify** under Millennium →
Plugins.

## Verify

Trigger a notification without waiting for a friend — start or finish any
download, or have someone message you. A native notification should appear
alongside Steam's own toast.

The prototype logs every toast it sees. Watch Millennium's log for
`[steam-native-notify]` lines to confirm what text was extracted and how it was
split into title and body.

## Once it works: stop the double-reporting

Both notifications fire until Steam's own toast is suppressed. It cannot simply
be turned off — Steam's notification settings suppress the *event*, and then
there is nothing left to read.

The trick is that this plugin reads the DOM, not the screen, so the toast can be
banished somewhere it is never composited and still be read in full. In
`~/Code/dotfiles/dot_config/hypr/apps.lua`, replace the `steam_toasts` entry:

```lua
{
  id        = "steam_toasts",
  match     = { class = "^steam$", title = "^notificationtoasts_\\d+_desktop$" },
  workspace = "special:hidden",
  silent    = true,
  rules     = { no_focus = true, no_initial_focus = true },
},
```

Same hidden workspace the HELLDIVERS GameGuard window already uses. Do this
**after** native notifications are confirmed working, not before — until then it
only makes notifications invisible.

## What to test

Work down this list; each step only makes sense if the one above it passed.

1. **It fires at all.** Trigger any notification — start or finish a download,
   or have someone message you. Expect a native notification alongside Steam's
   own toast. If nothing appears, check Millennium's log for
   `[steam-native-notify] hook installed`; its absence means `g_PopupManager`
   was never found.

2. **The title/body split is right, per notification type.** This is the one
   real guess in the plugin, and different toasts have different shapes. Cover
   at least: a chat message, a friend coming online (needs
   `Notifications_ShowOnline` turned back on in Steam's settings — it is
   currently off), a download completing, and an event or announcement. The
   probe logs the extracted text next to the split it chose.

3. **Markup and punctuation survive.** Have someone send a message containing
   `<`, `>`, or `&`. The daemon here parses the body as markup, so these are
   escaped before sending; the test is that they arrive looking like what was
   typed rather than vanishing.

4. **No duplicates, nothing dropped.** Two notifications in quick succession
   should produce exactly two natives. A very fast one should not be lost —
   the reader polls for up to ~1.2s for the toast to paint.

5. **Lifecycle.** Disable and re-enable the plugin from Millennium; restart
   Steam; leave Steam closed for a while. Nothing should error, and the hook
   should reinstall on the next start.

6. **The probe output.** One good capture answers both open features below.
   Look for `probe <name> images=`, `links=`, and `backgrounds=` lines in the
   log. Paste one over and the click action and image work can be designed
   against real data instead of guesses.

## Not yet preserved

Two things Steam's own toast does that this does not, both by omission rather
than by choice.

### Click action

Steam's toast is clickable and opens the relevant thing — the chat, the
downloads page, the event. This bridge produces a notification that does
nothing when clicked.

The obvious fix does not work. Replaying the click on the toast's DOM element
would run Steam's own handler exactly, but Steam destroys the popup roughly five
seconds after it appears, and the notification daemon here advertises
`persistence` — the native notification is designed to outlive that. By the time
anyone clicks, the DOM and its handler are gone.

What can work is extracting the *intent* while the toast is still alive and
turning it into a `steam://` route that survives independently:

```
chat message      -> steam://friends/message/<steamid>
download finished -> steam://open/downloads
event             -> steam://url/...
```

The delivery side is already available: `notify-send -A default=Open` prints the
action name to stdout when clicked, and the daemon advertises `actions`. Because
`-A` implies `--wait`, it must not be run from the Lua backend directly — that
would tie the backend up for the notification's lifetime. A detached one-liner
handles it without any callback into Steam:

```sh
sh -c 'a=$(notify-send -A default=Open ...); [ "$a" = default ] && steam "<url>"' &
```

Step 6 of the test list decides whether the route is recoverable at all — that
is what the `links=` probe is looking for.

### Image

Steam shows the sender's avatar or the game's capsule art. `innerText` drops
images by definition, so nothing is carried over.

The route is to read the URL from the DOM — `<img>.src`, or a computed
`background-image`, which is what the `images=` and `backgrounds=` probes
collect — download it to a cache directory, and pass the local path as
`notify-send -i <path>`. Steam's avatar and capsule URLs are public CDN
addresses, so no authentication is involved.

The daemon here advertises `icon-static` but not `image-data` or `image-path`,
so `-i` with a file path is the route rather than the image hints. The Lua
backend already has an `http` module, but whether it handles binary responses
cleanly is unverified; `curl` through `os.execute` is the fallback.

## Verified on a live client

Facts established by testing rather than reading, each of which cost a cycle to
find:

- **The click bridge works.** A click on a desktop notification reaches the
  running plugin. The transport is a file under
  `~/.cache/steam-native-notify/pending/`, polled by the frontend through a
  backend callable.
- **Config change notifications do not reach a plugin frontend.** Millennium
  delivers an external config write by evaluating JavaScript in the main IPC
  context, but a plugin frontend runs in its own isolated CDP world
  (`Created isolated CDP world for plugin ... (ctx N)`), so the listener is never
  called. The Lua `config.on_change` hook did not fire for an MEP write either.
  This is why the bridge uses a file.
- **A callable's return value arrives JSON-encoded.** A Lua string comes back
  wrapped in literal quote characters, so `token === 'selftest'` silently fails.
  Symptom: a reserved token treated as an unknown uuid.
- **Millennium maps callable arguments positionally, not by name.** Sending
  `{ title, body }` to `Notify(title, body)` delivered them in the wrong order
  and produced a notification with summary and body swapped. One JSON-string
  argument avoids it.
- **A frontend change needs a full Steam restart.** `plugin.restart` (with or
  without `reload_ui`) and disable/enable both leave the frontend loaded but not
  executing -- the log says "Delegating frontend load" and nothing runs. Only
  `steam -shutdown` and relaunch works. The backend reloads fine either way.
- **`can replay` is timing-dependent.** `OnRespondToClientNotification` was
  present when the plugin loaded into an already-running Steam, and absent when
  the plugin loaded during Steam's startup. It should be checked when a replay is
  attempted, not at install time.
- **`DisplayClientNotification` does not feed `RegisterForNotifications`.**
  Dispatching one produces no feed event, so it cannot stand in for a real
  notification when testing.
- **Toast artwork is already on disk.** `steamloopback.host/assets/<appid>/<file>`
  maps to `~/.local/share/Steam/appcache/librarycache/<appid>/<file>`; nothing
  needs downloading.
- **Notification actions die with the popup.** Omarchy's shell only invokes an
  action whose identifier is `default`, and only while the popup is live -- an
  expired popup becomes a "restored row" with no live actions, and clicking it
  can only dismiss or focus the sending app.

## Still unproven

The notification feed has never been seen firing. `RegisterForNotifications`
registers without error, but no `notif index=` line has appeared for any real
notification. Until one does, two things are unknown: whether the feed delivers
at all in a plugin's isolated world, and whether the index it hands over is the
id `OnRespondToClientNotification` accepts.

Trigger a real notification -- a download completing, or a friend coming online
-- and check `tools/capture`.

## Known unknowns

- **Text shape.** `document.body.innerText` returns whatever Steam renders. The
  first-line-is-title split is a guess that needs a real toast to confirm; the
  logging exists to settle it.
- **The 64-bit client.** Millennium hooks Steam by preloading into the 32-bit
  binary via `ubuntu12_32/libXtst.so.6`. On the SteamRT3 64-bit client it
  installs, reports success, and does nothing —
  [Millennium #840](https://github.com/SteamClientHomebrew/Millennium/issues/840),
  open. When that lands, this plugin dies with it and the CDP route is the
  successor.
- **Steam updates.** Millennium breaks on client updates and is fixed within
  days. Riding `publicbeta` means riding that cycle.

## Uninstall

```bash
rm ~/.local/share/millennium/plugins/steam-native-notify
```

Restart Steam. Revert the `apps.lua` change if it was applied.
