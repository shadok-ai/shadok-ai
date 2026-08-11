# Guided Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A welcome screen explaining what shadok-ai is, followed by a four-stop spotlight tour of the real controls, skippable and replayable — and shown *before* the sign-in card on a brand-new instance.

**Architecture:** All the arithmetic and all the step data live in a new pure ESM module `public/tour-steps.js`, loaded by the browser and imported by `node:test` — the same shape as `gauge-dial.js` and `notify.js`. `public/index.html` gains one `#tourOverlay` used in two modes (centred card, or spotlight with a `box-shadow` hole over the target) plus the wiring. The only server-side change is none: `express.static` already serves `public/`.

**Tech Stack:** Vanilla ESM + DOM (no framework, no build for the client), `node:test` + `node:assert/strict` through tsx, TypeScript for the server (untouched here).

**Spec:** `docs/superpowers/specs/2026-08-11-guided-tour-design.md`

## Global Constraints

- **Everything written into the repo is in English** — comments, identifiers, commit messages, PR title and body, test names. The tour's user-facing copy is English, like the rest of the cockpit.
- **Every new inline `<script>` in `public/index.html` MUST carry `nonce="__CSP_NONCE__"`**, and every handler goes through `addEventListener` — never `onclick=` (invariant 12, locked by `test/csp.test.ts`).
- **Every new popin carries `class="overlay"`** (invariant 18).
- **Anything that paints on load waits for `DOMContentLoaded`** — the ESM bridge that puts module functions on `window` runs *after* the classic script (invariant 10). A silent `undefined` here is exactly how the profile grid once stayed blank.
- **Never restart the server on port 3789.** Verify side by side: `PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js`, from a directory *other than* this worktree (a zombie process currently holds this worktree's instance lock — see Task 5).
- Run `npm test` before every commit.
- Comments explain **why**, not what.

---

## File Structure

| File | Responsibility |
|---|---|
| `public/tour-steps.js` (create) | Pure: `TOUR_STEPS` data, `visibleSteps`, `unionRect`, `bubblePlacement`. No DOM. |
| `test/tour-steps.test.ts` (create) | Unit tests for the three functions and the step data. |
| `public/index.html` (modify) | `#tourOverlay` markup + CSS, the runtime wiring, the ⋯ menu entry, and the sign-in deferral. |
| `README.md`, `CLAUDE.md` (modify) | Docs, same PR. |

---

### Task 1: The pure core — `public/tour-steps.js`

**Files:**
- Create: `public/tour-steps.js`
- Create: `test/tour-steps.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TOUR_STEPS: Array<{id: string, title: string, body: string, target: string | string[] | null}>`
  - `visibleSteps(steps, isVisible): Array<step>` — `isVisible(target) => boolean`, called once per step; a `null` target is always kept.
  - `unionRect(rects): {top, left, width, height} | null` — rects are `{top, left, width, height}`.
  - `bubblePlacement({target, bubble, viewport, gap}): {top, left, side}` — `side` is `"below"` or `"above"`.

- [ ] **Step 1: Write the failing tests**

Create `test/tour-steps.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { TOUR_STEPS, bubblePlacement, unionRect, visibleSteps } from "../public/tour-steps.js";

const VIEW = { width: 1280, height: 900 };
const BUBBLE = { width: 340, height: 160 };

test("the welcome step has no target, every other step has one", () => {
  // The welcome step is the centred card; it must never be filtered out, which
  // is what a null target buys.
  assert.equal(TOUR_STEPS[0].target, null);
  assert.ok(TOUR_STEPS.slice(1).every((s) => s.target !== null));
  assert.ok(TOUR_STEPS.every((s) => s.id && s.title && s.body));
});

test("a step whose target is absent is dropped, never faked", () => {
  // THE rule of the feature: on a phone there is no agents column, on an empty
  // cockpit there is no active tab. A spotlight on empty space is worse than
  // no tour at all.
  const steps = [
    { id: "a", title: "A", body: "…", target: null },
    { id: "b", title: "B", body: "…", target: "#gone" },
    { id: "c", title: "C", body: "…", target: "#here" },
  ];
  const kept = visibleSteps(steps, (t) => t === "#here");
  assert.deepEqual(kept.map((s) => s.id), ["a", "c"]);
});

test("visibleSteps asks about an array target as a whole", () => {
  // The two dials are separate siblings; the step is kept when the group is.
  const steps = [{ id: "d", title: "D", body: "…", target: ["#x", "#y"] }];
  assert.equal(visibleSteps(steps, (t) => Array.isArray(t)).length, 1);
  assert.equal(visibleSteps(steps, () => false).length, 0);
});

test("unionRect encloses adjacent rects", () => {
  const a = { top: 10, left: 100, width: 40, height: 30 };
  const b = { top: 14, left: 150, width: 40, height: 30 };
  assert.deepEqual(unionRect([a, b]), { top: 10, left: 100, width: 90, height: 34 });
});

test("unionRect: one rect passes through, none yields null", () => {
  const a = { top: 1, left: 2, width: 3, height: 4 };
  assert.deepEqual(unionRect([a]), a);
  // null, not {0,0,0,0}: the caller must skip the step rather than frame the
  // top-left corner of the page.
  assert.equal(unionRect([]), null);
});

test("the bubble sits below the target and is centred on it", () => {
  const target = { top: 100, left: 500, width: 100, height: 40 };
  const p = bubblePlacement({ target, bubble: BUBBLE, viewport: VIEW, gap: 12 });
  assert.equal(p.side, "below");
  assert.equal(p.top, 152);            // 100 + 40 + 12
  assert.equal(p.left, 380);           // 500 + 50 - 170
});

test("a target near the bottom flips the bubble above it", () => {
  const target = { top: 820, left: 500, width: 100, height: 40 };
  const p = bubblePlacement({ target, bubble: BUBBLE, viewport: VIEW, gap: 12 });
  assert.equal(p.side, "above");
  assert.equal(p.top, 648);            // 820 - 160 - 12
});

test("the bubble is clamped inside the viewport on both edges", () => {
  const left = bubblePlacement({
    target: { top: 100, left: 0, width: 40, height: 40 },
    bubble: BUBBLE, viewport: VIEW, gap: 12,
  });
  assert.equal(left.left, 12);
  const right = bubblePlacement({
    target: { top: 100, left: 1240, width: 40, height: 40 },
    bubble: BUBBLE, viewport: VIEW, gap: 12,
  });
  assert.equal(right.left, 928);       // 1280 - 340 - 12
});

test("a bubble taller than the viewport still lands on screen", () => {
  // A phone in landscape with a big step: clamping must not produce a negative
  // top, which would put the text above the fold with no way to scroll to it.
  const p = bubblePlacement({
    target: { top: 10, left: 10, width: 40, height: 40 },
    bubble: { width: 340, height: 2000 }, viewport: { width: 390, height: 400 }, gap: 12,
  });
  assert.equal(p.top, 12);
  assert.equal(p.left, 12);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/tour-steps.test.ts`
Expected: FAIL — `Cannot find module '../public/tour-steps.js'`.

- [ ] **Step 3: Write the module**

Create `public/tour-steps.js`:

```js
// The guided tour: its step data and its geometry, with no DOM in sight.
//
// Loaded as-is by the browser (ESM, served by express.static) and imported by
// the node/tsx tests, like public/gauge-dial.js and public/notify.js. Keeping
// the arithmetic here is the point: bubble placement is what silently breaks on
// a screen size nobody tried, and that is exactly what a unit test can hold.
//
// See docs/superpowers/specs/2026-08-11-guided-tour-design.md.

/**
 * The tour, grouped on purpose: a spotlight frames a REGION, so nine landmarks
 * fit in four stops. A step per button is a tour people abandon.
 *
 * `target` is a CSS selector, an array of them (framed as one rectangle), or
 * null for the centred welcome card.
 */
export const TOUR_STEPS = [
  {
    id: "welcome",
    title: "Welcome to shadok-ai",
    body:
      "Every agent here is a real Claude Code session, running in its own directory " +
      "and its own git branch, so several can work at once without colliding. " +
      "You drive them from this page — or from Telegram, where one topic is one agent.",
    target: null,
  },
  {
    id: "agents",
    title: "Your agents live here",
    body:
      "Start one with “new agent”, and group them once there are a few. " +
      "At the bottom, “Tweak Shadok-AI” starts an agent on the cockpit's own source — " +
      "it delivers its work as a pull request.",
    target: "#tabbar",
  },
  {
    id: "tab",
    title: "Each agent has its own menu",
    body:
      "The ⋯ on an agent's tab is where its controls live: mute it, reload it, " +
      "rename it, change its profile, mirror it to Telegram, or close it.",
    target: ".tab.active",
  },
  {
    id: "tools",
    title: "The toolbar",
    body:
      "🔑 secrets injected into agents that need them · 👤 profiles (role, guardrails, model) · " +
      "⏰ scheduled prompts for monitoring · Telegram settings · 🔔 notifications · " +
      "⋯ for the diff of what an agent changed.",
    target: ".hdr-tools",
  },
  {
    id: "quota",
    title: "Watch your quota",
    body:
      "Your 5h and 7d subscription usage. The needle's centre is the pace that would " +
      "spend the window exactly on time, so leaning right means you're burning faster. " +
      "The version number next to the cockpit's name opens updates and the permission mode.",
    target: ["#quota5h", "#quota7d"],
  },
];

/** Pure: the steps whose target is on screen, in order. */
export function visibleSteps(steps, isVisible) {
  return steps.filter((s) => s.target === null || isVisible(s.target));
}

/**
 * Pure: the rectangle enclosing them all, or null when there are none.
 *
 * Null rather than a zero rect: a caller that framed {0,0,0,0} would put the
 * spotlight on the page's top-left corner instead of skipping the step.
 */
export function unionRect(rects) {
  if (!rects || !rects.length) return null;
  const top = Math.min(...rects.map((r) => r.top));
  const left = Math.min(...rects.map((r) => r.left));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  return { top, left, width: right - left, height: bottom - top };
}

/** Keeps `v` within [lo, hi]; when hi < lo (a bubble bigger than the screen), lo wins. */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/**
 * Pure: where to put the bubble for a given target.
 *
 * Below by default, flipped above when it would overflow the bottom, and
 * clamped to the viewport on both axes so it is never partly off screen.
 */
export function bubblePlacement({ target, bubble, viewport, gap = 12 }) {
  const below = target.top + target.height + gap;
  const fitsBelow = below + bubble.height + gap <= viewport.height;
  const side = fitsBelow ? "below" : "above";
  const rawTop = fitsBelow ? below : target.top - bubble.height - gap;
  const rawLeft = target.left + target.width / 2 - bubble.width / 2;
  return {
    side,
    top: clamp(rawTop, gap, viewport.height - bubble.height - gap),
    left: clamp(rawLeft, gap, viewport.width - bubble.width - gap),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/tour-steps.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the whole suite and the build**

Run: `npm test && npm run build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add public/tour-steps.js test/tour-steps.test.ts
git commit -m "feat: pure step data and geometry for the guided tour"
```

---

### Task 2: The overlay — markup and CSS

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: nothing (styling only).
- Produces: the DOM ids the next task wires — `#tourOverlay`, `#tourHole`, `#tourBubble`, `#tourTitle`, `#tourBody`, `#tourCount`, `#tourSkip`, `#tourNext`, and `#tourReplay` in the ⋯ menu.

- [ ] **Step 1: Add the menu entry**

In `#moreMenu` (search for `<button id="toggleDiff">Diff</button>`), after that line:

```html
      <button id="tourReplay">Guided tour</button>
```

- [ ] **Step 2: Add the overlay markup**

Immediately before `<main>`, next to the other overlays:

```html
<!-- The guided tour. ONE overlay, two modes: centred (the welcome card, using
     .overlay's own flex centring) and spotlight (.spotlight), where the dimming
     comes from #tourHole's huge box-shadow instead of the overlay background. -->
<div id="tourOverlay" class="overlay" hidden>
  <div id="tourHole" aria-hidden="true"></div>
  <div id="tourBubble" role="dialog" aria-labelledby="tourTitle">
    <strong id="tourTitle"></strong>
    <p id="tourBody"></p>
    <div id="tourFoot">
      <span id="tourCount" class="check-hint"></span>
      <span class="spacer"></span>
      <button id="tourSkip">Skip</button>
      <button id="tourNext" class="primary">Next ›</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add the CSS**

Next to the `.overlay` rules (search for `.overlay[hidden] { display: none; }`):

```css
  /* Above the other popins: during the tour it is the thing being interacted
     with, and the sign-in card may already be on screen behind it. */
  #tourOverlay { z-index: 60; }
  #tourBubble {
    max-width: 340px;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  }
  #tourBubble strong { display: block; margin-bottom: 6px; }
  #tourBubble p { color: var(--text-dim); font-size: 13px; line-height: 1.5; }
  #tourFoot { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  #tourFoot .spacer { flex: 1; }
  /* Spotlight mode: the overlay stops centring and stops dimming — the hole
     does the dimming, so the target stays at full brightness. */
  #tourOverlay.spotlight { display: block; padding: 0; background: transparent; backdrop-filter: none; }
  #tourOverlay.spotlight #tourBubble { position: fixed; }
  #tourHole {
    position: fixed;
    border-radius: 10px;
    box-shadow: 0 0 0 9999px rgba(8, 9, 13, 0.72);
    /* Clicks in the hole fall through to the overlay, which ends the tour —
       the same "click outside" gesture as everywhere else. */
    pointer-events: none;
    transition: top .18s ease, left .18s ease, width .18s ease, height .18s ease;
  }
  #tourOverlay:not(.spotlight) #tourHole { display: none; }
