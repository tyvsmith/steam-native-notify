---
name: offline-validate
description: The no-Steam validation gate — typecheck, build, backend and frontend tests. Run before claiming any change works, before committing, and after ANY edit to frontend/, backend/main.lua, or tools/notify-action. Triggers - "run the tests", "does it build", "validate this change".
---

All commands run from the repo root. Run all three; each catches a class the
others miss.

```sh
bun run typecheck    # tsc --noEmit
bun run build        # typecheck + starlight pack (installs the .star)
bun run test         # tools/test-backend && bun tools/test-frontend
```

## What each proves, and what it does not

- **A green build proves very little.** Five runtime failures in this project
  were undefined names or nil globals the bundler emitted happily (two
  `PLUGIN_DIR` bugs, `toBase64`, `notificationFromToast`, `JSON.stringify` on a
  BigInt in a debug log). `tsc` catches the TS name errors; nothing catches a
  Lua nil global except `tools/test-backend`.
- **`tools/test-backend`** (needs `lua5.4`) exercises backend/main.lua with
  Millennium stubbed (config, assets, fs; the runtime cache directory is a
  throwaway under mktemp), plus notify-action's exposed seams (`--click-plan`,
  `--escape-markup`, `--resolve-icon`) with notify-send/gdbus shimmed.
  Output ends `PASS` or `N FAILED`.
- **`tools/test-frontend`** compiles the Millennium-free frontend subgraph and
  locks the toast decode (notification.ts) and the click chooser (choose.ts):
  the twin/sole/refuse rules that keep a replayed click from ever running the
  wrong handler. **Never loosen a refusal fixture** — the refusals encode the
  measured toast-slot leak (docs/experiments/click-replay.md, "Build-out
  incidents").

## The gate is necessary, not sufficient

The replay walk and the invoke touch live React fibers and Steam stores that
exist only in the running client. Passing everything above says nothing
about behaviour there (stale bundle, Steam gates, focus rules). Behaviour
claims still require the `live-verify` skill.
