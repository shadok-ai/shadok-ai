# Quota gauges compared against the time remaining — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare the 5h and 7d windows' consumption against the time already elapsed, and block sends when consumption exceeds 100% of that ideal pace, with an explicit per-message override.

**Architecture:** A pure `src/pace.ts` module computes the pace and the blocking verdict from the raw data `src/usage.ts` already supplies. `src/server.ts` applies it at two points — `case "prompt"` and the auto-continue timer — and enriches `GET /usage`. `public/index.html` shows two stacked bars per gauge and renders a confirmation bubble reusing the existing `.turn.dialog` style.

**Tech Stack:** TypeScript (ESM, `module: NodeNext`), Node 20, Express 5, `ws`, tests via `node --import tsx --test`.

Reference spec: `docs/superpowers/specs/2026-07-20-pace-gauges-design.md`

## Global Constraints

- Seuil de blocage **100%**, en dur, non configurable. Aucune variable d'environnement.
- `PACE_EPSILON = 5`, added to the ideal pace in the denominator.
- Window lengths: `fiveHour = 5 * 3600` s, `sevenDay = 7 * 86400` s.
- No data (`usage` null, `resetsAt` null) ⇒ **never** a block.
- The override applies to **one message and one only** — no override state stored, server or client.
- Auto-continue is **never** forced: it waits and resumes on its own.
- `src/usage.ts` is **not** modified.
- Node 20 does not run TypeScript natively: every test command goes through `node --import tsx --test`.
- Internal imports carry the `.js` extension (NodeNext), including from `test/`.
- The files under `test/` are outside `tsconfig.json` (`include: ["src"]`) and are therefore not compiled into `dist` — that is intended.

## File Structure

| File | Role |
|---------|------|
| `src/pace.ts` | **Created.** Pure computation of the ideal pace and the blocking verdict. No I/O, no state. |
| `test/pace.test.ts` | **Created.** Unit tests of the pure module. |
| `src/server.ts` | **Modified.** Enriches `/usage`; applies the block in `case "prompt"`; puts auto-continue on hold. |
| `public/index.html` | **Modified.** Two-bar gauges; the override bubble; the hold state. |
| `package.json` | **Modified.** The `test` script covers `test/` on top of the skill's tests. |

---

### Task 1: Module de calcul du rythme

**Files:**
- Create: `src/pace.ts`
- Create: `test/pace.test.ts`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Consumes: `Usage` and `Window` from `src/usage.ts` (types only, the import erased at runtime).
- Produces:
  - `WINDOW_SEC: { readonly fiveHour: number; readonly sevenDay: number }`
  - `computePace(w: Window | null, durationSec: number, nowMs: number): Pace`
  - `paceBlock(u: Usage | null, nowMs: number): PaceVerdict`
  - `interface Pace { idealPacePct: number | null; ratioPct: number | null }`
  - `interface PaceVerdict { blocked: boolean; reason: string | null }`

- [ ] **Step 1: Write the failing tests**