```

- [ ] **Step 4: Verify the page still parses and the CSP test still passes**

Run: `npm test`
Expected: green — in particular `test/csp.test.ts`, which scans `index.html`.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: guided-tour overlay markup and spotlight styling"
```

---

### Task 3: The runtime — running the tour

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `TOUR_STEPS`, `visibleSteps`, `unionRect`, `bubblePlacement` from Task 1; the ids from Task 2.
- Produces: `startTour(onEnd)` and `maybeStartTour()` on the classic script's scope, used by Task 4.

- [ ] **Step 1: Import the module in the ESM bridge**

In the `<script type="module" nonce="__CSP_NONCE__">` block, next to the other imports:

```js
  import { TOUR_STEPS, bubblePlacement, unionRect, visibleSteps } from "/tour-steps.js";
```

and next to the other `window.` assignments:

```js
  window.TOUR_STEPS = TOUR_STEPS;
  window.bubblePlacement = bubblePlacement;
  window.unionRect = unionRect;
  window.visibleSteps = visibleSteps;
```

- [ ] **Step 2: Add the runtime, in the classic script**

Place it next to the sign-in card block (search for `// --- Sign-in card`), *before* it:

```js
  // --- Guided tour --------------------------------------------------------
  const TOUR_SEEN_KEY = "shadok.tourSeen";
  let tourSteps = [];
  let tourAt = 0;
  let tourOnEnd = null;

  /** Every element a step points at, in DOM order. */
  function tourTargets(target) {
    const sels = Array.isArray(target) ? target : [target];
    return sels.map((s) => document.querySelector(s)).filter(Boolean);
  }

  /** On screen = present, not hidden, and actually occupying space. */
  function tourVisible(target) {
    return tourTargets(target).some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function paintTourStep() {
    const step = tourSteps[tourAt];
    if (!step) return endTour();
    const overlay = $("tourOverlay");
    $("tourTitle").textContent = step.title;
    $("tourBody").textContent = step.body;
    $("tourCount").textContent = `${tourAt + 1}/${tourSteps.length}`;
    $("tourNext").textContent = tourAt === tourSteps.length - 1 ? "Done" : "Next ›";

    if (step.target === null) {
      overlay.classList.remove("spotlight");
      $("tourBubble").style.top = $("tourBubble").style.left = "";
      return;
    }
    const rects = tourTargets(step.target).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    });
    const box = window.unionRect(rects);
    // The step was filtered in because it was visible; if it vanished since
    // (a closed tab), skip forward rather than frame nothing.
    if (!box) { tourAt++; return paintTourStep(); }
    overlay.classList.add("spotlight");
    const pad = 6;
    Object.assign($("tourHole").style, {
      top: box.top - pad + "px",
      left: box.left - pad + "px",
      width: box.width + pad * 2 + "px",
      height: box.height + pad * 2 + "px",
    });
    const b = $("tourBubble").getBoundingClientRect();
    const p = window.bubblePlacement({
      target: box,
      bubble: { width: b.width || 340, height: b.height || 160 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: 12,
    });
    Object.assign($("tourBubble").style, { top: p.top + "px", left: p.left + "px" });
  }

  /** Start the tour. `onEnd` runs once, whether it is completed or skipped. */
  function startTour(onEnd) {
    // window.visibleSteps comes from the ESM bridge, which runs AFTER this
    // classic script — so this must never be called at parse time (invariant 10).
    tourSteps = window.visibleSteps(window.TOUR_STEPS, tourVisible);
    if (!tourSteps.length) { onEnd?.(); return; }
    tourOnEnd = onEnd ?? null;
    tourAt = 0;
    $("tourOverlay").hidden = false;
    paintTourStep();
  }

  function endTour() {
    $("tourOverlay").hidden = true;
    $("tourOverlay").classList.remove("spotlight");
    try { localStorage.setItem(TOUR_SEEN_KEY, "1"); } catch { /* private mode */ }
    const done = tourOnEnd;
    tourOnEnd = null;
    done?.();
  }

  $("tourNext").addEventListener("click", () => { tourAt++; paintTourStep(); });
  $("tourSkip").addEventListener("click", endTour);
  // A click on the overlay itself — including through the hole, which has
  // pointer-events: none — ends it. Nobody is trapped in a tutorial.
  $("tourOverlay").addEventListener("click", (e) => { if (e.target === $("tourOverlay")) endTour(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("tourOverlay").hidden) { endTour(); e.preventDefault(); }
  });
  // Re-place on resize: a rotated phone moves every target.
  window.addEventListener("resize", () => { if (!$("tourOverlay").hidden) paintTourStep(); });
  $("tourReplay").addEventListener("click", () => {
    $("moreMenu").hidden = true;
    startTour(null);
  });
```

