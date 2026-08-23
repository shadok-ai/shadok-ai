# Server-side auto-retry of transient API errors — design

Date: 2026-07-20
Files concerned: `src/server.ts` (detection + timer), `public/index.html` (an
informational status line).

## Goal

When a turn dies on a transient API error (typically
`API Error: 529 Overloaded`), the server automatically relaunches the turn by
submitting `continue`, with no user intervention — even when no web client is
connected. If the user takes back control during the delay, the retry is
cancelled.

User decisions: all transient API errors (not only 529); 3 attempts with growing
delays (15 s / 30 s / 60 s); relaunch through a plain `continue` prompt;
detection and timer entirely server-side.

## Detection (end of turn, in `finishTurn`)

`finishTurn` already waits for the end of the turn (`waitForIdle`) then inspects
the screen to detect a dialog. We add, when there is **no** dialog, a transient
error test on the TUI's screen:

- The pattern (an exported pure function `findTransientErrors(screen): string[]`,
  returning the matching lines): `API Error` followed on the same line by `5xx`,
  `529`, `429`, `overloaded`, `timeout`, or a connection error (`ECONNRESET`,
  `ETIMEDOUT`, `fetch failed`…).
- Non-transient errors (`400`, `401`, `403`, `invalid_request`…) do not match: no
  retry.

**Anti false positive**: an old error can stay visible on screen after a short,
successful turn. At the very start of `finishTurn` (a single point, which covers
every handler as well as the retry's own path), we capture
`errorsAtTurnStart = findTransientErrors(screen)`. At the end of the turn we only
fire when `findTransientErrors(screen)` contains a line absent from that initial
capture (a multiset comparison: one extra occurrence of the same line counts as
new).

## Per-session state (the `Live` object)

```ts
retryTimer: ReturnType<typeof setTimeout> | null; // a pending retry
retryCount: number;                               // attempts consumed (0–3)
errorsAtTurnStart: string[];                      // the anti-false-positive capture
```

## Firing

When a new transient error is detected at the end of a turn:

1. If `retryCount >= 3`: broadcast `{ type: "auto-retry-gave-up" }`, reset
   `retryCount = 0`, done (the user will relaunch by hand).
2. Otherwise: `retryCount++`, delay = 15 s / 30 s / 60 s depending on the
   attempt, broadcast `{ type: "auto-retry", delayMs, attempt, max: 3 }`, then
   `retryTimer = setTimeout(...)`.
3. When it fires: if the session is still alive and not `busy`, broadcast
   `{ type: "prompt-echo", text: "continue", auto: true }`,
   `pilot.submit("continue")` then `finishTurn` (the same busy/error guardrails
   as the `prompt` handler). A new error on the following turn re-triggers the
   detection, hence the escalating delays.

`retryCount` goes back to 0 as soon as a turn ends **without** a new transient
error, or a user prompt arrives.

## Cancellation

The pending timer is cancelled (`clearRetry(s)`) when:

- a user message arrives: `prompt`, `choose`, `toggle`, `freetext`, `confirm`,
  `key` (the user took back control) — broadcast
  `{ type: "auto-retry-cancelled" }`;
- the session is stopped or destroyed: `destroySession` cleans `retryTimer` as it
  already cleans `idleTimer`.

The `settle` message does not cancel: it is a plain "wait for the end of the
turn", not a takeover.

## UI (informational only)

On receiving `auto-retry`, the web client shows a status line in the channel:
"Transient API error — auto-retry in 15 s (attempt 1/3)", cleared on `working`
(the retry went out), on `auto-retry-cancelled`, or replaced by a final message on
`auto-retry-gave-up`. No action required client-side; clients that are not
updated simply ignore those events.

## Tests

No test harness in the project today. `findTransientErrors` and the
start/end-of-turn comparison are exported pure functions, validated by a small
`debug/` script with captured error screens (529, 500, timeout, a 400 error that
must NOT match, an old error still visible that must NOT re-trigger). Manual
validation of the timer by simulating the screen.
