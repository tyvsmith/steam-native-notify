# CLAUDE.md

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon, preserving the artwork and the click action.

`docs/HANDOFF.md` is the full context: verified facts, dead ends, and what is
still open. Read it before non-trivial work. `docs/steam-routing.md` is the
analysis of Steam's own click routing that every route cites;
`docs/notification-types.md` is the generated type table.

## State

Routing is built on Steam's own click logic, read out of the shipped UI bundle
(31 of 62 types route; the rest are inert in Steam or open dialogs no URL
reaches). The catalog is runtime-verified for ten types across both
notification systems, with watched end-to-end clicks for the openurl and
settings families. What remains is the "Still open" list in the handoff:
the chat-route click, the tray-only click, one real server event, in-game
capture.

## Commands

```sh
bun run build          # generate proto types, type-check, pack + install the .star
bun run typecheck      # tsc --noEmit on its own
bun run test           # tools/test-backend (Lua, Millennium stubbed)
                       # + tools/test-routes (offline route/decode checks)
tools/capture          # is the running .star current, did the hook attach,
                       # what did the last notifications carry
tools/fire TestFriendOnline   # push a real test toast through Steam's pipeline
                              # (needs the tools/fire toggle in plugin settings)
tools/fire --server 3 '{...}' # inject a server rollup through OnServerNotification
tools/mep --methods    # talk to Millennium's external protocol (dev only)
tools/notify-action --resolve-icon <url>
bun run proto:check    # has Steam's protobuf drifted from vendor/
bun run gen:table      # regenerate docs/notification-types.md; FAILS when the
                       # catalog prose disagrees with what routes.ts does
```

Install: `bun install`, then `bun run build`; starlight packs the plugin into
`~/.local/share/millennium/plugins/me.tysmith.steam-native-notify.star`
(building IS installing). Enable under Millennium > Plugins.

Plugin log: `~/.cache/steam-native-notify/plugin.log`, truncated at each
backend load (Millennium buffers a packed plugin's logger output away from
Steam's console log, so the backend mirrors it there). Millennium's own
loader lines are still in `~/.steam/steam/logs/console-linux.txt`, filtered
by `me.tysmith.steam-native-notify`.

## Hard constraints

**A full Steam restart is required for any frontend change.** `plugin.restart`
and disable/enable reload the Lua backend but leave the frontend loaded and not
executing, while still logging "Delegating frontend load".

```sh
steam -shutdown && sleep 15 && setsid uwsm-app -- gtk-launch steam.desktop
```

`steam -shutdown` returns early, and a relaunch while the old instance lives is
silently swallowed. If Steam is not up after the sleep, launch again.

**Confirm the running .star before diagnosing anything.** `tools/capture` says
so first. A stale build is indistinguishable from a broken feature.

**A green build proves very little.** Five runtime failures here were undefined
names or nil globals the bundler emitted happily. The build type-checks;
`bun run test` covers the Lua side and the routing subgraph. Run both, then
confirm behaviour in the running client.

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

**Keep the generated protobuf schema.** `data.array` is positional; without field
names, shape-guessing misroutes. `FriendInviteRollup.new_invite_count` of 3
becomes `steam://nav/games/details/3`.

**Edit files directly, and verify the edit landed.** Positional splices and loose
regexes silently dropped edits and deleted a live declaration twice.

## Layout

```
millennium.toml           plugin manifest; starlight packs everything below
frontend/index.tsx        popup lifecycle: hook, wait, deliver   (Steam's CEF)
frontend/notification.ts  React tree -> typed notification
frontend/routes.ts        the routing catalog, cites steam-routing.md
frontend/urlstore.ts      Steam's URL templates (GetSteamURLList)
frontend/identity.ts      signed-in steamid64, from the backend
frontend/log.ts           dlog/safeJson; prefixes are capture's contract
frontend/devfire.ts       tools/fire door, gated by a setting
frontend/Settings.tsx     settings panel; settings.ts, one JSON document
frontend/generated/       generated from vendor/*.proto, do not edit
backend/main.lua          pure marshaller                (Millennium Lua host)
tools/notify-action       escaping, delivery, click action        (POSIX sh,
                          packed as a .star asset, materialized to ~/.cache)
vendor/                   Steam's published .proto plus provenance
```