- [ ] **Step 3: Build and look at it in a real browser**

```bash
npm run build
mkdir -p /tmp/sk-uitest && cd /tmp/sk-uitest
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 SHADOK_TMUX=0 node <this-worktree>/dist/server.js &
```

Then screenshot with the volume-installed Playwright and **read the console back**:

```bash
PLAYWRIGHT_BROWSERS_PATH=/root/.shadok-ai/browsers \
  node /root/.shadok-ai/tools/shot.mjs /tmp/tour1.png http://localhost:3899/ "$SHADOK_GUI_PASSWORD"
```

Expected: the welcome card centred, console `(clean)`, horizontal overflow `0`. Then drive Next through every step and screenshot each — a spotlight landing on the wrong element is invisible to every test in this repo.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: run the guided tour, with skip, escape and replay"
```

---

### Task 4: The order — tour first, sign-in after

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `startTour(onEnd)` from Task 3, `checkAuth()` (existing).
- Produces: nothing further.

- [ ] **Step 1: Add the entry point, next to the tour runtime**

```js
  /**
   * First load: welcome and tour BEFORE the sign-in card.
   *
   * A fresh instance is signed out, so the card would otherwise be the very
   * first thing anyone sees — asking someone to authorise an OAuth flow before
   * they know what the thing is. The card is DEFERRED, never skipped: signing
   * in is not optional, so it opens the moment the tour ends either way.
   */
  function maybeStartTour() {
    let seen = false;
    try { seen = !!localStorage.getItem(TOUR_SEEN_KEY); } catch { seen = true; }
    if (seen) { checkAuth(); return; }
    startTour(() => checkAuth());
  }
