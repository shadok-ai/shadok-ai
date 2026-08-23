# Quota gauges compared against the time remaining

## Problem

The 5h and 7d gauges show a percentage of quota consumed without relating it to
the time left in the window. The raw figure therefore says nothing about the
trajectory: 90% of the 5h window with ten minutes to go is inconsequential, while
55% of the 7d window with six days to go announces exhaustion well before the
reset. The user has no signal warning them that they are burning too fast, and no
guardrail.

## Solution

Compare consumption against the **ideal pace** — the fraction of the window
already elapsed — and block sends when consumption exceeds that pace.

```
idealPace = (duration − remaining) / duration × 100
ratio     = used / (idealPace + 5) × 100
```

A ratio of 100% means consumption follows time exactly. Above it, we are going
too fast.

The constant 5 added to the denominator damps the start of a window. Without it
the ideal pace is near zero right after a reset and the smallest message would
blow the ratio up: five minutes after a 5h window's reset, the ideal pace is 1.7%
and 3% consumption would give a ratio of 180%. With the epsilon, that same case
falls back to 45%, while 15% consumption at the same instant gives 225% and does
trigger the block.

### Reference cases

| Window | Remaining | Used | Ideal pace | Ratio | Verdict |
|---------|---------|----------|--------------|-------|---------|
| 5h | 10 min | 90% | 96.7% | 89% | passes |
| 5h | 4h55 | 3% | 1.7% | 45% | passes |
| 5h | 4h55 | 15% | 1.7% | 225% | blocks |
| 7d | 6d | 55% | 14.3% | 285% | blocks |
| 7d | 6d | 20% | 14.3% | 104% | blocks |
| 7d | 1d | 80% | 85.7% | 88% | passes |

## Architecture

### `src/pace.ts` — the computation (new)

A pure module, with no I/O and no state, entirely testable.

```ts
export const WINDOW_SEC = { fiveHour: 5 * 3600, sevenDay: 7 * 86400 };
const PACE_EPSILON = 5;
const BLOCK_RATIO = 100;

export function computePace(
  w: Window | null,
  durationSec: number,
  nowMs: number,
): { idealPacePct: number | null; ratioPct: number | null };

export function paceBlock(
  u: Usage | null,
  nowMs: number,
): { blocked: boolean; reason: string | null };
```

`computePace` returns `null` on both fields when the window is missing or
`resetsAt` is unknown. `idealPacePct` is clamped to the 0–100 range: a clock ahead
of `resetsAt` must not produce a negative pace.

`paceBlock` blocks as soon as **one** of the two windows exceeds `BLOCK_RATIO`,
and names the culprit in `reason` — for example "7d: 55% used vs a 14% ideal pace
(285% of pace)". If both exceed it, `reason` names the one with the higher ratio.
With no data, `blocked` is `false`: an unavailable API must not lock the tool.

The 100% threshold is hardcoded. It is not configurable.

`usage.ts` keeps its current role — fetching the raw data and caching it for 60
seconds — and is not modified. The pace is computed on every request rather than
at fetch time, otherwise it would stay frozen on a snapshot up to a minute old.

### `src/server.ts` — applying it

**`GET /usage`** returns each window enriched with `idealPacePct` and `ratioPct`,
plus `blocked` and `reason` at the root level.

**A user prompt** (`case "prompt"`, server.ts:501): when `paceBlock` blocks and
`msg.force` is absent, the server answers
`{type:"pace-blocked", reason, text}` and submits nothing. The client can resend
the same prompt with `force: true` to override. `force` joins the shape guard of
incoming messages (server.ts:385).

Forcing applies to one message and one only. No override state is remembered,
neither server-side nor client-side: every send above the pace is a conscious
choice. That is what tells a guardrail from a decorative warning.

**Auto-continue** (server.ts:348): when the timer fires while the pace is
exceeded, the server does not submit "continue". It broadcasts
`{type:"pace-hold", reason}` and rearms `s.retryTimer` to 60 seconds to re-test.
The loop carries on until we are back under the threshold, then "continue" goes
out normally, preceded by `{type:"pace-resumed"}`.

Waiting does not consume `retryCount`: it is a pause, not a failed attempt.
Reusing `s.retryTimer` rather than a dedicated timer means the existing cleanup
paths cancel the pause when the session dies, with no extra code. The 60-second
step lines up with `usage.ts`'s cache TTL: the waiting loop issues no request to
the API.

Auto-continue is never forced. Forcing is a user action.

### `public/index.html` — the interface

**The gauges.** Each `.quota` becomes two stacked 3-pixel bars within the existing
92 pixels of width: consumption on top, the ideal pace below. The comparison is
immediate — the top bar longer than the bottom one means we are going too fast.

```
5h  usage [############  ] 90%
    pace  [############# ] 97%

7d  usage [######        ] 55%
    pace  [##            ] 14%
```

`paintGauge()` paints both bars and colours by the **ratio**, no longer by raw
consumption: amber from 70%, red from 100%. The tooltip gives consumption, ideal
pace, ratio and time to reset.

**Blocking.** The composer stays active: the block shows up at send time, not
before. On receiving `pace-blocked`, the client renders a bubble in the thread
styled as `.turn.dialog` (index.html:1524) — the reason with its figures and a
"Force send" button that resends the prompt with `force: true`. That pattern is
already the one used for TUI questions; the codebase has no floating modal and
does not introduce one.

**The pause.** `pace-hold` shows a status line saying the agent is waiting for an
acceptable pace to return, with the reason. `pace-resumed` removes it.

**Refreshing.** `refreshUsage()` keeps polling `/usage` every 60 seconds. No push
channel is added for the blocking state: the server stays the authority, and a
display up to a minute behind is inconsequential since a send in the meantime
would be rejected with its reason.

## Flows

```
User send
  └─ prompt ──▶ server ──▶ paceBlock ?
                              ├─ no ───────────▶ submit
                              └─ yes, no force ──▶ pace-blocked
                                                     └─▶ "Force send" bubble
                                                           └─▶ prompt force:true ─▶ submit

Auto-continue
  └─ timer ────▶ paceBlock ?
                    ├─ no ───▶ pace-resumed ─▶ submit "continue"
                    └─ yes ──▶ pace-hold ─▶ rearm 60s ─▶ (loop)
```

## Errors and edge cases

- **The API unavailable or no token**: `getUsage()` returns `null`, `paceBlock`
  does not block, the gauges show "—" as they do today.
- **`resetsAt` missing on a window**: that window does not take part in the
  block; the other is still evaluated.
- **An expired window** (`resetsAt` in the past): the ideal pace is clamped to
  100%, so the ratio becomes lenient until the next snapshot.
- **A session killed during a pause**: `s.retryTimer` is cancelled by the
  existing cleanup paths.
- **A client disconnected after `pace-blocked`**: no state server-side, nothing
  to clean.

## Tests

`test/pace.test.ts`, under `node --test`, on the pure functions:

- 5h, 10 min left, 90% used → passes
- 5h, 5 min elapsed, 3% used → passes (the epsilon doing its job)
- 5h, 5 min elapsed, 15% used → blocks
- 7d, 6 days left, 55% used → blocks
- 7d, 1 day left, 80% used → passes
- a single window above the threshold is enough to block
- `resetsAt` null → never blocks
- `usage` null → never blocks
- `reason` names the window with the higher ratio when both exceed it

`package.json`'s `test` script is extended to cover `test/` on top of the skill's
test directory.

## Out of scope

- Making the threshold configurable.
- Remembering an override beyond one message.
- Forcing auto-continue.
- Recording consumption history or projecting an exhaustion date.