Create `test/pace.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { computePace, paceBlock, WINDOW_SEC } from "../src/pace.js";
import type { Usage, Window } from "../src/usage.js";

/** Frozen clock: tests must never depend on the real time. */
const NOW = 1_700_000_000_000;

/** A window whose reset falls in `remainingSec` seconds. */
const win = (usedPercentage: number, remainingSec: number): Window => ({
  usedPercentage,
  resetsAt: NOW / 1000 + remainingSec,
});

const usage = (fiveHour: Window | null, sevenDay: Window | null): Usage => ({
  fiveHour,
  sevenDay,
  fetchedAt: NOW,
});

const round = (n: number | null) => (n === null ? null : Math.round(n));

test("5h: 90% used with 10 min left keeps the pace", () => {
  const p = computePace(win(90, 600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 97);
  assert.equal(round(p.ratioPct), 89);
});

test("5h: 3% used 5 min after the reset does not trip the epsilon", () => {
  const p = computePace(win(3, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 2);
  assert.equal(round(p.ratioPct), 45);
});

test("5h: 15% used 5 min after the reset crosses the threshold", () => {
  const p = computePace(win(15, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.ratioPct), 225);
});

test("7d: 55% used with 6 days left overshoots by a lot", () => {
  const p = computePace(win(55, 6 * 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 14);
  assert.equal(round(p.ratioPct), 285);
});

test("7d: 80% used with 1 day left keeps the pace", () => {
  const p = computePace(win(80, 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 86);
  assert.equal(round(p.ratioPct), 88);
});

test("resetsAt absent : pas de rythme calculable", () => {
  const p = computePace({ usedPercentage: 99, resetsAt: null }, WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, null);
  assert.equal(p.ratioPct, null);
});

test("expired window: the ideal pace is clamped at 100%", () => {
  const p = computePace(win(50, -3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 100);
  assert.equal(round(p.ratioPct), 48);
});

test("paceBlock: a single window above the threshold is enough", () => {
  const v = paceBlock(usage(win(90, 600), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d /);
});

test("paceBlock: both within bounds does not block", () => {
  const v = paceBlock(usage(win(90, 600), win(80, 86_400)), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock: the reason names the window with the highest ratio", () => {
  const v = paceBlock(usage(win(15, 17_700), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d /); // 285% l'emporte sur 225%
});

test("paceBlock: the reason carries all three figures", () => {
  const v = paceBlock(usage(null, win(55, 6 * 86_400)), NOW);
  assert.equal(v.reason, "7d: 55% used vs 14% ideal pace (285% of pace)");
});

test("paceBlock: missing usage never blocks", () => {
  assert.deepEqual(paceBlock(null, NOW), { blocked: false, reason: null });
});

test("paceBlock: a missing resetsAt never blocks", () => {
  const v = paceBlock(usage(null, { usedPercentage: 99, resetsAt: null }), NOW);
  assert.equal(v.blocked, false);
});
```

- [ ] **Step 2: Extend the test script**

In `package.json`, replace the `"test"` line:

```json
    "test": "node --import tsx --test test/ .claude/skills/shadok-ai-agents/test/",
```

- [ ] **Step 3: Run the tests to check they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '.../src/pace.js'`. The skill's 22 existing tests keep passing.

- [ ] **Step 4: Write the module**

Create `src/pace.ts`:

```ts
import type { Usage, Window } from "./usage.js";

/** Total length of each sliding window, in seconds. */
export const WINDOW_SEC = { fiveHour: 5 * 3600, sevenDay: 7 * 86400 } as const;

/**
 * Added to the ideal pace in the denominator. Without it the pace is near zero
 * right after a reset, and the smallest message would blow the ratio up.
 */
const PACE_EPSILON = 5;

/** Above this ratio (as a % of the ideal pace), we block. Hardcoded, on purpose. */
const BLOCK_RATIO = 100;

const LABEL = { fiveHour: "5h", sevenDay: "7d" } as const;

export interface Pace {
  /** 0–100: fraction of the window already elapsed. null when not computable. */
  idealPacePct: number | null;
  /** Usage relative to the ideal pace, in %. 100 = exactly on schedule. */
  ratioPct: number | null;
}

export interface PaceVerdict {
  blocked: boolean;
  reason: string | null;
}

/**
 * Relates a window's usage to the time already spent in it. Returns nulls when
 * the window is missing or its reset unknown — no data does not mean overrun.
 */
export function computePace(w: Window | null, durationSec: number, nowMs: number): Pace {
  if (!w || w.resetsAt === null) return { idealPacePct: null, ratioPct: null };
  const remainingSec = w.resetsAt - nowMs / 1000;
  // Clamped: a clock ahead of resetsAt must not produce a negative pace, nor
  // an expired window a pace above 100%.
  const idealPacePct = Math.min(100, Math.max(0, ((durationSec - remainingSec) / durationSec) * 100));
  return { idealPacePct, ratioPct: (w.usedPercentage / (idealPacePct + PACE_EPSILON)) * 100 };
}

