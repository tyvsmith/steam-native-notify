# Experiment: replay Steam's own toast click handler

Status: run 2026-08-29, verdict below. Branch: `experiment/click-replay`.
Main untouched.

## Results (2026-08-29, run live on Steam + Helldivers 2)

**Verdict: the hypothesis survived every kill test, and full replay still
fails the success criteria.** The stashed handler survives its toast's death
in every form — plugin `win.close()`, natural dismissal, 10+ minutes, main
window closed to tray — and replays Steam's click exactly. But a handler
captured on the overlay surface is frozen there: invoked after the game
exits it returns without throwing and does NOTHING (the overlay navigator
it closed over has no surface; `overlay-info: []`). The current bridge in
the same state opens desktop Settings, so this is a real regression, in
exactly the surface-frozen failure mode predicted above.

Lifecycle matrix (SystemUpdate; every invoke `returned without throwing`):

| cell | condition | destination |
|---|---|---|
| a | toast on screen (age 3s) | opened — Settings raised, toast window visibly up |
| b | after plugin `win.close()` (age 12s) | opened — Settings window appeared fresh |
| b' | after natural dismissal (age 105s) | opened |
| c | after game exit (overlay capture, age 381s) | **silent no-op** — no window, no error |
| d | main window closed to tray (age 33s) | opened — Steam's navigator recreated the main window itself |
| e | 10+ min after capture (age 615s) | no throw; dialog already open (idempotent) |

Type matrix: the generic finder produced ONE unambiguous handler on every
toast tried, on both surfaces — SystemUpdate `()=>d.Settings("System")`,
Gift `()=>Xe(o,r.item)` (server registry -> SteamWeb), FriendMessage
`()=>{I.LN.ShowFriendChatDialog(t,e)}` (desktop invoke verifiably opened
the chat window), Screenshot (a real F12 capture)
`()=>l.Media.Screenshot({state:{id:a}})` with the real handle. Every
handler arrives drilled through 3-4 wrapper fibers, outermost-first; no
inner-button misfires observed. GroupChatMessage was not exercised (needs
a real group message); IncomingVoiceChat was never invoked (side effects).

Focus-mismatch regressions: one class, observed in two handler families
(settings dialog, media navigator): overlay-context stash invoked after the
overlay died = silent swallow. The reverse case (desktop stash clicked
in-game) was not measured; Steam's own desktop-context click behaves the
same way, so it is mirror-equivalent, but the bridge is deliberately better
there too.

Durability (step 5): not exercised — no Steam client update landed during
the experiment. The memory criterion's heap-snapshot spot check was not
done.

Follow-up: despite the recommendation below, a full build-out was requested
for field comparison — branch `feature/replay-click-path` replaces the
catalog and doors with the replay path end to end, so the frozen-surface
behavior can be felt in practice rather than argued from cells.

**Recommended path: close the branch.** Full replay is dead: the regression
cannot be detected after the fact (the no-op invoke raises no error to
trigger a fallback), so a hybrid must decide BEFORE invoking, using exactly
the live-focus check the bridge already does. That hybrid keeps routes.ts,
the doors, AND the replay machinery — all six of the bridge's shallow
minified dependencies plus replay's two deep ones (fiber internals, prop
names) — for a payoff of automatic parity only for types the catalog does
not already cover, on the matched surface only. Every acting type is
already cataloged and mirrored; replay replicated the bridge's behavior in
every matched-surface cell and never exceeded it. The probe code stays on
this branch as the record.

### Build-out incidents (feature/replay-click-path, 2026-08-29)

Two measured failures during the field build-out, both now encoded in the
chooser (frontend/choose.ts) and its offline fixtures:

- **The toast-slot leak.** The first build invoked the bare outermost
  onActivate. Steam's real click enters through the DOM-level onClick,
  whose wrapper pairs the activate with the toast-dismissal bookkeeping
  (`r=>{e&&e(r),t&&t()}` in the dumps); invoking the bare activate while
  the toast was still on screen leaked one of Steam's ~3 concurrent toast
  display slots per click, and after three such clicks no toast of any
  type rendered until restart. Hence twin/sole-or-refuse: the invoked
  handler must be the identity-proven DOM click (Steam drills the same
  function object down the wrapper chain) or the only function present.
