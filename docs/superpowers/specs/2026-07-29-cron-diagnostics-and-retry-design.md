# Channel crons become diagnosable and catchable-up

*2026-07-29*

## The problem

A daily 09:00 cron with a deterministic guard fired this morning. Its `lastRun`
in `~/.shadok-ai/crons/<enc>.json` did move to 09:00:15. **The agent never
received the prompt, and nothing anywhere says why.**

Checked by hand: the guard script produced 11.5 kB of output (so there was news),
the target session was alive and idle, no password configured. The failure is in
the delivery — and *all* of its failure paths look alike:

```ts
} else if (m.type === "turn-done" || m.type === "exited" || m.type === "error" || m.type === "pace-blocked") {
  // done, or the session was busy/absent/paced → skip; retry next tick.
  clearTimeout(guard); finish();
}
ws.on("error", () => { clearTimeout(guard); finish(); });
ws.on("close", () => { clearTimeout(guard); finish(); });
```

`driveChannel` **resolves the same way** whether the turn landed or not, and
`fireCron` returns `void`. A delivered turn, a turn refused on pace, a busy
session, a broken WS, the 30 min guard: indistinguishable, and none of them
writes a log line.

`runCronCheck` has the same defect, worse — it swallows the execution error:

```ts
(_err, stdout) => resolve((stdout || "").trim() || null),
```

A guard that does not exist (`exit 127`) and a guard with nothing to report both
return `null`. The first case is a bug to fix, the second is the intended
behaviour (0 tokens on a quiet run). Impossible to tell apart.

A second, independent defect: **no catch-up**. `cronTick` advances `nextRun`
*before* firing.

```ts
c.lastRun = now;
c.nextRun = nextRunFor(c.schedule, now);
```

That is deliberate — it stops a long turn from re-triggering on the next tick —
but it means a turn lost for a **transient** reason (the pace guard, a busy
session, a server reload mid-fire) is never replayed. For a daily cron, the
information is lost for 24 h.

## The fix

Three independent pieces: a typed outcome for the delivery, a three-way outcome
for the guard, a pure function for the rescheduling.

### 1. `driveChannel` returns an outcome, no longer `void`

```ts
export type DriveReason =
  | "pace-blocked"  // the pace guard refused the prompt
  | "busy"          // a turn was already running on that channel
  | "error"         // an application-level refusal from the server (other than busy)
  | "exited"        // the claude process died mid-turn
  | "ws-error"      // the loopback WS broke, or closed before the end of the turn
  | "timeout";      // the 30 min guard fired

export type DriveOutcome = { ok: true } | { ok: false; reason: DriveReason; detail?: string };
```

**Telling "busy" from the rest takes one piece of protocol.** The server refuses a
prompt mid-turn with `fail("a response is already in progress")` — an
`{ type: "error", message }` indistinguishable from a "no session started".
Matching on the string would be fragile (it can change, or be translated). So we
add an **optional** `code` field to the `error` message:

```ts
const fail = (message: string, code?: string) => send({ type: "error", message, ...(code ? { code } : {}) });
```