/**
 * Blocks as soon as ONE of the two windows burns faster than time passes. The
 * reason names the window with the highest ratio. With no data it does not
 * block: an unavailable API must not lock the tool.
 */
export function paceBlock(u: Usage | null, nowMs: number): PaceVerdict {
  if (!u) return { blocked: false, reason: null };
  let worst: { label: string; used: number; pace: number; ratio: number } | null = null;
  for (const key of ["fiveHour", "sevenDay"] as const) {
    const w = u[key];
    const { idealPacePct, ratioPct } = computePace(w, WINDOW_SEC[key], nowMs);
    if (!w || idealPacePct === null || ratioPct === null) continue;
    if (ratioPct <= BLOCK_RATIO) continue;
    if (!worst || ratioPct > worst.ratio) {
      worst = { label: LABEL[key], used: w.usedPercentage, pace: idealPacePct, ratio: ratioPct };
    }
  }
  if (!worst) return { blocked: false, reason: null };
  const r = Math.round;
  return {
    blocked: true,
    reason: `${worst.label}: ${r(worst.used)}% used vs ${r(worst.pace)}% ideal pace (${r(worst.ratio)}% of pace)`,
  };
}
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `npm test 2>&1 | tail -12`
Expected: PASS — 35 tests (22 existants + 13 nouveaux), 0 fail.

- [ ] **Step 6: Check it compiles**

Run: `npm run build`
Expected: aucune sortie, aucune erreur TypeScript.

- [ ] **Step 7: Commit**

```bash
git add src/pace.ts test/pace.test.ts package.json
git commit -m "feat(pace): compute the 5h and 7d windows' ideal pace"
```

---

### Task 2: Enrichir GET /usage

**Files:**
- Modify: `src/server.ts:18` (imports), `src/server.ts:59-62` (route `/usage`)

**Interfaces:**
- Consumes: `computePace`, `paceBlock`, `WINDOW_SEC` de `src/pace.ts` (Task 1).
- Produces: `GET /usage`'s JSON response, consumed by `refreshUsage()` in Task 5:
  ```
  {
    fiveHour: { usedPercentage, resetsAt, idealPacePct, ratioPct } | null,
    sevenDay: { usedPercentage, resetsAt, idealPacePct, ratioPct } | null,
    fetchedAt: number,
    blocked: boolean,
    reason: string | null
  }
  ```

- [ ] **Step 1: Add the imports**

In `src/server.ts`, replace line 18 (`import { getUsage } from "./usage.js";`) with:

```ts
import { computePace, paceBlock, WINDOW_SEC } from "./pace.js";
import { getUsage, type Window } from "./usage.js";
```

The `Window` type is needed by the next step's `enrich` helper.

- [ ] **Step 2: Replace the route**

Replace lines 59-62:

```ts
// Current 5-hour and 7-day subscription usage (for the quota gauges).
app.get("/usage", async (_req, res) => {
  res.json((await getUsage()) ?? { fiveHour: null, sevenDay: null, fetchedAt: Date.now() });
});
```

par :

```ts
// Current 5-hour and 7-day subscription usage, each window enriched with how it
// compares to the time already elapsed (for the quota gauges and the send guard).
app.get("/usage", async (_req, res) => {
  const u = await getUsage();
  const now = Date.now();
  // The pace is derived per request, not per fetch: getUsage() caches for 60 s
  // and a frozen pace would drift away from the clock.
  const enrich = (w: Window | null, durationSec: number) =>
    w ? { ...w, ...computePace(w, durationSec, now) } : null;
  res.json({
    fiveHour: enrich(u?.fiveHour ?? null, WINDOW_SEC.fiveHour),
    sevenDay: enrich(u?.sevenDay ?? null, WINDOW_SEC.sevenDay),
    fetchedAt: u?.fetchedAt ?? now,
    ...paceBlock(u, now),
  });
});
```

- [ ] **Step 3: Check it compiles**

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 4: Check the route by hand**

