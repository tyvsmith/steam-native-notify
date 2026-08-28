---
name: diagnose-delivery
description: Diagnose a missing or wrong desktop notification through the capture → backend → notify-action → daemon chain. Use for "no desktop notification appeared", "the icon is wrong/missing", "clicking the notification does nothing", "the body renders mangled". Walks the chain in order with notify-action's test seams.
---

The chain: frontend captures the toast → backend `Notify` spawns
`tools/notify-action` (detached, one per notification, because
`notify-send --action` implies `--wait`) → notify-send → daemon. Walk it in
order; each stage's log output places the fault. All commands run from the
repo root.

## 1. Did the frontend capture it? `tools/capture`

Section 1 must say `current.` — a stale bundle explains everything and nothing
else may be diagnosed past it. Then section 3:

| signature | meaning |
|---|---|
| no `toast <name> ->` line at all | frontend never delivered — hook (section 2, see `steam-update-smoke`), or the toast never painted |
| `toast <name> never painted any text` / `closed before it painted` | popup seen but unreadable — Steam closed it inside ~1.2s |
| `toast <name> -> {...}` | frontend handed it to the backend; go to step 2. The JSON shows exactly what was sent: title, body, image, kind, route |

If capture goes silent right after a change to logging or extraction: **a
throwing diagnostic kills every notification silently** (a `JSON.stringify` on
a BigInt did exactly that). Keep `dlog` wrapped and use `safeJson`.

## 2. Did the backend spawn the helper?

```sh
grep -a steam-native-notify ~/.steam/steam/logs/console-linux.txt | tail -30
```

- `helper MISSING at ...` (at load) — the plugin is not installed at
  `~/.local/share/millennium/plugins/steam-native-notify`; symlink the checkout
  there.
- `undecodable payload:` / `undecodable settings:` — the frontend sent
  malformed JSON; the payload is in the line.
- Nothing wrong logged and step 1 showed delivery — the backend ran
  notify-action; go to step 3.

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
- `--click-plan` prints `none` (empty route), `route` (chat routes — they
  self-focus), or `activate+route` (everything else: `steam; steam "<route>"`,
  activation first so the window surfaces).
- `--escape-markup` shows the body as delivered; the daemon parses body markup,
  so `&`, `<`, `>` must come out entity-escaped.

Full-chain manual run (blocks until the notification is clicked or dismissed):

```sh
tools/notify-action 'Title' 'body text' '' 'steam://nav/games/details/570'
```

## 4. Daemon facts that masquerade as plugin bugs

- The click action is named `default` — the only name a plain body click
  fires; it works **only while the popup is live**. quickshell expires the
  popup after ~8s despite `-t 0`, the action dies with it, and the
  notification-centre copy is inert. A click after ~8s doing nothing is the
  daemon, not the route.
- An unclicked notification never touches the `steam` binary at all.
- A null route means Steam's own click does nothing — dismissing is the whole
  behaviour, by design (`mirror Steam`).
- Daemon sanity check outside the plugin entirely:
  `notify-send -a Steam -t 0 -A default=Open 'test' 'body'` (blocks; a click
  prints `default`).
- `steam://nav/...` changes a page inside the existing window and never raises
  it — watch the client, or a working click looks like nothing (see
  `live-verify` for the focus rules).
