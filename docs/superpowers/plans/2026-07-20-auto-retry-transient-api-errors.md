# Server-side auto-retry of transient API errors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a turn dies on a transient API error (529 Overloaded, 5xx, timeout…), the shadok-ai server automatically submits `continue` after 15 s / 30 s / 60 s (3 attempts max), cancelled if the user takes back control.

**Architecture:** Pattern detection on the TUI's screen at the end of the turn (`finishTurn` in `src/server.ts`), with a start/end-of-turn comparison to ignore an old error still on display. The pure detection functions in a new `src/retry.ts` module. The timer and the counter carried by the session's `Live` object. The web client (`public/index.html`) shows informational status lines.

**Tech Stack:** TypeScript (ESM, `tsc`), Node, ws. No test framework: a `debug/test-retry.mjs` verification script run with `node` (`node:assert` assertions), modelled on `debug/probe.mjs`.

## Global Constraints

- Spec : `docs/superpowers/specs/2026-07-20-auto-retry-transient-api-errors-design.md`.
- Retry delays: 15,000 ms, 30,000 ms, 60,000 ms — 3 attempts max.
- Texte de relance : exactement `continue`.
- Transient errors: `API Error` + `5xx`/`529`/`429`/`overloaded`/`timeout`/a connection error. `400`/`401`/`403`/`invalid_request` NEVER trigger a retry.
- New server→client WS events: `auto-retry`, `auto-retry-cancelled`, `auto-retry-gave-up`; `prompt-echo` gains an optional `auto: true` field.
- Style: comments in English, like the rest of `src/`.

---

### Task 1: The `src/retry.ts` detection module

**Files:**
- Create: `src/retry.ts`
- Test: `debug/test-retry.mjs` (an assertion script, run after the build)

**Interfaces:**
- Produces: `findTransientErrors(screen: string): string[]` — the (trimmed) screen lines showing a transient API error. `newTransientErrors(before: string[], after: string[]): string[]` — the lines of `after` in excess of `before` (a multiset diff). `RETRY_DELAYS_MS: readonly number[]` = `[15_000, 30_000, 60_000]`.

- [ ] **Step 1: Write the test script (which fails)**

```js
// debug/test-retry.mjs — run: node debug/test-retry.mjs (after npm run build)
import assert from "node:assert/strict";
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "../dist/retry.js";

// 529 Overloaded (the exact message the user sees) matches.
const s529 = `  ⎿ API Error: 529 Overloaded. This is a server-side issue, usually
     temporary — try again in a moment.
❯ `;
assert.equal(findTransientErrors(s529).length, 1);

// Other transient errors match: 500, 503, 429, timeout, connection.
for (const line of [
  "API Error: 500 Internal Server Error",
  "API Error: 503 Service Unavailable",
  "API Error: 429 Too Many Requests",
  "API Error (Request timed out)",
  "API Error: Connection error",
  "API Error: fetch failed",
]) {
  assert.equal(findTransientErrors(line).length, 1, line);
}

// Non-transient errors do NOT match.
for (const line of [
  "API Error: 400 invalid_request_error",
  "API Error: 401 Unauthorized",
  "API Error: 403 Forbidden",
  "some ordinary output mentioning an error",
]) {
  assert.equal(findTransientErrors(line).length, 0, line);
}

// Multiset diff: an OLD error still on screen does not re-trigger…
const old = ["API Error: 529 Overloaded"];
assert.deepEqual(newTransientErrors(old, old), []);
// …but a SECOND occurrence of the same line is new.
assert.deepEqual(
  newTransientErrors(old, [...old, "API Error: 529 Overloaded"]),
  ["API Error: 529 Overloaded"],
);
// A fresh error on a previously clean screen is new.
assert.deepEqual(newTransientErrors([], old), old);

assert.deepEqual([...RETRY_DELAYS_MS], [15_000, 30_000, 60_000]);
console.log("test-retry: all assertions passed");
```

- [ ] **Step 2: Check that it fails**

Run: `node debug/test-retry.mjs`
Expected: FAIL — `Cannot find module '../dist/retry.js'`

- [ ] **Step 3: Implement `src/retry.ts`**