```bash
node dist/server.js &
sleep 2
curl -s localhost:3789/usage | head -c 400; echo
kill %1
```

Expected: a JSON containing `blocked` and `reason`. With an OAuth token available, `fiveHour` carries numeric `idealPacePct` and `ratioPct`; otherwise `{"fiveHour":null,"sevenDay":null,...,"blocked":false,"reason":null}` — both are successes.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(pace): expose the pace and the verdict on GET /usage"
```

---

### Task 3: Block prompts above the pace

**Files:**
- Modify: `src/server.ts:94` (type `ClientMessage`), `src/server.ts:509-527` (`case "prompt"`)

**Interfaces:**
- Consumes: `paceBlock` and `getUsage` (already imported in Task 2).
- Produces:
  - Client message accepted: `{ type: "prompt", text: string, force?: boolean }`
  - Server message emitted: `{ type: "pace-blocked", reason: string | null, text: string }` — sent to the emitting client only, never broadcast. Consumed in Task 6.

- [ ] **Step 1: Allow `force` in the message type**

Replace line 94:

```ts
  | { type: "prompt"; text: string }
```

par :

```ts
  /** `force`: send despite a pace overrun. Applies to this message only. */
  | { type: "prompt"; text: string; force?: boolean }
```

- [ ] **Step 2: Add the check in `case "prompt"`**

In `case "prompt"` (server.ts:509), insert right after `if (!text) return;` (line 513) and before `session.lastPrompt = text;` (line 514):

```ts
          // Above the ideal pace, a prompt needs an explicit second click. The
          // check lives here because this is the single door every user prompt
          // goes through — including the pilotctl thin client.
          if (!msg.force) {
            const verdict = paceBlock(await getUsage(), Date.now());
            if (verdict.blocked) return send({ type: "pace-blocked", reason: verdict.reason, text });
          }
```

- [ ] **Step 3: Check it compiles**

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 4: Check the block by hand**

`paceBlock` only blocks when the real quota overshoots — impossible to provoke on demand. Force the verdict temporarily for the check:

```bash
# In src/pace.ts, make it return an unconditional block:
#   export function paceBlock(...) { return { blocked: true, reason: "test" }; }
npm run build && node dist/server.js &
sleep 2
```

Open http://localhost:3789, start a channel, send a prompt. Expected: no turn goes out; the Network tab shows the `pace-blocked` WebSocket frame. (The UI does not react yet — that is Task 6.)

**Restore `src/pace.ts` before committing**: `git diff src/pace.ts` must be empty.

- [ ] **Step 5: Check the tests still pass**

Run: `npm test 2>&1 | tail -8`
Expected: 35 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(pace): refuse prompts above the pace unless explicitly forced"
```

---

### Task 4: Put auto-continue on hold rather than let it consume

**Files:**
- Modify: `src/server.ts:331-369` (`maybeScheduleRetry`)

**Interfaces:**
- Consumes: `paceBlock`, `getUsage`.
- Produces: two messages broadcast to every client of the session, consumed in Task 6:
  - `{ type: "pace-hold", reason: string | null }` — emitted **once** per hold, not on every re-test.
  - `{ type: "pace-resumed" }` — emitted only when a hold had happened.

- [ ] **Step 1: Make the hold survive a refused prompt**

The hold lives in `s.retryTimer`. But the "user takeover" block runs before the `switch` and cancels the auto-retry for any `prompt` message — including a prompt the pace check is about to refuse. The hold would therefore die silently on the first send attempt, when it must resume on its own as soon as we are back under the threshold.

A refused prompt sends nothing: it is not a takeover. A prompt actually submitted — forced or not blocked — is one.

Replace the block at `src/server.ts:409-417`:

```ts
    try {
      // Any user takeover cancels a pending auto-retry and ends the streak.
      if (
        session &&
        ["prompt", "choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
```

par :