- **The portal sweep.** Climbing from the toast's first fiber to the
  absolute root walked into the main window's tree — toasts are
  portal-rendered — and collected 673 candidates including window chrome
  and Millennium's own UI. The walk now roots at the HostPortal fiber
  (tag 4) whose containerInfo lives in the popup's document.

A third incident was harness-side, not replay's: TestIncomingVoiceChat
wedges the toast queue by itself (no caller exists to resolve the fake
call), verified by A/B with zero clicks and zero invokes.

---

## Hypothesis

At capture time, the toast's React tree contains the per-type component's own
click handler: the exact closure Steam runs when its toast is clicked
(docs/steam-routing.md, module 11374, the `onActivate` callbacks). If that
handler can be found generically (an onClick/onActivate prop on the clickable
fiber), stashed per notification, and invoked when the user clicks OUR desktop
notification, the plugin replays Steam's click logic verbatim. That would
remove routes.ts's per-type catalog, the action tokens, and every overlay door
in overlay.ts, with automatic parity for all 62 types and any future ones.
This is the prime rule ("mirror Steam, do not invent") taken to its limit:
not a mirror of Steam's code, Steam's code.

## Why it could work

- Closures survive their window's death when they only reference persistent
  objects. The routing analysis shows the activate handlers bottom out in
  long-lived stores: FriendsUI dispatchers, the navigator, `CURLStore`,
  `SteamWeb`. None of those die with the toast popup.
- Precedent in this repo: the browserInfo stash. notification.ts's fiber walk
  already retrieves a long-lived context object from the toast tree at capture
  time, overlay.ts holds it, and openChatRoomDialog uses it after the toast is
  gone. The replay is the same move with a function instead of a context
  object.
- The fiber tree is already open. notification.ts finds the toast's fiber and
  walks it for the notification object; locating a handler prop is an
  extension of a proven walk, not a new mechanism.

## Why it could fail

**The handler may capture the toast window or its React context.** The
plugin closes Steam's popup after reading it. If the closure dereferences the
dead window (or a dismissed-toast fiber) it throws at click time, possibly
before the routing part runs. This is cheap to test and decisive: invoke after
close is the kill test, scheduled early (method step 3, first cell).

**Surface is frozen at notify time. This is the experiment's hardest
problem.** The current bridge picks the click surface from LIVE focus:
clickbridge.ts re-checks `overlayFocusedAppId()` at click time, because
Steam's toast placement lags focus changes (overlay.ts, observed). A stashed
handler is frozen to the surface the toast rendered on. Concrete failure: a
toast captured in-game (overlay context), clicked after alt-tab to the
desktop, replays into an overlay the user is no longer looking at; or after
the game exits, into an overlay that no longer exists. Candidate mitigations:

- Stash both surfaces' handlers: impossible. Only one toast renders, on one
  surface; there is no second handler to take.
- Accept notify-time surface. Defensible as a mirror: Steam's own
  desktop-context toast click opens the client window even while a game runs
  unfocused (HANDOFF, observed 2026-08-29). But the current bridge is
  deliberately better than that for the lagging-placement case, so this is a
  regression unless measured otherwise.
- Hybrid: replay when click-time focus matches the notify-time surface, fall
  back to the existing bridge otherwise. Keeps parity where replay is safe,
  keeps live-focus correctness where it is not. Cost: routes.ts and the doors
  cannot be deleted, only demoted, which halves the payoff.

The lifecycle and type matrices exist to decide between the last two.

**The generic finder may grab the wrong handler.** Some toasts contain inner
buttons with their own onClick (tray options; voice chat accept). Invoking the
wrong closure ACTS (accepts a call) rather than navigates. Mitigation: select
the outermost interactive fiber (breadth-first from the root, first hit), log
every candidate with depth and a `fn.toString()` snippet, and inspect before
invoking. Start the type matrix with harmless types; do not invoke an
unidentified handler on IncomingVoiceChat.