set to `"busy"` at the two sites that refuse because a turn is running (the
initial test, and the re-test after the pace guard's `await getUsage()`). Purely
additive: no existing client reads `code`.

`ws-error` also covers a **premature close** — a `close` with no preceding
`turn-done`. That is the "the server reloaded mid-fire" case, which today looks
exactly like a success.

`gone` (the channel's directory has disappeared) and `stopped` (someone ended the
session) are classified as `error`: replaying them would fail in exactly the same
way.

### 2. `runCronCheck` distinguishes three outcomes

```ts
type CheckResult =
  | { kind: "news"; out: string }        // the guard spoke → the agent runs
  | { kind: "quiet" }                    // nothing to report → silence, 0 tokens
  | { kind: "failed"; detail: string };  // the guard is broken → an incident
```

**The exit code cannot be the discriminator on its own.** `grep`, `diff` and
`test` exit 1 with no output when there is nothing to report — that is, in a
guard's *normal* case. Treating "exit ≠ 0" as an incident would turn the most
ordinary guard in the world into a permanent alert.

The rule adopted crosses stdout, the exit code and stderr:

| condition | outcome |
|---|---|
| non-empty stdout (whatever the exit) | **news** |
| empty stdout, exit 0 | **quiet** |
| killed / timed out / failed to spawn | **failed** |
| empty stdout, exit ≠ 0, **non-empty stderr** | **failed** |
| empty stdout, exit ≠ 0, empty stderr | **quiet** (the `grep` case) |

stdout stays the only content signal: the contract "the guard's output is
prepended to the prompt" is unchanged.

**A broken guard wakes the agent.** The prompt tells it the guard failed and
gives it the detail, so it can raise the alarm, rather than letting the
monitoring die in silence. That is an accepted trade-off: as long as the guard is
broken, every slot costs tokens. The remedy is to repair the guard — and the
opposite behaviour (silence) is precisely the bug being fixed. The log serves as
a trace even if nobody reads the chat.

### 3. The catch-up — a pure decision, in `src/crons.ts`

```ts
export const CRON_RETRY_DELAY_MS = 10 * 60_000;
export const CRON_MAX_RETRIES = 3;

export function nextRunAfterFailure(
  nowMs: number,
  scheduledNextMs: number,
  attempts: number,
): { nextRun: number; retrying: boolean; attempts: number };
```

| case | result | why |
|---|---|---|
| `attempts >= 3` | `scheduledNext`, `retrying: false`, counter reset to 0 | do not loop on a broken channel |
| `now + 10 min >= scheduledNext` | `scheduledNext`, `retrying: false`, counter reset to 0 | the normal slot comes first: catching up buys nothing |
| otherwise | `now + 10 min`, `retrying: true`, `attempts + 1` | the case in view |

A rescheduling **never overshoots** the normal slot: the second case's bound
guarantees it, including for a short `interval` cron (every 5 min → we never
catch up, the next tick does the work).

Replayed on: `pace-blocked`, `busy`, `ws-error`, `exited`. Not on `error` (an
application-level refusal: the cause does not evaporate in 10 min) nor on
`timeout` (the 30 min guard means the turn is *still* running — replaying it
would stack two prompts). Including `exited` is a choice: a claude process that
died mid-turn may have processed part of the prompt, so the replay can duplicate
a side effect. That is accepted — for monitoring, losing the information costs
more than a duplicate.

**The anti-double-fire invariant holds.** `cronTick` still advances `nextRun`
before firing, `cronsFiring` stays set until `fireCron`'s `.finally()`, and the
rescheduling always writes a **future** date (`now + 10 min`). A turn still in
flight therefore cannot be re-triggered. The rewrite re-reads the list from disk
(another tick may have saved it in between) and touches only the cron concerned,
by id.

Two persisted fields are added to `Cron`, readable directly in the JSON:

```ts
retries?: number;      // consecutive delivery failures, reset to 0 on success
lastOutcome?: string;  // "ok" | "quiet" | "check-failed" | a DriveReason
```

### 4. The logs

One short line per fire on stdout — hence in
`~/.shadok-ai/local-supervisor.log` — prefixed `cron:` like `telegram:`
elsewhere, with the id's first 8 characters.

```
cron: ab12cd34 fired (check: 11.5 kB) -> ok
cron: ab12cd34 quiet (check silent)
cron: ab12cd34 check failed (exit 127) — waking the agent
cron: ab12cd34 skipped: pace-blocked, retry in 10m (1/3)
cron: ab12cd34 skipped: busy, giving up until next slot
cron: ab12cd34 fired -> error: no session started
```

**The quiet run logs too**, on a neutral line. Without it we still cannot tell
"ran, nothing to say" from "never ran" — that is, we would only half-fix this
morning's hole. The cost is bounded: a cron every 5 minutes writes 288 lines a
day into an already chatty log.

## What is not done

`driveChannel` sends `cwd: process.cwd()` — the repo's root. Invariant nº 1 says
a worktree session resumed with the root cwd loses its history. That is a real,
adjacent defect, out of scope here: the logs added will make it visible if it
bites.

## Tests

`test/crons.test.ts` covers `nextRunAfterFailure`: the nominal catch-up, the cap
of 3 attempts, never overshooting the next slot (including when that one is less
than 10 min away), and the counter reset.