```ts
    try {
      // Any user takeover cancels a pending auto-retry and ends the streak.
      // "prompt" is settled inside its own case instead: a prompt refused on
      // pace grounds sends nothing, so it must not count as a takeover — it
      // would silently kill the pace pause it was just told about.
      if (
        session &&
        ["choose", "toggle", "freetext", "confirm", "key"].includes(msg.type)
      ) {
        clearRetry(session, true);
        session.retryCount = 0;
      }
```

Then, in `case "prompt"`, right after the pace check added in Task 3 (the `if (!msg.force) { … }` block) and before `session.lastPrompt = text;`, insert:

```ts
          // Getting here means the prompt is really being sent — that is the
          // takeover. A pending auto-retry (or pace pause) gives way to it.
          clearRetry(session, true);
          session.retryCount = 0;
```

- [ ] **Step 2: Add the re-test constant**

Juste au-dessus de `function maybeScheduleRetry` (server.ts:331), ajouter :

```ts
/**
 * How long between pace re-checks during a hold. Aligned with usage.ts's cache
 * TTL: the waiting loop issues no request to the API.
 */
const PACE_RECHECK_MS = 60_000;
```

- [ ] **Step 4: Replace the timer's body**

Replace lines 354-369:

```ts
  s.retryTimer = setTimeout(async () => {
    s.retryTimer = null;
    if (s.pilot.hasExited || s.busy) return;
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    s.turnStartedAt = Date.now();
    broadcast(s, { type: "working", startedAt: s.turnStartedAt });
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  }, delayMs);
```

par :

```ts
  // Set when the retry has been parked on a pace overrun, so the resume is
  // announced only to clients that were told about the pause.
  let held = false;
  const fire = async () => {
    s.retryTimer = null;
    if (s.pilot.hasExited || s.busy) return;
    // Never forced: an automatic turn must not spend quota the user is being
    // asked to hold back on. Park and re-test until the pace comes back down.
    const verdict = paceBlock(await getUsage(), Date.now());
    if (verdict.blocked) {
      if (!held) {
        held = true;
        broadcast(s, { type: "pace-hold", reason: verdict.reason });
      }
      s.retryTimer = setTimeout(fire, PACE_RECHECK_MS);
      return;
    }
    if (held) broadcast(s, { type: "pace-resumed" });
    broadcast(s, { type: "prompt-echo", text: "continue", auto: true });
    s.busy = true;
    s.turnStartedAt = Date.now();
    broadcast(s, { type: "working", startedAt: s.turnStartedAt });
    try {
      await s.pilot.submit("continue");
    } catch {
      return; // TUI unreachable: give the user back the controls
    } finally {
      s.busy = false;
    }
    await finishTurn(s).catch(() => {});
  };
  s.retryTimer = setTimeout(fire, delayMs);
```

The hold reuses `s.retryTimer`, so `clearRetry()` (server.ts:319) and the session cleanup (server.ts:188) cancel it with no extra code — including when the user takes back control (server.ts:396-402).

- [ ] **Step 5: Check it compiles**

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 6: Check the hold by hand**

The same method as Task 3 — force `paceBlock` to return `{ blocked: true, reason: "test" }`, then temporarily lower `RETRY_DELAYS_MS` in `src/retry.ts` to `[1000]` and `PACE_RECHECK_MS` to `2000` so as not to wait.

Provoking a transient error is awkward; failing that, verify by reading that the `blocked` path contains no `s.pilot.submit`.

Expected: `pace-hold` broadcast once, the timer rearmed every 2 s, no `continue` sent.

**Restore `src/pace.ts`, `src/retry.ts` and `PACE_RECHECK_MS` before committing**: `git diff src/pace.ts src/retry.ts` must be empty.

- [ ] **Step 7: Check the tests still pass**

