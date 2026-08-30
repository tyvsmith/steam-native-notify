---
name: steam-update-smoke
description: Smoke-test the plugin after a Steam client update — hook attachment, the replay health line, one client + one server fire, one invoke. Use for "Steam updated", "check nothing broke after the update", "the hook stopped working", "clicks stopped working", or any g_PopupManager / server-store lookup failure.
---

Steam updates move the minified UI bundle: `g_PopupManager`, the server
notification store, React fiber internals, and the toast component's handler
drilling can all reshuffle. Every replay-side failure names its layer in one
log line, so the smoke is: restart onto the current build, fire, read the
health line, invoke. All commands run from the repo root; the restart and
toggle mechanics are in the `live-verify` skill.

## 1. Did the hook attach?

```sh
tools/capture
```

- Section 1 must say `current.` before anything else is trusted.
- Section 2 missing `hook installed`, or showing `g_PopupManager never
  appeared` / `hook failed` — the bundle renamed or moved the popup manager.

**Millennium #840 caveat**: on the 64-bit SteamRT3 client the hook installs,
reports success, and does nothing. `hook installed` plus zero toast lines
ever captured despite real toasts on screen matches that bug, not this
plugin.

## 2. Smoke pair: one client fire, one server fire

```sh
tools/fire TestFriendOnline
tools/fire --server 2 '{"gifter_account":<a friend accountid>}'
```

Read each `replay: candidates` line — it is the layered health probe:

| line | broken layer |
|---|---|
| `n=0 (no fiber key in toast document)` | the `__reactFiber` convention moved (frontend/fiber.ts) |
| `... portal=miss` | the HostPortal boundary moved (replay.ts toastSubtreeRoot) |
| `stashed=none (ambiguous)` | Steam stopped drilling the handler object (choose.ts has nothing to prove) |
| `stashed=onClick@N (twin)` | healthy |
| no line at all, but `from-toast` present | the walk threw — look for `replay: walk failed` |
| `dev-fire: server notification store not found` | the webpack export search for `OnServerNotification` + `MarkItemRead` no longer matches |

Anomalies also dump the candidate list (capped), which is what a repair
works from. Every failure is fail-closed: notifications still deliver,
unclickable.

## 3. One invoke

```sh
tools/fire --replay invoke     # invokes the latest stashed handler
```

`replay: invoke ... -> returned without throwing` plus the destination
visibly opening (watch the client) completes the smoke. A `THREW` line is
logged verbatim with a stack — the handler's captured stores moved.

New notification types need nothing: replay stashes whatever Steam attaches.