```

- [ ] **Step 2: Replace the load-time call**

In the `DOMContentLoaded` handler (search for `buildDialArcs();`), change:

```js
    checkAuth();
```

to:

```js
    maybeStartTour();   // the tour runs first; it calls checkAuth() when it ends
```

Leave every other `checkAuth()` / `openAuthCard()` call alone — a spawn refused
with `code: "logged-out"` mid-session must still open the card at once.

- [ ] **Step 3: Verify the four orderings in the browser**

Against a **signed-out** instance. Use a stub `claude` whose `auth status` reports signed out, on PATH for the side server only:

```bash
mkdir -p /tmp/tourstub/bin
cat > /tmp/tourstub/bin/claude <<'SH'
#!/bin/bash
[ "$1" = "auth" ] && [ "$2" = "status" ] && { echo '{"loggedIn":false}'; exit 0; }
[ "$1" = "auth" ] && [ "$2" = "login" ] && { echo "If the browser didn't open, visit: https://claude.com/x"; sleep 60; }
echo "2.1.226 (Claude Code)"
SH
chmod +x /tmp/tourstub/bin/claude
```

Then check, with a fresh browser context each time (no `localStorage`):

1. first load → welcome card visible, `#authOverlay` **hidden**;
2. click Skip → `#authOverlay` becomes visible;
3. fresh context, click through to Done → `#authOverlay` becomes visible;
4. reload with `shadok.tourSeen` set → no tour, `#authOverlay` visible immediately.

