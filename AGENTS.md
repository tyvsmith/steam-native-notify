# CLAUDE.md

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon, preserving the artwork and the click action.

`docs/HANDOFF.md` is the full context: verified facts, dead ends, and what is
still open. Read it before non-trivial work. `docs/steam-routing.md` is the
analysis of Steam's own click routing that every route cites;
`docs/notification-types.md` is the generated type table.

## State

**This branch (`feature/replay-click-path`) replaces the routing catalog with
handler replay**, built out for a field comparison against main. At capture
time frontend/replay.ts walks the toast's fiber tree and stashes the toast
component's own onClick/onActivate (outermost, portal-bounded); a click writes
`replay:<toast-name>` to `~/.cache/steam-native-notify/.click` and the click
bridge invokes the stashed handler — Steam's own click, verbatim. routes.ts,
urlstore.ts, identity.ts, overlay.ts and the doors are REMOVED here; main
still has them. Known limit, measured in docs/experiments/click-replay.md:
the handler is frozen to the surface the toast rendered on — one captured
in-game and clicked after the game exits (or unfocused) silently no-ops where
main routes to the desktop. The stash holds the latest 8 toasts for 120s;
clicks past that (or after a Steam restart) do nothing.

The routing catalog AND the generated protobuf schema are removed here;
`docs/regeneration.md` records what they were, why, and how to bring either
back, and branch `backup/routing-catalog` (pinned at main's tip) preserves
the complete original implementation.

## Commands

```sh
bun run build          # type-check, pack + install the .star
bun run typecheck      # tsc --noEmit on its own
bun run test           # tools/test-backend (Lua, Millennium stubbed)
                       # + tools/test-frontend (toast decode + click chooser)
tools/capture          # is the running .star current, did the hook attach,
                       # what did the last notifications carry
tools/fire TestFriendOnline   # push a real test toast through Steam's pipeline
                              # (needs the devFire toggle; the developer toggles
                              #  only appear in the panel with devMode set in
                              #  the settings document -- seed it via tools/mep
                              #  or the Millennium config, see live-verify)
tools/fire --server 3 '{...}' # inject a server rollup through OnServerNotification
tools/mep --methods    # talk to Millennium's external protocol (dev only)
tools/fire --replay inspect   # dump the stashed handler candidates
tools/fire --replay invoke    # invoke the latest stashed handler (no click)
tools/notify-action --resolve-icon <url>
```

Install: `bun install`, then `bun run build`; starlight packs the plugin into
`~/.local/share/millennium/plugins/me.tysmith.steam-native-notify.star`
(building IS installing). Enable under Millennium > Plugins.

Plugin log: `~/.cache/steam-native-notify/plugin.log`, truncated at each
backend load (Millennium buffers a packed plugin's logger output away from
Steam's console log, so the backend mirrors it there). Millennium's own
loader lines are still in `~/.steam/steam/logs/console-linux.txt`, filtered
by `me.tysmith.steam-native-notify`. Click triage reads the same log:
`replay: candidates` shows what each toast stashed, `click-bridge:` every
consumed click, `replay: invoke` what running the handler did (a throw is
logged verbatim, never propagated).

## Hard constraints

**A full Steam restart is required for ANY change, backend included.** Under
the .star format, `plugin.restart` and disable/enable leave the backend
stopped (`running: false`, immediate "backend unloaded" after load); the
frontend was already unreloadable ("Delegating frontend load" logs and does
not execute).

```sh
steam -shutdown && sleep 15 && setsid uwsm-app -- gtk-launch steam.desktop
```

`steam -shutdown` returns early, and a relaunch while the old instance lives is
silently swallowed. If Steam is not up after the sleep, launch again.

**Confirm the running .star before diagnosing anything.** `tools/capture` says
so first. A stale build is indistinguishable from a broken feature.

**A green build proves very little.** Five runtime failures here were undefined
names or nil globals the bundler emitted happily. The build type-checks;
`bun run test` covers the Lua side, the toast decode, and the click chooser.
Run both, then confirm behaviour in the running client.

**Diagnostics must never throw.** A debug log calling `JSON.stringify` on a
BigInt silently killed every notification. Use `safeJson`; keep `dlog` wrapped.
The log prefixes in `frontend/log.ts` are the contract `tools/capture` greps;
renaming one blinds the triage tool.

**Millennium callables take exactly one argument, a JSON string.** Key order is
not preserved onto Lua parameter names. Return values arrive JSON-encoded, so a
Lua string comes back wrapped in literal quote characters.

## Testing notifications

**A Steam toast is only clickable while a Steam window has focus.** Unfocused it
takes no click at all. Any "Steam's toast does nothing" result taken unfocused is
meaningless, and produced three wrong conclusions in this project.

**Watch the client while clicking.** A `steam://nav/...` route changes a page
inside the existing window; unwatched, a working navigation looks like nothing.

**Clicks ride the click bridge, which has windows.** The bridge polls for 120s
after each delivery and drops clicks older than 30s; a click outside those
windows (or after Steam quits) does nothing, by design. Every consumed click
logs a `click-bridge:` line — no line means the bridge was not armed or the
poll ended.

**Never fire TestIncomingVoiceChat.** A fake incoming call has no caller to
hang up: its notification never resolves, and once its toast has shown,
every later toast queues behind it until Steam restarts. Verified by A/B
with zero clicks and zero invokes (2026-08-29); not a plugin defect. Real
voice chats resolve when the caller hangs up.

**Read a failed `tools/fire` correctly.** No `dev-fire:` log line means the
settings toggle is off. A `dev-fire:` line with no `from-toast` line means one
of Steam's own gates ate the toast (SystemUpdate's weekly gate, the user's
notification preferences, a missing sender persona). The handoff's "Testing
methodology" section lists them.

Download completion is the only reliable real-event self-service trigger:

```sh
steam steam://uninstall/1073390 && steam steam://install/1073390   # Aircar, 0.89GB
```

Everything else needs tools/fire, another person, or a server-side event.
Design captures so one real notification yields everything needed; you may
only get one.

## Conventions

**Mirror Steam, do not invent.** A click that does nothing is correct when
Steam's own toast does nothing. Every invented route here had to be torn out.
When adding a route, cite the observation or Steam code path behind it.

**Prefer the React path over the notification feed.** Steam attaches its decoded
notification to the toast's React tree. The feed misses types entirely: an
incoming voice chat produces no feed event at all.

**Nothing routes on the decode anymore.** Client payloads are logged as the
raw positional `data.array` (the schema that named its fields left with the
catalog; docs/regeneration.md brings it back). Type numbers map to names via
docs/notification-types.md.

**Edit files directly, and verify the edit landed.** Positional splices and loose
regexes silently dropped edits and deleted a live declaration twice.

## Layout

```
millennium.toml           plugin manifest; starlight packs everything below
frontend/index.tsx        popup lifecycle: hook, wait, deliver   (Steam's CEF)
frontend/notification.ts  React tree -> typed notification (feeds the log)
frontend/replay.ts        stash Steam's own click handler per toast; invoke it
frontend/choose.ts        which handler a click may invoke (pure, offline-tested)
frontend/fiber.ts         the __reactFiber discovery both walkers share
frontend/log.ts           dlog/safeJson; prefixes are capture's contract
frontend/clickbridge.ts   every click: .click file -> replay by toast name
frontend/devfire.ts       tools/fire door, gated by a setting
frontend/Settings.tsx     settings panel; settings.ts, one JSON document
backend/main.lua          pure marshaller                (Millennium Lua host)
tools/notify-action       escaping, delivery; a click writes .click (POSIX sh,
                          packed as a .star asset, materialized to ~/.cache)
```
