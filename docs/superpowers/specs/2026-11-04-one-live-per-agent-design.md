# One `Live` per agent: hand over a superseded session's viewers, never orphan them

**Status:** implemented.

## The bug (measured on correctsms, session 6f3abeff)

A message typed in a Telegram topic did **not** appear live in the web chat for
the same agent — it showed up only after a page reload (which re-reads the
transcript). The agent's own answers arrived live on the web, and web-typed
messages appeared, so the socket was plainly alive. Only the **prompt echoes of
the other interface** were missing.

That "deaf to some things, not others" shape is the tell. `prompt-echo` and
`stream-text` go through the **same** `broadcast(s, msg, except)` to `s.clients`;
the only difference is `except` (the echo excludes the sender). So a client that
gets answers but not echoes is not on a dead socket — it is a client of a
**different `Live` object** than the one the echo is broadcast on. The server
code is correct in isolation: the Telegram bridge submits a normal
`{type:"prompt"}` over its loopback WS, the one `prompt` handler broadcasts the
echo excluding only the sender, and the client renders it. The defect is that
**two `Live` exist for one agent**.

## Root cause

In the `start` handler the attach-and-share branch fires only when
`existing && !existing.pilot.hasExited`. When the existing `Live`'s pilot has
exited, the handler falls through to `createSession`, whose
`sessions.set(id, newLive)` **replaces** the registry entry — with no client
handover and no teardown of the old object.

If that retired `Live` still had viewers attached (nobody called
`destroySession`), they are orphaned on it:

- its tail is still running on the same `.jsonl`, so they keep receiving the
  agent's **answers** (and their own prompts echo locally), which is why the tab
  looks mostly alive;
- but every `broadcast` now targets the **new** `Live`, so they miss the other
  interfaces' **prompt echoes**, **dialogs**, and **working/turn-done**.

How a connection ends up orphaned: a `hasExited` can latch `true` on a single
transient `has-session` probe (invariants 23/25) while the pane is actually
alive. A subsequent resume — a Telegram reconnect, a `driveChannel` cron/notify,
another tab — then takes the `createSession` path and supersedes the old `Live`
while a viewer is still on it.

## Decision

One `Live` per agent. When a resume cannot attach and must create a new `Live`,
**hand the retired `Live`'s viewers to the new one and quiet the old one**,
rather than leave two live objects for one id.

The teardown is deliberately **not** `destroySession`. The new `Live` may have
adopted the **same tmux pane** (the latched-`hasExited` case above), so:

- **never** `pilot.kill()` — it would kill the live agent the new `Live` now drives;
- **never** `clearTailPos` — the position file is shared, and resetting it would
  make the new tail replay the whole transcript from byte 0.

## The fix

- `src/live-handover.ts` — `supersedeSession(old, next)`:
  - moves every `old.clients` socket into `next.clients` (returns the count);
  - quiets the retired `Live`: stops its own tail (so one transcript is not
    tailed twice — the "two tails share one pos file" side effect), clears its
    screen/idle/retry timers, and turns off its raw pipe;
  - the `HandoverLive` interface omits `pilot`, `cwd`, `id` and
    `transcriptHome`, so the function **cannot** kill the agent or touch the
    tail position — a compile-time guarantee, not a comment.
  - Raw terminal viewers are not re-wired onto the new pilot's pipe (that
    subscription is per-pilot and is rebuilt when the engine room is next
    opened); moving the chat `clients` set is what the reported bug needs.
- `src/server.ts`:
  - in the `start` handler, after `createSession`, when `existing && existing
    !== session`, call `supersedeSession(existing, session)` (logged when it
    moved viewers);
  - at the top of the WS message loop, re-point this connection's `session`
    closure to `sessions.get(session.id)` when it differs — so an orphaned tab's
    SENDS (and its takeover/retry handling) act on the one real `Live`;
  - `ws.on("close")` detaches from `sessions.get(session.id) ?? session`, so a
    handed-over socket is removed from the live `Live`'s client set, not the
    retired one.

## Scope

This removes the split at its one source (the `createSession` path in the
`start` handler); `restartSession` already reuses the same `Live` object and was
never a split site. The handover is safe with zero viewers too (it still stops a
lingering tail on a retired `Live`), so it runs whenever an exited `existing`
is superseded.

## Tests

`test/live-handover.test.ts`: viewers move to the succeeding `Live`; they merge
with viewers it already has; the old `Live` is quieted (tail stopped, timers
cleared, raw pipe off) while the agent is **never** killed; and a no-viewer
handover is a clean no-op.
