# Prompt for the next agent

Copy the block below.

---

Work in `~/Code/steam-native-notify`, a Millennium plugin that mirrors Steam's
in-client notification toasts to the desktop notification daemon.

**Read `docs/HANDOFF.md` first, in full, before touching anything.** It records
operational constraints that are not discoverable from the code and that have
already cost days: a full Steam restart is required for any frontend change, a
Steam toast is only clickable while a Steam window has focus, and a
`steam://nav/...` click changes a page inside an existing window so it looks like
nothing happened if you are not watching the client. Several conclusions in this
project were wrong because of those three things rather than because of bad code.
Also read `README.md` and `docs/notification-types.md`.

## Your task

Click routing currently works for four notification types and is built from
per-type rules derived by observation. Steam has 63 types. Replace the per-type
approach with Steam's own routing logic.

I do not believe Steam implements 63 one-off behaviours. Every notification in
the desktop client, the mobile app and the website knows where it navigates, so
there is almost certainly a general mapping inside Steam. Find it and build on
it rather than reconstructing it type by type.

Concretely, I want to know:

1. **Is there a field, or a resolver, that determines a notification's
   destination?** Something that guarantees the state a click lands in, rather
   than us inferring "has a steamid, so open a chat". The React notification
   object has `eType`, `eSource`, `data` and an always-undefined
   `fnNotificationResolved` — find out whether any of those, or something near
   them, is the real answer.
2. **Can the `steam://` scheme be invoked from inside the notification?** If
   Steam constructs a URL somewhere, use Steam's URL rather than one we build.
3. **Do the types group the way they appear to?** I expect store-bound ones
   (wishlist, major sale, item announcement), game-bound ones (an invite to play,
   a friend starting a game, download complete, achievement), person-bound ones
   (messages, online, voice chat) and account-bound ones (trade offers, family
   requests). If that grouping is real, it should come from Steam's own code or
   schema, not from our guesses.

`docs/HANDOFF.md` lists five specific leads under "The open problem", ordered by
how likely they are to pay off. The first — using Millennium's webpack module
search to find Steam's own notification navigation function and calling it —
is where I would start.

## Ground rules

- **Mirror Steam, do not invent.** Every invented route in this project's history
  had to be torn out. A click that does nothing is correct when Steam's own toast
  does nothing. When you add a route, cite the observation or the Steam code path
  it came from.
- **Verify at runtime, not at build time.** A green build has hidden five
  separate runtime failures here. Run `npm run build` (which type-checks) and
  `tools/test-backend`, then confirm behaviour in the running client with
  `tools/capture`.
- **Test clicks with a Steam window focused, watching the client.** Otherwise the
  result means nothing.
- Notifications are hard to trigger. Download completion is the only reliable
  self-service one; most types need another person. Design captures so a single
  real notification yields everything you need, because you may only get one.

## Also agreed, not yet done

A cleanup described at the end of `docs/HANDOFF.md`: delete the notification feed
subscription, the index correlation, the protobuf byte decoder and `toBase64`,
since reading the notification out of the React tree supersedes all of them and
sees types the feed misses entirely. Keep the generated protobuf schema; field
names are what stop positional data being misrouted. Do this as its own commit,
before the routing work, so the two are separable.

The working tree is currently uncommitted and ahead of the initial commit. Review
`git diff` before you start.