- [ ] **Step 4: Commit**

```bash
npm test
git add public/index.html
git commit -m "feat: show the tour before the sign-in card, deferring it not skipping it"
```

---

### Task 5: Phone layout, and the zombie lock

**Files:** none — verification, plus one finding to report.

- [ ] **Step 1: Screenshot the tour at 390×844**

Adapt `shot.mjs`'s viewport (or pass a second script) and walk the steps. Expected: the `agents` step is **absent** (the column is hidden on phones) and the counter reads `1/4`, not `1/5` — this is the filtering rule doing its job. No horizontal overflow on any step.

- [ ] **Step 2: Report the instance-lock zombie**

Independent of this feature, found while testing it: `pidAlive` (`src/lock.ts`) uses `process.kill(pid, 0)`, which **succeeds on a zombie process**. In a container PID 1 is the shadok supervisor, which does not reap orphans, so a killed side instance leaves a zombie holding the lock — and that launch directory can never start an instance again.

Do **not** fix it inside this PR (unrelated surface). Open an issue, or raise it with the user, with the reproduction: start a side server, kill it, read `/proc/<pid>/stat` → state `Z`, and `acquireInstanceLock` still refuses.

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: `README.md`**

In "What you get", add a bullet: the guided tour on first load, what it covers, that Skip and Escape end it, that ⋯ → *Guided tour* replays it, and that on a brand-new instance it comes **before** the sign-in card.