Run: `npm test 2>&1 | tail -8`
Expected: 35 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts
git commit -m "feat(pace): hold auto-continue while the pace is exceeded"
```

---

### Task 5: Two-bar gauges

**Files:**
- Modify: `public/index.html:84-108` (CSS `.quota`), `public/index.html:748-757` (markup), `public/index.html:2078-2098` (`paintGauge` / `refreshUsage`)

**Interfaces:**
- Consumes: the `GET /usage` response defined in Task 2.
- Produces: two module-scoped variables, read in Task 6:
  - `let paceBlocked = false`
  - `let paceReason = null`

- [ ] **Step 1: Adapt the CSS**

Replace lines 84-102:

```css
  /* Quota gauges (5h / 7d subscription usage) */
  .quota { min-width: 92px; }
  .quota .meter {
    height: 6px;
    background: var(--bg-inset);
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
    margin: 1px 0;
  }
  .quota .fill {
    display: block;
    height: 100%;
    width: 0%;
    background: var(--ok);
    transition: width 0.4s ease;
  }
  .quota.warn .fill { background: var(--amber); }
  .quota.crit .fill { background: var(--err); }
```

par :

```css
  /* Quota gauges (5h / 7d subscription usage).
     Two stacked bars: what has been spent, and how much of the window has
     elapsed. Top bar longer than the bottom one = spending faster than time. */
  .quota { min-width: 92px; }
  .quota .meter {
    height: 3px;
    background: var(--bg-inset);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
    margin: 1px 0;
  }
  .quota .fill {
    display: block;
    height: 100%;
    width: 0%;
    background: var(--ok);
    transition: width 0.4s ease;
  }
  /* The pace bar is a reference, not a status: it never takes the alert colour. */
  .quota .meter.pace .fill { background: var(--text-dim); }
  /* Colour follows the RATIO, not the raw usage. */
  .quota.warn .meter.usage .fill { background: var(--amber); }
  .quota.crit .meter.usage .fill { background: var(--err); }
```

- [ ] **Step 2: Adapt the markup**

Replace lines 748-757:

```html
  <div class="gauge quota" id="quota5h" title="5-hour rolling limit">
    <span class="label">5h</span>
    <div class="meter"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
  <div class="gauge quota" id="quota7d" title="7-day rolling limit">
    <span class="label">7d</span>
    <div class="meter"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
```

par :

```html
  <div class="gauge quota" id="quota5h" title="5-hour rolling limit">
    <span class="label">5h</span>
    <div class="meter usage"><span class="fill"></span></div>
    <div class="meter pace"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
  <div class="gauge quota" id="quota7d" title="7-day rolling limit">
    <span class="label">7d</span>
    <div class="meter usage"><span class="fill"></span></div>
    <div class="meter pace"><span class="fill"></span></div>
    <span class="qpct">—</span>
  </div>
```

- [ ] **Step 3: Rewrite `paintGauge` and `refreshUsage`**

Replace lines 2078-2098 (from `function paintGauge` through `setInterval(refreshUsage, 60_000);` inclusive):

`paceBlocked` and `paceReason` are declared here but read by the composer, defined earlier in the file (line 1983). Harmless: both are only read when a send happens or a server message arrives, well after the script has run.

```js
  /** Last verdict from /usage — read by the composer before sending. */
  let paceBlocked = false, paceReason = null;

  function paintGauge(el, w) {
    const uFill = el.querySelector(".meter.usage .fill");
    const pFill = el.querySelector(".meter.pace .fill");
    const pct = el.querySelector(".qpct");
    const base = el.id === "quota5h" ? "5-hour rolling limit" : "7-day rolling limit";
    if (!w) {
      uFill.style.width = "0%";
      pFill.style.width = "0%";
      pct.textContent = "—";
      el.title = base;
      el.classList.remove("warn", "crit");
      return;
    }
    const used = Math.round(w.usedPercentage);
    const pace = w.idealPacePct == null ? null : Math.round(w.idealPacePct);
    const ratio = w.ratioPct == null ? null : Math.round(w.ratioPct);
    uFill.style.width = Math.min(100, used) + "%";
    pFill.style.width = (pace === null ? 0 : Math.min(100, pace)) + "%";
    pct.textContent = used + "%";
    // Colour tracks the ratio: 90% of the 5h window with 10 min left is fine,
    // 55% of the 7d window with 6 days left is not.
    el.classList.toggle("warn", ratio !== null && ratio >= 70 && ratio < 100);
    el.classList.toggle("crit", ratio !== null && ratio >= 100);
    el.title = base + " — " + used + "% used"
      + (pace === null ? "" : ", ideal pace " + pace + "% (" + ratio + "% of pace)")
      + " · " + fmtReset(w.resetsAt);
  }

  async function refreshUsage() {
    try {
      const u = await (await fetch("/usage")).json();
      paintGauge($("quota5h"), u.fiveHour);
      paintGauge($("quota7d"), u.sevenDay);
      paceBlocked = !!u.blocked;
      paceReason = u.reason || null;
    } catch { /* leave last values */ }
  }
  refreshUsage();
  setInterval(refreshUsage, 60_000);
