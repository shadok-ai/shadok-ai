# Plan: step 2 — the door's admission ceiling

Design:
[`specs/2026-11-26-external-groups-per-conversation-isolation-design.md`](../specs/2026-11-26-external-groups-per-conversation-isolation-design.md),
decision 3. **Implemented.**

Step 2 of five, and the design puts it before the wall on purpose: it is the
cost that wall creates.

## What was wrong

Both guest doors are uncapped by construction — "no cap on the number of
guests, no queue, no per-person block" — and the README said so. That was
tenable while a stranger cost a **directory** under a shared Unix user. It
stopped being tenable twice over: a stranger already costs a `claude` process
and a tmux pane, so anyone who knows the number can make the instance spawn
until it falls over, and step 3 turns a stranger into a `useradd`, i.e. a row
in `/etc/passwd`, reachable from a phone.

## What changed from the design

One deliberate widening, settled with the operator: **the ceiling applies to
every guest door now**, not only to a future `external` group. Scoped to
`external` it would have been dormant, unverifiable code until step 3, while the
process-per-stranger cost is real today. With the defaults chosen (200 / 30) an
ordinary instance never meets it.

## The shape

1. **`src/guest-admit.ts`** (new) — the whole decision, pure:
   `GUEST_LIMITS` (200 live, 30 per hour), `guestLimitsOf` (the door's stored
   numbers, else the defaults; a malformed value reads as **unset**, never as a
   shut door — the config file is hand-editable and closing a door is what the
   MODE is for), `requestedLimits` (what a request asks for: naming none KEEPS
   what is stored, an empty one restores the defaults), `guestConversationKey` /
   `liveGuestKeys` (the occupancy, as a set of conversation keys) and
   `guestAdmitVerdict` (returning → always in; else the cap, then the rate).
   Its own module rather than `tg-guests.ts`: it has to name a conversation on
   either transport, and `wa-guests.ts` already imports `tg-guests.ts`, so
   putting it there would close an import cycle.
2. **`src/tg-guests.ts`** — `GuestSetup.limits`, carried (never interpreted)
   through `normalizeGuestSetup`, and **ASSERT-only** in `guestPatchFlow`: a
   patch that does not name the ceiling keeps it, like `branch` / `repo` /
   `parent` (invariant 19). Without that, every save from the panel — which has
   no field for it — would silently reset the operator's numbers. Plus the new
   `guestNotice("door-full")`.
3. **`src/config.ts`, `src/wa-guests.ts`** — the ceiling rides through both
   doors' readers and writers, or a save would drop it.
4. **`src/server.ts`** — the gate in the WS `start` handler: after the door is
   known, **before** the working directory, the isolation resolution and any
   process, and only on a fresh guest spawn. The door's setup is now read ONCE
   (`doorSetup`) and shared with `guestSpawnPlan`; the conversation's name is
   resolved once (`guestDir`) and reused for the directory, so the ceiling and
   the folder cannot disagree about who someone is. `admissionsOf` /
   `chargeAdmission` hold the hourly window in memory, keyed by group, pruned as
   they are read. Both guest routes accept `limits`.
5. **`src/telegram.ts`, `src/wa-bridge.ts`** — the `guest-full` code becomes the
   one guest line and the bridge is CLOSED, so "come back later" is an
   instruction that works instead of queueing the next message for ever. On
   WhatsApp it goes through `noticeTo` (the person has no binding — no agent was
   created — and is only written to because they wrote seconds ago).

Three properties are the ones worth not relearning, and invariant 83 holds them:
the live count is **read from the registry** (a counter in memory would widen
the door at every auto-update restart), a **returning conversation is exempt**
(a cap that refuses someone you are already talking to is a conversation killer,
not a resource guard), and the count is **per group** (two doors onto one group
share one ceiling, because the group is where a conversation costs a Unix user
and a home).

## Tests

Pure: `test/guest-admit.test.ts` (the keys on both transports, the occupancy
set, the limits reader, the three verdicts and their order, the window edge, the
defaults at 199 and at 200), `test/tg-guests.test.ts` (the notice's wording —
never "send that again" — and the ASSERT-only ceiling through a save),
`test/guest-membership.test.ts` (the WhatsApp twin of that round-trip).
End to end through the real bridge: `test/wa-bridge.test.ts` drives the
scripted transport and a fake server socket — a `guest-full` refusal sends
exactly `guestNotice("door-full")` to that person, closes the socket, frees the
inbox, logs for the admin, and the next message attempts a fresh spawn.
Source scans in `test/tg-guests-routes.test.ts` and
`test/whatsapp-routes.test.ts` lock the gate's POSITION (before
`ensureGuestWorkDir`, `resolveSpawnIsolation` and `--session-id`), its inputs,
the refusal code, the charge, and both bridges' mapping.

**Not verified against a live server**: a guest door only opens in the
privileged deployment, which provisions Unix users through `sudo`. This host has
no `sudo`, so a side instance started with `SHADOK_FORCE_MULTITENANT=1` logs
`whatsapp: unavailable (the instance's groups are not migrated yet)` and the
door never opens. The live count against a real registry and the hourly window
against a real clock are therefore covered by unit tests and scans only.

## Not in this step

A queue and a per-person block (still deliberately absent). A panel field for
the numbers — they are set through the two guest routes, and the panel never
resets them. Everything else of the design: the `external` nature, the Unix user
per conversation and its registry, the guest's own secret slice, the lifetime
gestures.