```ts
/**
 * Detection of transient API errors on the TUI screen, used by the server
 * to auto-retry a turn that died on one (529 Overloaded, 5xx, timeout…).
 * Pure functions, kept separate from server.ts so they can be tested.
 */

/** Auto-retry backoff: first, second and third attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000];

/**
 * A line worth retrying: "API Error" followed (same line) by a transient
 * cause — 5xx/429 status, overload, timeout or connection failure. Client
 * errors (400/401/403, invalid_request…) intentionally do not match.
 */
const TRANSIENT_ERROR =
  /API Error\b[^\n]*?(?:\b(?:5\d\d|429)\b|overloaded|timed? ?out|connection|ECONNRESET|ETIMEDOUT|fetch failed)/i;

/** The screen lines (trimmed) showing a transient API error. */
export function findTransientErrors(screen: string): string[] {
  return screen
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => TRANSIENT_ERROR.test(l));
}

/**
 * Multiset difference: the lines of `after` in excess of `before`. Used to
 * ignore an old error still visible on screen from a previous turn — only
 * a NEW occurrence triggers a retry.
 */
export function newTransientErrors(before: string[], after: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of before) counts.set(l, (counts.get(l) ?? 0) + 1);
  const fresh: string[] = [];
  for (const l of after) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else fresh.push(l);
  }
  return fresh;
}
```

- [ ] **Step 4: Build and check the test passes**

Run: `npm run build && node debug/test-retry.mjs`
Expected: `test-retry: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add src/retry.ts debug/test-retry.mjs
git commit -m "Add transient API error detection (retry.ts)"
```

---

### Task 2: Server wiring (`src/server.ts`)

**Files:**
- Modify: `src/server.ts` (imports; the `Live` interface ~l.90; `destroySession` ~l.138; `createSession` ~l.171; `finishTurn` ~l.225; the ws handlers ~l.253)

**Interfaces:**
- Consumes: `findTransientErrors`, `newTransientErrors`, `RETRY_DELAYS_MS` de `./retry.js` (Task 1).
- Produces (WS events to the client, consumed in Task 3):
  `{ type: "auto-retry", delayMs: number, attempt: number, max: number }`,
  `{ type: "auto-retry-cancelled" }`,
  `{ type: "auto-retry-gave-up", attempts: number }`,
  `{ type: "prompt-echo", text: "continue", auto: true }`.

- [ ] **Step 1: Import + `Live` fields + init + cleanup**

Add the import:

```ts
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "./retry.js";
```

In the `Live` interface, after `usage`:

```ts
  /** Pending auto-retry of a turn that died on a transient API error. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Auto-retry attempts consumed for the current error streak (0–3). */
  retryCount: number;
  /** Transient error lines already on screen when the turn started. */
  errorsAtTurnStart: string[];
```

In `createSession`, initialise inside the `s` literal:

```ts
    retryTimer: null,
    retryCount: 0,
    errorsAtTurnStart: [],
```

In `destroySession`, after the `idleTimer` cleanup:

```ts
  if (s.retryTimer) clearTimeout(s.retryTimer);
  s.retryTimer = null;
```

- [ ] **Step 2: `clearRetry` + `maybeScheduleRetry` + a hook in `finishTurn`**

Add after `finishTurn`:

```ts
/** Cancels a pending auto-retry (user took over, or session ends). */
function clearRetry(s: Live, notify = false) {
  if (!s.retryTimer) return;
  clearTimeout(s.retryTimer);
  s.retryTimer = null;
  if (notify) broadcast(s, { type: "auto-retry-cancelled" });
}

/**
 * If the turn died on a NEW transient API error (529 Overloaded, 5xx,
 * timeout…), schedules an automatic `continue` — 15 s, then 30 s, then
 * 60 s. Cancelled if the user takes over; gives up after 3 attempts.
 */
function maybeScheduleRetry(s: Live) {
  const fresh = newTransientErrors(
    s.errorsAtTurnStart,
    findTransientErrors(s.pilot.screen()),
  );
  if (fresh.length === 0) {
    s.retryCount = 0; // clean turn: the error streak is over
    return;
  }
  if (s.retryCount >= RETRY_DELAYS_MS.length) {
    broadcast(s, { type: "auto-retry-gave-up", attempts: s.retryCount });
    s.retryCount = 0;
    return;
  }
  const delayMs = RETRY_DELAYS_MS[s.retryCount];
  s.retryCount++;
  broadcast(s, {
    type: "auto-retry",
    delayMs,
    attempt: s.retryCount,
    max: RETRY_DELAYS_MS.length,
  });
  s.retryTimer = setTimeout(async () => {
    s.retryTimer = null;
    if (s.pilot.hasExited || s.busy) return;
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    broadcast(s, { type: "working" });
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  }, delayMs);
}
```

