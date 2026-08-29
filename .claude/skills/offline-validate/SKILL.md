---
name: offline-validate
description: The no-Steam validation gate — typecheck, build, backend and route tests, docs-table regeneration. Run before claiming any change works, before committing, and after ANY edit to frontend/, backend/main.lua, tools/notify-action, or routes. Triggers - "run the tests", "does it build", "validate this change".
---

All commands run from the repo root. Run all four; each catches a class the
others miss.

```sh
bun run typecheck    # tsc --noEmit
bun run build        # proto gen + typecheck + starlight pack (installs the .star)
bun run test         # tools/test-backend && bun tools/test-routes
bun run gen:table    # regenerate docs/notification-types.md; fails on drift
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
  `--escape-markup`, `--resolve-icon`). Output ends `PASS` or `N FAILED`.
- **`tools/test-routes`** is 71 exact-URL checks plus decode fixtures against
  the compiled frontend routing subgraph. Every expectation is a full literal
  URL on purpose: **when a route changes, change the literal in
  tools/test-routes to the new verified URL — never loosen a check** into a
  pattern or prefix match.
- **`bun run gen:table`** derives the routed/not-routed classification by
  running the real rules in frontend/routes.ts and fails when the CATALOG
  prose in tools/gen-types-table.mjs disagrees
  (`catalog disagrees with routes.ts for <Type> ...`). Run it after ANY
  routes.ts change and **commit the regenerated docs/notification-types.md**.
  `no catalog entry for <Type>` means Steam added a type — see the
  `steam-update-smoke` skill.

## The gate is necessary, not sufficient

Passing all four says nothing about behaviour in the running client (stale
bundle, Steam gates, focus rules). Behaviour claims still require the
`live-verify` skill.
