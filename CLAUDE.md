# CLAUDE.md

A Millennium plugin that mirrors Steam's in-client notification toasts to the
desktop notification daemon, preserving the artwork and the click action.

`docs/HANDOFF.md` is the full context: verified facts, dead ends, and the current
goal. Read it before non-trivial work. `docs/steam-routing.md` is the analysis
of Steam's own click routing that every route cites; `docs/notification-types.md`
is the generated type table.

## Goal

Routing is built on Steam's own click logic, read out of the shipped UI bundle
(28 of 62 types route; the rest are inert in Steam or open dialogs no URL
reaches). The current goal is runtime verification of that catalog. See "The
open problem: runtime verification" in the handoff.

## Commands

```sh
npm run build          # generate proto types, type-check, bundle
npm run typecheck      # tsc --noEmit on its own
tools/test-backend     # exercise backend/main.lua with Millennium stubbed
tools/capture          # is the running bundle current, did the hook attach,
                       # what did the last notifications carry
tools/fire TestFriendOnline   # push a real test toast through Steam's pipeline
tools/mep --methods    # talk to Millennium's external protocol (dev only)
tools/notify-action --resolve-icon <url>
npm run proto:check    # has Steam's protobuf drifted from vendor/
npm run gen:table      # regenerate docs/notification-types.md
```

Install: `ln -s "$PWD" ~/.local/share/millennium/plugins/steam-native-notify`,
then enable under Millennium > Plugins. Plugin log:
`~/.steam/steam/logs/console-linux.txt`, filtered by `steam-native-notify`.

## Hard constraints

**A full Steam restart is required for any frontend change.** `plugin.restart`
and disable/enable reload the Lua backend but leave the frontend loaded and not
executing, while still logging "Delegating frontend load".

```sh
steam -shutdown && sleep 15 && setsid uwsm-app -- gtk-launch steam.desktop
```

**Confirm the running bundle before diagnosing anything.** `tools/capture` says
so first. A stale bundle is indistinguishable from a broken feature.

**A green build proves very little.** Five runtime failures here were undefined
names or nil globals the bundler emitted happily. The build now type-checks;
`tools/test-backend` covers the Lua side. Run both, then confirm behaviour in the
running client.

**Diagnostics must never throw.** A debug log calling `JSON.stringify` on a
BigInt silently killed every notification. Use `safeJson`; keep `dlog` wrapped.

**Millennium callables take exactly one argument, a JSON string.** Key order is
not preserved onto Lua parameter names. Return values arrive JSON-encoded, so a
Lua string comes back wrapped in literal quote characters.

## Testing notifications

**A Steam toast is only clickable while a Steam window has focus.** Unfocused it
takes no click at all. Any "Steam's toast does nothing" result taken unfocused is
meaningless, and produced three wrong conclusions in this project.

**Watch the client while clicking.** A `steam://nav/...` route changes a page
inside the existing window; unwatched, a working navigation looks like nothing.

Download completion is the only reliable self-service trigger:

```sh
steam steam://uninstall/1073390 && steam steam://install/1073390   # Aircar, 0.89GB
```

Everything else needs another person or a server-side event. Design captures so
one real notification yields everything needed; you may only get one.

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
frontend/index.tsx        capture, extract, route      (runs inside Steam's CEF)
frontend/Settings.tsx     Millennium settings panel
frontend/generated/       generated from vendor/*.proto, do not edit
backend/main.lua          escaping, spawning           (Millennium Lua host)
tools/notify-action       delivery and click action    (POSIX sh)
vendor/                   Steam's published .proto plus provenance
```