In `finishTurn`, capture the state at the start and fire at the end:

```ts
async function finishTurn(s: Live) {
  s.busy = true;
  s.errorsAtTurnStart = findTransientErrors(s.pilot.screen());
  broadcast(s, { type: "working" });
  try {
    await s.pilot.waitForIdle({ stableMs: 2000, timeoutMs: 900_000 });
    const dialog = detectDialog(s.pilot.screen());
    if (dialog) broadcast(s, { type: "dialog", ...dialog });
    else {
      broadcast(s, { type: "turn-done", sessionId: s.id });
      maybeScheduleRetry(s);
    }
  } finally {
    s.busy = false;
  }
}
```

- [ ] **Step 3: Cancelling when the user takes back control**

In the `ws.on("message", …)` handler, right before the `switch (msg.type)` (inside the `try`):

```ts
      // Any user takeover cancels a pending auto-retry and ends the streak.
      if (
        session &&
        ["prompt", "choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
```

(`settle` does not cancel — it is a plain "wait for the end of the turn". `stop` goes through `destroySession`, which cleans the timer.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0, no TypeScript error.

- [ ] **Step 5: Manual check of the detection**

Run:

```bash
node -e '
import("./dist/retry.js").then(({ findTransientErrors, newTransientErrors }) => {
  const before = [];
  const screen = "  ⎿ API Error: 529 Overloaded. This is a server-side issue\n❯ ";
  const fresh = newTransientErrors(before, findTransientErrors(screen));
  console.log(fresh.length === 1 ? "detection OK" : "detection BROKEN");
});'
```

Expected: `detection OK`

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "Auto-retry turns that die on a transient API error"
```

---

### Task 3: A status line on the client side (`public/index.html`)

**Files:**
- Modify: `public/index.html` (the `handleMessage` function, ~l.1509: the `prompt-echo` case ~l.1553 and new cases after `stopped` ~l.1622)

**Interfaces:**
- Consumes: the `auto-retry`, `auto-retry-cancelled`, `auto-retry-gave-up` and `prompt-echo.auto` events produced in Task 2. The client's existing functions: `addTurn(t, role, who, text)`, `setTabState(t, status, label)`, `setTabMood(t, mood)`, `stopTurnTimer(t)`.

- [ ] **Step 1: Label the automatic prompt-echo**

In `handleMessage`, replace the `prompt-echo` case:

```js
      case "prompt-echo":
        // Prompt sent by another tab/interface — or by the server itself
        // when it auto-retries a turn that died on a transient API error.
        addTurn(t, "user", msg.auto ? "auto-retry" : "pilot (elsewhere)", msg.text);
        break;
```

- [ ] **Step 2: Display the auto-retry events**

In `handleMessage`, add after the `stopped` case:

```js
      case "auto-retry":
        // The server will resend "continue" by itself; nothing to do here.
        addTurn(t, "system", "",
          "Transient API error — auto-retry in " + Math.round(msg.delayMs / 1000) +
          " s (attempt " + msg.attempt + "/" + msg.max + ")");
        setTabState(t, "ready", "auto-retry in " + Math.round(msg.delayMs / 1000) + " s");
        break;
      case "auto-retry-cancelled":
        setTabState(t, "ready", "ready");
        break;
      case "auto-retry-gave-up":
        addTurn(t, "system", "",
          "Transient API error persists after " + msg.attempts +
          " auto-retries — send a prompt to retry manually.");
        setTabMood(t, "needs-answer");
        break;
```

- [ ] **Step 3: Manual check of the rendering**

Run: `npm run build && node dist/server.js`, then open `http://localhost:3789`, start a session, and simulate the reception in the browser console:

```js
// In the browser devtools console, with a channel open:
// (handleMessage is in scope of the page's script)
// Simulate: error detected, retry scheduled, then gave up.
```

Since `handleMessage` is not exposed globally, the check goes through the real flow: cutting the network during a turn (or waiting for a real 529) is NOT required here — settle for checking that no JS error appears on load and that the app works as before (send a prompt, receive the answer).
Expected: no visible regression, no console error.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Show auto-retry status lines in the web client"
```
