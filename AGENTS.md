# AGENTS.md

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon, preserving the artwork and the click action.
(CLAUDE.md is a symlink to this file.)

`docs/architecture.md` is the full context: the pipeline, the log
vocabulary, verified facts, testing methodology, and dead ends. Read it
before non-trivial work. `docs/steam-routing.md` is the analysis of Steam's
own click handling; `docs/notification-types.md` maps type numbers to names;
`docs/regeneration.md` restores the removed subsystems if ever needed;
`docs/platforms.md` is the platform support matrix (Linux native shipped;
Flatpak paths ready, host unsupported; Windows delivery shipped but
EXPERIMENTAL and unvalidated on real hardware; macOS refuses to deliver,
loudly) and the delivery plan for each.

## State

**Clicks are handler replay.** At capture time frontend/replay.ts walks the
toast's fiber tree and stashes the click handler Steam attached to it,
proven by choose.ts (identity twin or sole handler; ambiguity refuses and
the toast stays unclickable — never a wrong action). A click writes
`replay:<toast-name>` to `~/.cache/steam-native-notify/.click` and the
bridge invokes the stash. Known limit, measured in
docs/experiments/click-replay.md: the handler is frozen to the surface the
toast rendered on — captured in-game and clicked after the game exits, it
silently no-ops. The stash holds the latest 8 toasts for 120s; clicks past
that (or after a Steam restart) do nothing.

The previous implementation — a hand-built routing catalog with live-focus
surface selection, plus the generated protobuf schema — is preserved whole
on branch `backup/routing-catalog`; `docs/regeneration.md` records what
each piece was, why it left, and how to bring it back.

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
                              #  Millennium's config store -- seed it via
                              #  tools/mep or the config file, see live-verify)
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

A healthy idle client can ignore `steam -shutdown` outright (observed three
times, 2026-08-30: the process survived 30s+). Standard recovery: watch
`pgrep -x steam` for up to ~30s, then `pkill -TERM -x steam`, wait ~8s, then
`pkill -KILL -x steam` and `pkill -KILL -x steamwebhelper`. Always `-x`,
never `-f` — a `-f` pattern matches the invoking shell.

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

**Frontend-backend RPC is Millennium's `ffi` bridge, positional.**
`ffi('Notify')(title, body, image, route, ingame)` lands on the Lua parameters
in order (the old `callable` transport could not order a multi-key object,
which is why everything once travelled as one JSON string). A Lua string
return has arrived both raw and JSON-quoted across transports: unwrap only
what provably starts with a quote (clickbridge.ts).

**Settings live per-key in Millennium's config store.** The panel uses
`usePluginConfig`; the `settings()` snapshot loads via `pluginConfig.getAll`
and stays current through `subscribePluginConfig`; the backend migrates the
old one-document form at load. A write from any source (panel, backend,
`tools/mep`) reaches a running frontend without a restart.

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
frontend/Settings.tsx     settings panel; settings.ts, per-key config store
backend/main.lua          marshaller + per-OS spawn seam (Millennium Lua host)
tools/notify-action       escaping, delivery; a click writes .click (POSIX sh,
                          packed as a .star asset, materialized to ~/.cache)
tools/notify-action.ps1   Windows delivery: WinRT toast, protocol-activation
                          click (EXPERIMENTAL, unvalidated on real hardware)
tools/click-handler.js    the snn: URI handler: validate, write .click
                          (wscript //B, registered by the ps1's -Setup)
```
