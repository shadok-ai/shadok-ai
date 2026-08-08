# Design — A parent agent hears back from the agents it launched

Date: 2026-08-08
Status: validated (brainstorming), not implemented

## Problem

`Shadok-Boss` landed on 2026-07-30 (`2026-07-30-shadok-boss-design.md`): an
entry-point agent whose job is to delegate. It is `READONLY_DENY` on purpose —
a boss that can commit ends up fixing "just this typo" itself and stops
delegating.

But it landed **without a nervous system**. When the boss spawns an agent it has
exactly two options, and neither works for running five in parallel:

- **Block.** `pilotctl prompt` attaches a WebSocket and waits for the turn to
  end — up to 600 s during which the boss does nothing else.
- **Fire and poll.** Spawn in the background, then keep asking each child "are
  you done?". Every poll is a turn on the boss's own session.

Nothing tells the boss that a child finished. There is no parent→child link
anywhere: `Live` has no such field, `Channel` has no such field, and
`pilotctl`'s state file records `sessionId`, `cwd`, `branch`, `baseSha` and
`holderPid` — no parent.

The concept already exists, but only as prose. The boss's system prompt says
*"never stop a session you didn't create"* — a rule the model must remember,
with no data behind it. Making the link real serves both needs at once.

### The failure mode that matters most

A child that hits an interactive dialog (a permission prompt, an
`AskUserQuestion`) has its turn **suspended**. Today nobody tells the boss. The
child waits forever, and the boss believes it is working. Of everything in this
design, this is the deadlock most likely to actually happen.

## Scope decisions (taken during brainstorming)

1. **A parent hears only about its own children.** Without explicit scoping, a
   chatty Telegram channel would wake the boss on every turn. Notification
   follows the link, nothing else.
2. **A child's dialog is routed to its parent, and the parent may answer it.**
   Chosen over "inform only" and "human only". See the escalation caveat below.
3. **Immediate wake, one per child** — not a coalescing window. Because dialogs
   now route to the parent, latency matters: a 30 s batching window would make
   every child's permission prompt wait half a minute, and interactive work with
   children would become painful. The batching that does happen is free (§6).
4. **Both linking paths ship together**: automatic at spawn, and manual
   channel→channel.

## Design

### 1. The data: a `parent` field

```ts
// src/channels.ts, on Channel
/** The channel that spawned this one (or was manually attached as its parent).
 *  Notifications about this agent go there and nowhere else. */
parent?: string | null;
```

Added to `SERVER_OWNED`. Two consequences, both wanted:

- A browser `PUT /channels` cannot touch it. The only legitimate path is a WS
  message, exactly like `profile`.
- It is **persisted**, so the tree survives a server restart — which it must,
  since tmux sessions survive restarts too and a boss can live for days. A
  runtime-only map would orphan every child on the first auto-update.

Note the asymmetry: the child stores its parent, not the reverse. A parent's
children are derived by filtering, so there is one writer per fact and no way
for the two directions to disagree.

### 2. Setting the link — two paths

**Automatic, at spawn.** `pilotctl` reads `SHADOK_SESSION_ID` from its own
environment and sends it as `parent` in the `start` message. The server already
sets that variable at spawn (`src/server.ts`, near the secrets note), and it was
verified to match the session's real id. No new plumbing, and the boss neither
knows nor does anything.

**Manual.** A `set-parent` WS message, modelled on `set-profile` — same reason
(the field is `SERVER_OWNED`), same shape, same file. `parent: null` detaches.
In the UI: an entry in a channel tab's ⋯ menu, "Attach to…".

### 3. The guard: no cycles

A→B→A would be an infinite notification loop. A **pure** function decides:

```ts
// Returns why the link is refused, or null if it is allowed.
export function linkRefusal(
  channels: Channel[], child: string, parent: string | null,
): "self" | "cycle" | "too-deep" | "unknown-parent" | null
```

It walks up from `parent`; if it reaches `child`, the link is refused. It also
caps depth. Pure and unit-tested, like `resolveCronId` and `nextRunAfterFailure`
— the same reason: a wrong answer here is silent and expensive.

Refusing must be explicit, never arbitrary: an unknown parent id is a refusal,
not a silently dropped field. That is the lesson `resolveCronId` already
carries (invariant 17) — a delete that returned `{ok:true}` while deleting
nothing.

### 4. What triggers a notification

Two hooks, and both are **already single funnels**:

| Event | Hook | Note |
|---|---|---|
| Turn finished | `finishTurn`, where `turn-done` is broadcast | |
| Dialog pending | `publishDialog` | The single funnel since invariant 23 |
| Child died / timed out | the `exited` path | Must notify — see below |