**Memory.** A stashed closure pins its captured scope: plausibly the whole
toast component subtree, possibly a detached document. Holding one per toast
forever is a leak. Bound the stash: latest N (8), expired with the click-arm
window (clickbridge.ts's `ARM_WINDOW_MS`, 120s), cleared on expiry not on
popup destroy (the plugin destroys the popup itself; the click comes later).
The experiment probe may hold entries longer to measure the 10-minute cell;
production must not.

**Fragility, both surfaces honestly.** The replay depends on React fiber
internals (`__reactFiber$` keys, `memoizedProps`, child/sibling traversal)
and on Steam's minified prop names (`onClick`/`onActivate`), neither
observable in tests, both movable by any Steam update or React upgrade. The
current approach's own minified surface is not small: `g_PopupManager`, two
`findModuleExport` predicates (overlay store, chat dispatcher),
`OnGameOverlayActivateRequested`'s request shape, `GetNavigator` and
`nav.Media.*`, the URL-store template names, and the server type map. Replay
trades roughly six shallow, log-observable dependencies for two deep ones.
`steam-update-smoke` must cover whichever survives.

## Method

1. **Fiber walk extension.** Extend notification.ts's walk (or add a sibling
   walk in a new `frontend/replay.ts`) to locate the clickable element's
   handler: from the toast's root fiber, traverse downward
   (`fiber.child`/`fiber.sibling`), collect every fiber whose
   `memoizedProps` has a function-valued `onClick` or `onActivate`, record
   prop name, depth, `fn.name`, and the first 200 chars of `fn.toString()`
   (try-wrapped; diagnostics must never throw). Stash the outermost candidate
   per toast name, bounded as above. Log one `replay: candidates ...` line per
   toast. No behavior change to delivery.
2. **Devfire probe.** A `replay` branch in devfire.ts next to the overlay
   probes, gated by the existing devFire setting: `inspect` dumps the stash
   (names, candidate metadata), `invoke <toast-name>` calls the stashed
   handler with a stub event object (`{preventDefault(){}, stopPropagation(){}}`;
   adjust if the snippet shows the handler reading more). Log `replay: invoke
   ...` and the thrown error verbatim if any. Wire a `tools/fire --replay`
   passthrough.