```

- [ ] **Step 4: Check visually**

```bash
npm run build && node dist/server.js &
sleep 2
```

Open http://localhost:3789. Expected: each gauge shows two thin stacked bars; the bottom bar (pace) is grey. Hover a gauge: the tooltip gives consumption, ideal pace, ratio and reset. With no OAuth token both bars are empty and the tooltip reduces to the label — that is the expected behaviour.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(pace): two-bar gauges — consumption against elapsed time"
```

---

### Task 6: The override bubble and the hold state

**Files:**
- Modify: `public/index.html:1983-1996` (the composer's submit), `public/index.html:1907-1912` (the server-message switch)

**Interfaces:**
- Consumes: `paceBlocked` / `paceReason` (Task 5); the `pace-blocked` (Task 3), `pace-hold` and `pace-resumed` (Task 4) messages.
- Produces: nothing for later tasks — this is the last one.

- [ ] **Step 1: Extraire l'envoi du prompt**

Replace lines 1983-1996:

```js
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = active;
    const text = promptInput.value.trim();
    if (!text || t.status !== "ready" || t.pendingChoices || !t.ws) return;
    closeActivity(t);
    addTurn(t, "user", "pilot", text);
    startTurnTimer(t);
    setTabMood(t, "working");
    t.ws.send(JSON.stringify({ type: "prompt", text }));
    promptInput.value = "";
    promptInput.style.height = "auto";
    dropDraft(t);
  });
```

par :

```js
  function submitPrompt(t, text, force) {
    closeActivity(t);
    addTurn(t, "user", "pilot", text);
    startTurnTimer(t);
    setTabMood(t, "working");
    t.ws.send(JSON.stringify({ type: "prompt", text, ...(force ? { force: true } : {}) }));
    promptInput.value = "";
    promptInput.style.height = "auto";
    dropDraft(t);
  }

  /**
   * Above the ideal pace, ask before spending. Rendered in the thread like a TUI
   * question rather than as a modal — the codebase has no floating dialog.
   * Each blocked send asks again: forcing covers one message, never a session.
   */
  function renderPaceConfirm(tab, text, reason) {
    const turn = document.createElement("div");
    turn.className = "turn claude dialog";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "shadok-ai — pace exceeded";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const q = document.createElement("div");
    q.className = "question";
    q.textContent = (reason || "Consumption above the ideal pace")
      + " — send anyway?";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.textContent = "Forcer l'envoi";
    btn.addEventListener("click", () => {
      if (tab.status !== "ready" || !tab.ws) return;
      btn.disabled = true;
      submitPrompt(tab, text, true);
    });
    bubble.append(q, btn);
    turn.append(label, bubble);
    tab.transcriptEl.appendChild(turn);
    if (tab === active) tab.transcriptEl.scrollTop = tab.transcriptEl.scrollHeight;
  }

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = active;
    const text = promptInput.value.trim();
    if (!text || t.status !== "ready" || t.pendingChoices || !t.ws) return;
    // Checked here so nothing is optimistically rendered before the server
    // refuses. The server re-checks anyway — it is the authority.
    if (paceBlocked) return renderPaceConfirm(t, text, paceReason);
    submitPrompt(t, text);
  });
```

The text stays in the composer until the send is forced: nothing is lost if the user prefers to back out or rephrase.

- [ ] **Step 2: Handle the three server messages**

In the server-message `switch`, right after `case "auto-retry-gave-up"` (public/index.html:1907-1912) and before the closing brace, add:

```js
      case "pace-blocked":
        // The client's own check was stale (or the prompt came from elsewhere):
        // roll back the optimistic turn state, then ask.
        if (t.status === "busy") {
          stopTurnTimer(t);
          setTabMood(t, null);
          setTabState(t, "ready", "ready");
        }
        paceBlocked = true;
        if (msg.reason) paceReason = msg.reason;
        renderPaceConfirm(t, msg.text, msg.reason);
        break;
      case "pace-hold":
        addTurn(t, "system", "",
          "Auto-continue on hold — " + (msg.reason || "pace exceeded") +
          ". It resumes automatically once back under the threshold.");
        setTabState(t, "ready", "en attente du rythme");
        break;
      case "pace-resumed":
        addTurn(t, "system", "", "Pace back under the threshold — auto-continue resumed.");
        setTabState(t, "ready", "ready");
        break;
```

- [ ] **Step 3: Check the override path**

Force `paceBlock` to block as in Task 3:

```bash
# src/pace.ts : export function paceBlock(...) { return { blocked: true, reason: "7d : test" }; }
npm run build && node dist/server.js &
sleep 2
```

Open http://localhost:3789, start a channel, send a prompt.

Expected:
1. No user turn goes out; an amber-bordered bubble appears with the reason and the "Force send" button.
2. The text is still in the composer.
3. Clicking "Force send": the turn goes out, the composer clears, claude answers.
4. Send a second prompt: the bubble reappears — the override stored nothing.

**Restore `src/pace.ts` before committing**: `git diff src/pace.ts` must be empty.

- [ ] **Step 4: Check nothing regressed**

Run: `npm test 2>&1 | tail -8`
Expected: 35 pass, 0 fail.

Run: `npm run build`
Expected: aucune erreur.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(pace): a per-message override bubble and the auto-continue hold display"
```

---

## Self-Review — couverture du spec

| Spec requirement | Task |
|---|---|
| `computePace`, `paceBlock`, epsilon 5, seuil 100 en dur | 1 |
| Pace clamped 0–100 | 1 (the "expired window" test) |
| The reason naming the window with the highest ratio | 1 |
| No data ⇒ no block | 1 |
| `usage.ts` unmodified | 1–6 (no task touches it) |
| `/usage` enrichi + `blocked`/`reason` | 2 |
| Pace computed per request, not per fetch | 2 |
| Gating de `case "prompt"` + `force` | 3 |
| Override limited to one message | 3 (no server state), 6 (no client state) |
| Auto-continue held + resumed, never forced | 4 |
| `pace-hold` emitted once per hold | 4 |
| A 60 s re-test aligned with the cache TTL | 4 |
| Reuse of `s.retryTimer` for the cleanup | 4 |
| Two stacked bars, colour by ratio | 5 |
| Tooltip : usage, rythme, ratio, reset | 5 |
| Composer actif, bulle style `.turn.dialog` | 6 |
| A hold status line | 6 |
| The 60 s poll unchanged, no push channel | 5 |
| Tests of the pure functions | 1 |

## Accepted deviations

- **The optimistic user turn stays displayed** when it is the server that refuses (a client on a stale poll, or a prompt coming from `pilotctl`). The tab's state is properly reset to `ready`, but the prompt's bubble stays in the thread, followed by the confirmation request. The case is rare — the client checks before sending — and cleaning it up would take tracking the last turn's DOM element.
- **The manual checks of tasks 3, 4 and 6 require tampering with `paceBlock` temporarily**, since a real quota overrun cannot be provoked on demand. Each task reminds you to restore the file and verify with `git diff` before committing.