- [ ] **Step 2: `CLAUDE.md`**

Add to the architecture map:

```
| `public/tour-steps.js` | Pure `TOUR_STEPS` / `visibleSteps` / `unionRect` / `bubblePlacement` — the guided tour's step data and geometry. A step whose target is not on screen is DROPPED, never faked (the phone has no agents column, an empty cockpit has no tab). ESM: loaded by the browser AND imported by `test/tour-steps.test.ts`. |
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: the guided tour"
```

---

## Self-Review

**Spec coverage:** the five-screen sequence and its targets → Task 1 (`TOUR_STEPS`). The skip-invisible-steps rule → Task 1 (`visibleSteps`) + Task 3 (`tourVisible`). The spotlight mechanics → Task 2. `bubblePlacement` / `unionRect` pure and tested → Task 1. Skip / Escape / click-outside / replay → Task 3. `localStorage` persistence → Tasks 3 and 4. Tour-before-sign-in, deferred not skipped → Task 4. Browser + phone verification → Tasks 3 and 5. Docs → Task 6.

**Type consistency:** `TOUR_STEPS`, `visibleSteps`, `unionRect`, `bubblePlacement` keep the same names and shapes from Task 1 through Tasks 3 and 4. `bubblePlacement` takes one options object (`{target, bubble, viewport, gap}`) everywhere. Rects are `{top, left, width, height}` throughout — never DOMRect, which also carries `x/y/right/bottom` and would tempt a caller into using fields the pure functions ignore.

**Known soft spot:** Task 3 measures the bubble with `getBoundingClientRect()` *before* placing it, so on the very first spotlight step the element has just become visible and may report a stale size; the `|| 340` / `|| 160` fallbacks cover a zero measurement, and the `resize` handler re-places. If a first step ever lands visibly off, place it twice (measure, place, measure, place) rather than hard-coding the size.
