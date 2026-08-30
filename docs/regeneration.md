# Removed machinery, and how to bring it back

This branch (`feature/replay-click-path`) keeps only what executes: clicks
replay Steam's own toast handler (frontend/replay.ts + choose.ts), and the
capture path logs what it saw. Two whole subsystems were removed because
nothing on this branch consumes them. Their code is PRESERVED, not lost:

- **`backup/routing-catalog`** — a branch pinned at main's tip (21f731f),
  holding the complete original implementation. `main` itself also still
  carries it until the replay branch is promoted. Nothing here needs to be
  rewritten from prose; check the files out of the branch.

Read this before re-adding either subsystem; the "why removed" notes are
the design constraints a regeneration must re-satisfy.

## 1. The routing catalog (the original click path)

**What it was.** A hand-built mirror of Steam's per-type click logic:

| file (on backup/routing-catalog) | role |
|---|---|
| `frontend/routes.ts` | the catalog: `clientRoute(type, fields)` / `serverRoute(n)` -> `steam://` URL or null, ~40 mappings, every rule citing docs/steam-routing.md; `clientOverlayAction` emitted action tokens (screenshot/clip/chatroom/playtime) |
| `frontend/urlstore.ts` | Steam's URL templates via `SteamClient.URL.GetSteamURLList`, `resolveUrl(name, ...params)` |
| `frontend/identity.ts` | signed-in steamid64 (backend reads loginusers.vdf), `myProfilePath()` |
| `frontend/overlay.ts` | the surface doors: activate-overlay ingestion, `GetNavigator` media/playtime doors, chat dispatchers, live-focus tracking via `RegisterForOverlayGameWindowFocusChanged` |
| `frontend/clickbridge.ts` (old body) | click dispatch by LIVE focus at click time: overlay doors for the focused game, desktop doors (raising/creating the main window) otherwise |
| `tools/gen-types-table.mjs` | regenerated docs/notification-types.md and FAILED when catalog prose disagreed with routes.ts |
| `tools/test-routes` (old body) | 69 assertions locking every route URL literal offline |

**Why it existed / what replay lacks.** The catalog picks the click surface
from live focus at CLICK time; replay's handler is frozen to the surface the
toast rendered on. Measured consequence (docs/experiments/click-replay.md):
an overlay-captured handler invoked after the game exits silently no-ops
where the catalog opens the desktop destination. The catalog also has
offline-testable correctness; replay's oracle is the live client.

**When to regenerate.** If the fail-closed replay losses become unacceptable
(unclickable or no-op clicks around focus changes), or a Steam update breaks
the fiber conventions faster than they can be chased. The hybrid design —
replay when click-time surface matches capture surface, catalog otherwise —
is sketched in docs/experiments/click-replay.md; it needs overlay.ts's focus
tracking plus the catalog as fallback.

**How.** `git checkout backup/routing-catalog -- frontend/routes.ts
frontend/urlstore.ts frontend/identity.ts frontend/overlay.ts tools/test-routes
tools/gen-types-table.mjs` and take clickbridge.ts/index.tsx/notification.ts
from the same branch or re-wire by hand. docs/steam-routing.md (kept on this
branch) is the analysis every route cites; docs/notification-types.md (kept)
is the generated per-type table as of the split.

## 2. The generated protobuf schema

**What it was.** `vendor/steammessages_clientnotificationtypes.proto`
(Valve's published proto, provenance in `vendor/PROVENANCE.json`) →
`tools/gen-proto.mjs` (ran inside `bun run build`) →
`frontend/generated/notifications.ts` (576 lines: `typeName()` and
`fieldsForType()`), plus `tools/proto-sync.mjs` behind `bun run proto:check`
/ `proto:update` to detect upstream drift.

**What it did here.** Client-sourced notifications arrive as a Closure
protobuf whose values sit POSITIONALLY in `data.array` at
`fieldNumber + arrayIndexOffset_`. The schema turned that into named fields
(`steamid`, `appid`, `screenshot_handle`, ...) and numeric types into names
(`(SystemUpdate)`). On main that decoding fed routing — a mis-decode
misroutes, hence CLAUDE.md's old "keep the generated protobuf schema" rule.
On the replay branch its ONLY consumer was the `from-toast` log line.

**What the logs lose without it.** `from-toast` now shows `type=<number>`
and the raw positional array for client types (server rollups are plain
JSON and still decode fully). Field names must be reconstructed by hand:
map type numbers via docs/notification-types.md, field positions via the
vendor proto on the backup branch. Triage is slower; nothing else changes —
no click behavior ever depended on the decode here.

**When to regenerate.** If the catalog comes back (routing needs named
fields, non-negotiable), or if log triage without names proves too painful
in practice.

**How.** `git checkout backup/routing-catalog -- vendor tools/gen-proto.mjs
tools/proto-sync.mjs`, restore the `gen`/`proto:check`/`proto:update`
scripts and the `bun tools/gen-proto.mjs &&` prefix of `build` in
package.json, restore `fieldsForType`/`typeName` use in
frontend/notification.ts and index.tsx (the old shapes are in the same
branch), and re-add the decode fixtures to tools/test-routes.

## 3. What deliberately stays on this branch

- `docs/steam-routing.md` — the bundle analysis. It is knowledge, not
  machinery; both approaches cite it.
- `docs/notification-types.md` — the per-type table as generated on main;
  now also the type-number → name reference for the schemaless logs.
- `docs/experiments/click-replay.md` — the measured comparison and the
  hybrid sketch.
- `frontend/choose.ts` + its fixtures — the click chooser, the one piece of
  replay that is pure logic and offline-tested.
