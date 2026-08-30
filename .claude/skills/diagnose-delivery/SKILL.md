---
name: diagnose-delivery
description: Diagnose a missing or wrong desktop notification through the capture → backend → notify-action → daemon chain. Use for "no desktop notification appeared", "the icon is wrong/missing", "clicking the notification does nothing", "the body renders mangled". Walks the chain in order with notify-action's test seams.
---

The chain: frontend captures the toast → backend `Notify` spawns
`tools/notify-action` (detached, one per notification, because
`notify-send --action` implies `--wait`) → notify-send → daemon. A click runs
the chain backwards: notify-action writes the replay token to
`~/.cache/steam-native-notify/.click` and the frontend click bridge opens it
from inside Steam, picking the surface by live game focus. Walk it in order;
each stage's log output places the fault. All commands run from the repo
root.

## 1. Did the frontend capture it? `tools/capture`

Section 1 must say `current.` — a stale bundle explains everything and nothing
else may be diagnosed past it. Then section 3:

| signature | meaning |
|---|---|
| no `toast <name> ->` line at all | frontend never delivered — hook (section 2, see `steam-update-smoke`), or the toast never painted |
| `toast <name> never painted any text` / `closed before it painted` | popup seen but unreadable — Steam closed it inside ~1.2s |
| `toast <name> -> {...}` | frontend handed it to the backend; go to step 2. The JSON shows exactly what was sent: title, body, image, type, and the replay token as route |

If capture goes silent right after a change to logging or extraction: **a
throwing diagnostic kills every notification silently** (a `JSON.stringify` on
a BigInt did exactly that). Keep `dlog` wrapped and use `safeJson`.

## 2. Did the backend spawn the helper?

```sh
tail -30 ~/.cache/steam-native-notify/plugin.log
```

(The mirrored plugin log; Millennium buffers a packed plugin's logger output
away from Steam's console log. Truncated at each backend load.)

- `helper install FAILED: ...` (at load) — the packed asset could not be
  written to `~/.cache/steam-native-notify/notify-action`; the reason is in
  the line. The backend re-materializes the helper from the .star at every
  load, so a stale or deleted copy heals on restart.
- `undecodable payload:` / `undecodable settings:` — the frontend sent
  malformed JSON; the payload is in the line.
- Nothing wrong logged and step 1 showed delivery — the backend ran
  notify-action (via `sh ~/.cache/steam-native-notify/notify-action`); go to
  step 3.

## 3. Exercise notify-action's seams directly

```sh
tools/notify-action --resolve-icon 'https://steamloopback.host/assets/1073390/library_600x900.jpg'
tools/notify-action --click-plan 'steam://nav/games/details/570'
tools/notify-action --escape-markup 'a < b & c'
```

- `--resolve-icon` prints a file path, or `steam` (theme-icon fallback) when
  the reference cannot be resolved. `steamloopback.host/assets/<tail>` maps to
  `~/.local/share/Steam/appcache/librarycache/<tail>`; http(s) avatars are
  fetched once (5s cap) into `~/.cache/steam-native-notify/icons/`. A wrong
  icon with a valid-looking URL usually means the librarycache file is absent.
- `--click-plan <route> [action]` prints `none` (no route AND no action
  token: the click only dismisses, by design) or `overlay` (everything else:
  the click is written to the click file for the bridge). No click ever
  invokes the `steam` binary from here.
- `--escape-markup` shows the escaped form; whether it is applied depends on
  the daemon: `--daemon-caps` prints `body-markup` (escaping on) or `plain`
  (raw body). A body showing literal `&lt;` means escaping ran for a daemon
  that never advertised `body-markup` (or the caps query failed and the safe
  default kicked in).

Full-chain manual run (blocks until the notification is clicked or dismissed):

```sh
tools/notify-action 'Title' 'body text' '' 'steam://nav/games/details/570'
```

## 4. A click did the wrong thing (or nothing): bridge triage

Clicks are executed by the click bridge inside Steam. The log places the
fault (`~/.cache/steam-native-notify/plugin.log`; the full vocabulary is in
`docs/architecture.md`, "Log vocabulary"):

| signature | meaning |
|---|---|
| no `click-bridge:` line at all | the click never reached the bridge: popup expired before the click (~8s), the bridge was past its 120s arm window, or Steam quit. Check `.click` — a leftover stamped payload means notify-action wrote it and nobody consumed it |
| `click-bridge: <payload>` and nothing after | the double-parse bug class, fixed in c07c4d1 — a consumed click must always log its outcome |
| `click-bridge: stale click dropped (Ns old)` | consumed but older than 30s; dropped by design (it sat in the file past the disarm) |
| `click-bridge: unstamped click dropped` | the file held a payload without its epoch stamp — a stale-format write or manual edit |
| `click-bridge: unbridgeable route ...` | the payload is not a replay token — a stale-format write or manual edit |
| `replay: invoke ... -> no stash entry / expired` | the stash no longer holds that toast (Steam restarted, or past the 120s window) |
| `replay: invoke ... -> THREW ...` | the handler's captured Steam stores moved — see `steam-update-smoke` |
| `replay: invoke ... -> returned without throwing` but nothing visible | the frozen-surface limit (the toast rendered on a surface that no longer exists), or the destination changed inside an unwatched window |

## 5. Daemon facts that masquerade as plugin bugs

- The click action is named `default` — the only name a plain body click
  fires; it works **only while the popup is live**. quickshell expires the
  popup after ~8s despite `-t 0`, the action dies with it, and the
  notification-centre copy is inert. A click after ~8s doing nothing is the
  daemon, not the route.
- No notification ever invokes the `steam` binary — clicked or not. Clicks go
  through the click file; a `steam` process launch during triage is something
  else.
- A notification with no replay token is unclickable by design — either
  Steam's own click does nothing for that type, or the walk refused an
  ambiguous handler set (`stashed=none` in the capture log). Mirror Steam.
- Daemon sanity check outside the plugin entirely:
  `notify-send -a Steam -t 0 -A default=Open 'test' 'body'` (blocks; a click
  prints `default`).
- Many replayed clicks change a page inside an existing window without
  raising it — watch the client, or a working click looks like nothing (see
  `live-verify` for the focus rules).
