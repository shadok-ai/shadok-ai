# Submit recovery — an agent whose terminal stops taking input

## Problem

A failure shape we cannot prevent: a `claude` process stays alive and healthy
while its TUI stops consuming terminal input. The pane is up, not in copy-mode,
no dialog is on screen, the transcript ends on a clean turn. Nothing typed
reaches the process — not even the Ctrl-U / Ctrl-C clears `typeIntoBox` uses —
and the text of the last message sits in the input box, un-submitted. It is an
upstream bug class, seen across versions, with no workaround short of a new
process: "Reload agent" fixes it at once.

What the cockpit did about it:

- every later prompt failed with `submit: the text never appeared in the input
  box`, and one line went to the server log;
- the sender got that error. A Telegram DM guest got the guest wording for
  `error` — "please send that again in a moment" — which could never work, and
  a guest can run no command, so it was the only instruction they had;
- nothing was restarted and nobody who operates the instance was told. The
  agent stayed deaf until a human happened to look.

## Goals

1. Recover by itself: restart the agent and deliver the failed prompt again.
2. Never loop, never restart a healthy or working agent.
3. When it cannot recover: tell the sender something true, and alert an admin.

## Non-goal: a watchdog

From outside, a wedged agent is indistinguishable from an idle one — the same
still screen and silent transcript. Anything periodic has to guess, and a wrong
guess respawns a healthy agent along with its background shells and monitors.
A prompt that provably did not go in is the only reliable signal, so the fix is
reactive and lives on the submit failure. An agent nobody writes to is never
touched; it is recovered by the first message that needs it.

## Design

### A typed failure (`src/detect.ts`)

Both pilots threw a bare `Error`. They now throw `SubmitError` built by the
shared `submitFailure(failure, screen)`:

- `failure`: `not-typed` (the paste never showed) or `not-sent` (it showed and
  Enter never sent it). Both are the same wedge — its first failure is often
  the Enter, every later one the paste.
- `stuck`: `stuckScreenKind(screen)` — `first-run` / `masked` / `question` /
  `box-full` / null. Same recognition as `describeStuckScreen`, as a value, so
  a decision never depends on the wording of a message.

The message text is unchanged.

### The verdict (`src/submit-recovery.ts`, pure)

`submitRecoveryVerdict(input)` returns one of:

| verdict | when |
|---|---|
| `none` | disabled · not a `SubmitError` · process exited · a restart already running · **the transcript recorded a prompt after the submit began** (the screen was wrong; re-delivering would duplicate) · a turn is running · a question is on screen |
| `escalate` | first-run screen or masked field (a new process lands on the same screen) · a wedge inside the cooldown |
| `restart` | everything else — the incident's shape |

`RECOVERY_COOLDOWN_MS` is ten minutes per agent, stamped before the respawn so
a restart that throws still counts.

### The order (`submitWithRecovery`, pure, deps injected)

```
submit ── ok ──────────────────────────────► done
   │ fails
assess ── none ────────────────────────────► rethrow the original error
   │      escalate ── file report ─────────► UnresponsiveError
   │ restart
restartSession ─ submit ── ok ─────────────► done (a slow answer)
                    │ fails (or the restart threw)
                    └── file report ───────► UnresponsiveError
```

No loop: the second failure is not assessed again.

### In the server

- `submitRecovering` replaces the `prompt` handler's direct `submitGuarded`
  call. Every prompt goes through that handler — web, Telegram, CLI, sibling
  agents, crons and parent notifications (the loopback) — so all are covered.
- The restart is `restartSession`: the enforced path that hard-kills the pane
  and verifies it is gone. On a deaf TUI the graceful `/exit` cannot work.
- `Live.recovering` keeps `busy` up across the respawn (the restart otherwise
  drops it) and holds an interrupt key the way `submitting` already does.
- After the restart's `ready`, `working` is broadcast again: the turn the
  prompt opens is still ahead.

### When it cannot recover

**The operator** is alerted through the existing agent-reports inbox
(`src/agent-reports.ts`). It is the mechanism built for "an agent is stuck and
only a human can fix it": every admin gets the badge, the Telegram owner gets a
DM, a repeat merges into the open row and re-notifies at most hourly. The agent
cannot file the report — its terminal is what is dead — so the server files it
under the agent's name (`escalateUnresponsive` → `fileAndNotifyReport`, now
shared with `POST /reports`; the per-agent rate limit applies to agent-filed
reports only, and the server uses one constant title, which merges). The body
says what was tried and why it stopped; never the screen, which can hold
whatever the conversation was about.

**The sender** gets `error` with `code: "unresponsive"`, after the report is
filed, so its last clause is true:

> This agent has stopped accepting input and could not be recovered
> automatically. Your message was NOT delivered, and sending it again will not
> help until the agent is repaired. The admins have been alerted — "Reload
> agent" is the manual fix.

The web shows it as any error. The Telegram bridge stops the typing indicator
(no `turn-done` will come for a prompt that never went in) and, in a guest's
DM, says `guestNotice("unresponsive")`: the message did not arrive, sending it
again right now will not help, the people who look after the bot have been
alerted, try later. It names nothing of the cockpit.

### Off switch

`SHADOK_SUBMIT_RECOVERY=0` — the failure is reported as before.

## Testing

- `test/submit-recovery.test.ts`: the verdict table, the order of operations
  with a fake server (one restart and two submits at most, report before
  error, original error rethrown for another class), the wording, the report
  merge, the typed error.
- `test/tg-guests.test.ts`: the guest line is never dropped, names nothing of
  the cockpit, and does not ask for a resend.
- End to end, side by side on a spare port, with a stand-in TUI that can go
  deaf while staying alive: recover (prompt delivered exactly once),
  cooldown → escalate, restart → still deaf → escalate.

## Left out

- The auto-retry's `continue` and the `run` shell-mode submit keep the old
  behaviour: neither carries a message someone is waiting on.
- No web UI affordance beyond the error line (e.g. a "Reload agent" button on
  it). The existing ↻ is one click away and the report names the fix.
- The cooldown is in memory: a server restart resets it. The worst case is one
  extra automatic restart.
- Non-admin operators (a Telegram board with no owner DM) are reached by the
  Reports badge only.