3. **Lifecycle matrix.** For one known-good type (SystemUpdate: settings
   dialog, harmless, fireable), invoke the stashed handler: (a) toast still
   on screen, (b) after the toast closed (the plugin's own `win.close()`),
   (c) after the game exited (overlay-context capture), (d) after the main
   window closed to tray, (e) 10+ minutes after capture. Record per cell:
   throw or not, and whether the destination opened (watch the client; an
   unwatched nav looks like nothing). Cell (b) is the kill test; if it
   throws before routing, the hypothesis is dead and the experiment stops.
4. **Type matrix.** In this order: settings (SystemUpdate), openurl (Gift via
   `tools/fire --server 2`), screenshot (action token), chat
   (TestFriendMessage), room (GroupChatMessage, needs a real group message or
   an injection). For each: replay result vs the current bridge's verified
   behavior on both surfaces (HANDOFF's observed-click table and the in-game
   findings). Any cell where replay lands on the wrong surface while the
   bridge lands on the right one is a focus-mismatch regression; count them.
5. **Durability.** After the next Steam client update: does the finder still
   locate a handler (step 1's log line), does one invoke still work. Run
   `steam-update-smoke` alongside.

## Success criteria

- Every lifecycle cell in step 3 invokes without throwing and opens the
  destination.
- No focus-mismatch regressions in step 4 relative to the current bridge, or
  the hybrid fallback covers every regressed cell.
- The stash is bounded (latest 8, 120s expiry) and holds no detached
  documents (heap-snapshot spot check is enough).

## Abort criteria

- The handler throws on any invoke after the toast window is closed (step 3
  cell b), routing not reached.
- Surface-frozen behavior is worse than the current bridge and the hybrid
  cannot fall back cleanly (e.g. replay's side effects fire before the
  fallback can decide).
- No generic finder works across the type matrix (per-type fiber paths would
  just rebuild routes.ts one level down).

## Branch protocol and migration

Work on `experiment/click-replay`, branched off main. Main's behavior stays
untouched for the experiment's whole life; the probe code ships only on the
branch. If the experiment succeeds: replay becomes the primary click path,
routes.ts and the overlay doors remain as a documented fallback for one
release, then get removed. If it fails: the branch is closed and this file
records why, next to the other dead ends.

## Verification norms (this repo's, non-negotiable)

- Offline gate before any claim: `bun run typecheck`, `bun run test`,
  `bun run build`. A green build proves very little here; five past runtime
  failures type-checked cleanly.
- Runtime verification via the `live-verify` skill: build, full Steam
  restart, `tools/capture` FIRST (a stale bundle is indistinguishable from a
  broken feature), then fire.
- A full Steam restart for ANY change, backend included. The restart
  incantation and its silent-relaunch trap are in live-verify.
- Evidence is `~/.cache/steam-native-notify/plugin.log` lines, quoted in the
  session. New `replay:` prefixes are fine; renaming existing prefixes blinds
  tools/capture.

## Kickoff prompt

Paste into a fresh agent session:

```
Working directory: /home/ty/Code/steam-native-notify

Read first, in order: CLAUDE.md, docs/HANDOFF.md,
docs/experiments/click-replay.md (the plan you are executing). Consult
docs/steam-routing.md, frontend/notification.ts, frontend/clickbridge.ts,
frontend/overlay.ts, frontend/index.tsx, frontend/devfire.ts as you touch
each area.

Task: run the click-handler replay experiment exactly as the plan's Method
section describes, steps 1 through 5.

Branch rule: create `experiment/click-replay` off main and commit only
there. Never commit to main. Main's behavior stays untouched.

Hard constraints:
- A full Steam restart is required for ANY frontend or backend change:
  `steam -shutdown && sleep 15 && setsid uwsm-app -- gtk-launch
  steam.desktop`; if Steam is not up after the sleep, launch again.
- Before diagnosing anything, run `tools/capture`. If it says STALE, restart
  Steam. Never diagnose past a stale bundle.
- `tools/fire` needs the "Accept test commands from tools/fire" toggle ON in
  Millennium > Plugins > Steam Native Notify. No `dev-fire:` log line means
  the toggle is off. A `dev-fire:` line with no `from-toast` line means one
  of Steam's own gates ate the toast (see HANDOFF, testing methodology).
- Diagnostics must never throw. Use dlog/safeJson from frontend/log.ts;
  wrap every fn.toString() and every handler invoke in try/catch. Do not
  rename any existing log prefix; add new lines under a `replay:` prefix.
- Offline gate before any claim and before every commit: `bun run
  typecheck`, `bun run test`, `bun run build`.
- Do not invoke an unidentified handler on a type with side effects
  (IncomingVoiceChat accepts calls). Inspect the candidate dump first.
- Mirror Steam: if replay of a type does nothing and Steam's own toast click
  does nothing, that cell PASSES.

Commit style: `<type>(<scope>): Subject`, e.g. `feat(frontend): Stash the
toast click handler`. No AI attribution of any kind: no Co-Authored-By, no
"Generated with" footers, no mention of agents in messages.

Steps, with report-back checkpoints:
1. Fiber walk extension (plan step 1). Build, restart Steam, fire
   TestSystemUpdate 1, quote the `replay: candidates` log line.
   CHECKPOINT: report the candidate list (prop names, depths, toString
   snippets) and whether a plausible outermost handler exists. Wait for
   go-ahead if the candidates look ambiguous; otherwise continue.
2. Devfire probe (plan step 2): `--replay inspect` and `--replay invoke`,
   gated on the devFire setting.
3. Lifecycle matrix (plan step 3), SystemUpdate, cells a through e. Cell b
   (invoke after the toast closed) is the kill test: if it throws before
   routing, STOP and report.
   CHECKPOINT: report the five cells as a table with the exact plugin.log
   line per cell and whether the destination visibly opened.
4. Type matrix (plan step 4) in the plan's order, comparing against the
   current bridge's verified behavior. Count focus-mismatch regressions.
5. Durability (plan step 5) if a Steam update lands during the experiment;
   otherwise record it as not exercised.
   CHECKPOINT: final report: success/abort verdict against the plan's
   criteria, the evidence lines, and the recommended path (full replay,
   hybrid, or close the branch).

Evidence is plugin.log lines quoted in the session, never claims. Click
within ~8s of a desktop notification appearing (quickshell expires the
popup and the action dies with it). Watch the Steam client while clicking;
an unwatched navigation looks like nothing.
```