`publishDialog` being one place is not luck: invariant 23 moved dialog detection
into the screen watcher precisely so that every path — including raw `key`
input — goes through it. Without that work this design would need five hooks.

**A failure must notify too.** A child that dies or times out has to produce a
notification, otherwise the parent waits forever for something that will never
come. This is invariant 15's lesson restated: a lost run that says nothing is
indistinguishable from a run that had nothing to say.

### 5. What the parent receives

Delivery reuses **`driveChannel`** — the function crons already use to drive a
channel on behalf of something that is not a human. No new subsystem; a child's
completion becomes indistinguishable from a cron firing, which is
indistinguishable from a human typing. That is the "everything is a WS client of
our own server" rule holding.

The payload is deliberately small:

- the child's name and session id;
- **its last assistant text block** — the child's own summary, which is what it
  wrote to be read;
- **pointers**: branch, worktree path, the `/diff` URL.

**Not the diff itself.** The parent is almost always the largest session in the
tree, so it is the worst place to pour volume into. Measured on this repo's
transcripts: an average of ~359k tokens of prefix re-read per API call, i.e.
~36k effective tokens per wake in a large session. The parent fetches the diff
if it decides it needs it — the same "don't pay before you have a reason"
discipline as the cron guard.

Two free reuses:

- **`isNothingToShow`** — a child whose whole answer is `NOTHING TO SHOW` wakes
  nobody. The filter already exists in `src/tail.ts` and `loadHistory`.
- **A twin of `CRON_PROMPT_MARK`** is required, not optional. The notification
  arrives as an ordinary user message in the transcript, so without a marker it
  would look like something the human typed, and would come back on every web
  reload and Telegram backfill — exactly the bug `CRON_PROMPT_MARK` was created
  to fix.

### 6. When the parent is busy

A prompt sent mid-turn is refused with `error`, `code: "busy"`. A child that
finishes while the parent is thinking would therefore have its notification
dropped. So: **a queue per channel, flushed on `turn-done`.**

This is also where the batching comes from, for free. A parent is usually busy
precisely when it is working, so notifications accumulate on their own and
arrive together — no timer, no window, and the expensive case partly corrects
itself. That is why choosing immediate delivery costs less than the ~36k-per-wake
arithmetic in §5 suggests.

### 7. Bounds and the escalation caveat

**Bounds.** A maximum depth and a maximum fan-out per parent. A notification can
trigger a spawn which triggers a notification; without a ceiling that is a
cascade that empties the subscription overnight. The pace guard blocks one
prompt at a time — it does not bound a chain.

**Escalation.** Letting a parent answer its children's dialogs means a
`READONLY_DENY` boss can authorise a child to do what the boss itself is
forbidden from doing. This is not a blocker, but it must be a **profile
capability** rather than an ambient right — otherwise the guardrail that makes
delegation mandatory becomes bypassable by delegation.

## What this deliberately does not do

- **No declarative pipelines.** No "when A finishes, run B". The parent is a
  model; it decides. This design only gives it the information.
- **No barrier / "tell me when all five are done".** Rejected in favour of
  immediate delivery (§3). Revisit only if a real boss shows the cost.
- **No tree view in the UI.** The link is stored and settable; visualising it is
  separate work.
- **No token attribution per child.** Related and useful, but a different
  change (`origin` is currently a local variable that only feeds `prompt-echo`).

## Known cost

The parent's context grows with every notification, and it re-pays that inflated
prefix on every wake. This is a curve, not a plateau.

The mitigation is the **agent fork** discussed on 2026-07-29 but not specced:
fan out → the parent synthesises → the parent forks to start light on the next
batch. Taken together they hold; taken alone, this feature finances its own
inflation. Worth writing down before someone measures it in surprise.

## Success criteria

1. A boss spawning an agent produces a stored `parent` link with no extra step.
2. When that child's turn ends, the boss is prompted once, with the child's own
   summary and pointers — not the diff.
3. A child blocked on a dialog reaches the boss, and the boss can answer it if
   its profile allows.
4. A child that dies or times out notifies too; nothing waits forever.
5. A channel with no parent notifies nobody — a busy Telegram channel does not
   wake the boss.
6. Notifications sent while the parent is mid-turn are delivered after its
   `turn-done`, not dropped.
7. A cycle (A→B→A), a self-link, an unknown parent and an over-deep chain are
   each **refused explicitly**, never silently accepted or arbitrarily resolved.
8. The notification does not reappear as a user message on web reload or
   Telegram backfill.
9. `npm run build` and the tests pass; verified **on a free port side by side**,
   never by taking over 3789 (invariant 8).
