# Quota Dial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two divergent quota bars in the header (`#quota5h`, `#quota7d`) with 240° speedometer dials whose centre is the ideal pace and whose right end is quota exhaustion.

**Architecture:** All geometry, colour and tooltip text move into a new pure ESM module `public/gauge-dial.js`, unit-tested by `test/gauge-dial.test.ts` — the pattern already used by `public/live-text.js`, `public/notify.js` and `public/profile-card.js`. `public/index.html` keeps only DOM work: inline SVG markup, CSS, and a rewritten `paintGauge`. No server file changes: `express.static` already serves `public/*.js`.

**Tech Stack:** Vanilla ESM (no build step for `public/`), inline SVG, CSS `color-mix(in oklab, …)`, `node --import tsx --test` for tests.

**Spec:** `docs/superpowers/specs/2026-07-30-quota-dial-design.md`

## Global Constraints

- **Everything written into the repo is in English** — comments, identifiers, commit messages, test names. (CLAUDE.md → Conventions.)
- Comments explain **why**, not what.
- ESM with `.js` extensions in imports. Node 20.
- **Invariant 10 (CLAUDE.md):** the `<script type="module">` bridge at `public/index.html:1279` runs *after* the document is parsed; the classic `<script>` below it runs *during*. Anything that paints on load must wait for `DOMContentLoaded` or guard on `window.<fn>`. Getting this wrong leaves blank dials **in silence** — tsc and tests stay green.
- **Invariant 12 (CLAUDE.md):** every inline `<script>` in `index.html` must carry the `__CSP_NONCE__` marker, and no inline event handlers (`onclick=`) — `test/csp.test.ts` enforces both. This plan adds no new script block; do not introduce one.
- Colours must come from the existing CSS variables: `--ok` `#7fc97f`, `--amber` `#f0a848`, `--err` `#e07a6a`, `--text` `#d8dae2`, `--text-dim` `#7d8293`.
- `color-mix(…)` must be applied via the **CSS property** (`el.style.stroke`, `el.style.fill`), never as an SVG presentation *attribute* — attribute parsing of `color-mix()` is not reliable across browsers. The existing code already does this (`fill.style.background = "color-mix(…)"`).
- Do **not** touch `src/pace.ts`, `src/usage.ts`, the `/usage` endpoint, or the per-tab context bar (`.ctxbar`).
- Run tests with `npm test`. Build with `npm run build`.

---

### Task 1: The pure geometry module

**Files:**
- Create: `public/gauge-dial.js`
- Test: `test/gauge-dial.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all named exports of `public/gauge-dial.js`:
  - `SWEEP_DEG: number` — `120`, the dial's half-sweep in degrees.
  - `DIAL: {cx: number, cy: number, r: number, w: number, h: number}` — the viewBox geometry, `{cx:28, cy:25, r:17, w:56, h:44}`.
  - `dialPos(used: number, pace: number|null): number` — position in `[-1, +1]`.
  - `dialAngle(used: number, pace: number|null): number` — degrees in `[-120, +120]`.
  - `dialColor(pos: number): string` — a CSS `color-mix()` string.
  - `dialPoint(deg: number, r?: number): {x: number, y: number}` — a point on the dial.
  - `arcSegments(n?: number): Array<{d: string, color: string}>` — the static gradient arc as solid SVG path segments.
  - `dialTitle(label: string, w: object|null, resetText: string): string` — the multi-line tooltip / aria-label.

Task 2 relies on every one of these names.

- [ ] **Step 1: Write the failing test**

Create `test/gauge-dial.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAL,
  SWEEP_DEG,
  arcSegments,
  dialAngle,
  dialColor,
  dialPoint,
  dialPos,
  dialTitle,
} from "../public/gauge-dial.js";

test("on the ideal pace puts the needle straight up", () => {
  assert.equal(dialAngle(30, 30), 0);
  assert.equal(dialAngle(70, 70), 0);
});

test("nothing consumed pins the needle hard left", () => {
  assert.equal(dialAngle(0, 40), -SWEEP_DEG);
});

test("quota exhausted pins the needle hard right", () => {
  assert.equal(dialAngle(100, 50), SWEEP_DEG);
});

test("halfway to the ideal pace is halfway up the left side", () => {
  assert.equal(dialAngle(20, 40), -SWEEP_DEG / 2);
});

test("halfway from the pace to exhaustion is halfway down the right side", () => {
  // pace 50 → the right half maps used 50…100, so 75 % is its midpoint.
  assert.equal(dialAngle(75, 50), SWEEP_DEG / 2);
});

test("a just-reset window keeps a usable left half", () => {
  // Without the clamp the ideal pace is ~0, the left half collapses to a point
  // and the first token of the window would slam the needle to the centre.
  assert.ok(dialAngle(1, 0) < -SWEEP_DEG / 4, "1 % consumed must still read as under pace");
  assert.equal(dialAngle(0, 0), -SWEEP_DEG);
});

test("a window about to reset keeps a usable right half", () => {
  // Symmetric case: pace ~100 would collapse the right half.
  assert.ok(dialAngle(99, 100) < SWEEP_DEG, "99 % consumed must not read as exhausted");
  assert.equal(dialAngle(100, 100), SWEEP_DEG);
});

test("no ideal pace falls back to a plain linear dial", () => {
  assert.equal(dialAngle(0, null), -SWEEP_DEG);
  assert.equal(dialAngle(50, null), 0);
  assert.equal(dialAngle(100, null), SWEEP_DEG);
});

test("the angle never goes backwards as consumption grows, across the seam", () => {
  // The seam at used == pace joins two different scales; a non-monotonic join
  // would make the needle jump backwards as the quota is spent.
  let prev = -Infinity;
  for (let used = 0; used <= 100; used += 0.5) {
    const a = dialAngle(used, 40);
    assert.ok(a >= prev, `angle dropped at used=${used}: ${a} < ${prev}`);
    prev = a;
  }
});

test("consumption outside 0…100 is clamped, not extrapolated", () => {
  assert.equal(dialAngle(-5, 40), -SWEEP_DEG);
  assert.equal(dialAngle(140, 40), SWEEP_DEG);
});

test("the colour runs green → amber → red across the sweep", () => {
  assert.match(dialColor(-1), /--ok\) 100%/);
  assert.match(dialColor(0), /--amber/);
  assert.match(dialColor(1), /--err\) 100%/);
});

test("dialPoint places the sweep ends low-left and low-right, symmetrically", () => {
  const left = dialPoint(-SWEEP_DEG);
  const right = dialPoint(SWEEP_DEG);
  assert.ok(left.x < DIAL.cx && right.x > DIAL.cx);
  assert.equal(left.y, right.y);
  assert.ok(left.y > DIAL.cy, "the sweep ends sit BELOW the hub — that is the 240° opening");
  assert.equal(dialPoint(0).y, DIAL.cy - DIAL.r);
});

test("every arc segment stays inside the viewBox", () => {
  // A segment escaping the box is clipped and the dial loses a chunk in silence.
  for (const { d } of arcSegments()) {
    for (const n of d.match(/-?\d+(\.\d+)?/g)!.map(Number)) {
      assert.ok(n >= -1 && n <= DIAL.w, `coordinate out of the viewBox: ${n} in ${d}`);
    }
  }
});

test("the arc is built from n coloured segments, first green and last red", () => {
  const segs = arcSegments(24);
  assert.equal(segs.length, 24);
  assert.match(segs[0].d, /^M /);
  assert.match(segs[0].color, /--ok/);
  assert.match(segs[23].color, /--err/);
});

test("the tooltip names the side the needle sits on", () => {
  const over = dialTitle("5h", { usedPercentage: 60, idealPacePct: 30, ratioPct: 188 }, "resets in 2h");
  assert.match(over, /^5h rolling limit\n/);
  assert.match(over, /60% consumed/);
  assert.match(over, /ideal pace 30%/);
  assert.match(over, /188% of pace/);
  assert.match(over, /faster than the clock/);
  assert.match(over, /resets in 2h$/);

  const under = dialTitle("7d", { usedPercentage: 10, idealPacePct: 40, ratioPct: 24 }, "");
  assert.match(under, /slower than the clock/);
  assert.ok(!under.endsWith("\n"), "an empty reset must not leave a dangling line");
});

test("the tooltip says so when there is no pace to compare against", () => {
  const t = dialTitle("5h", { usedPercentage: 12, idealPacePct: null, ratioPct: null }, "");
  assert.match(t, /12% consumed/);
  assert.match(t, /no reset time/i);
  assert.ok(!/of pace/.test(t), "without a pace we must not quote a ratio");
});

test("the tooltip degrades to 'no data' on an absent window", () => {
  assert.equal(dialTitle("7d", null, ""), "7d rolling limit\nno data");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/gauge-dial.test.ts`

Expected: FAIL — `Cannot find module '../public/gauge-dial.js'`.

- [ ] **Step 3: Write the implementation**

Create `public/gauge-dial.js`:

```js
// The 240° quota dial: its CENTRE is the ideal pace and its RIGHT END is
// exhaustion — see docs/superpowers/specs/2026-07-30-quota-dial-design.md.
//
// Loaded as-is by the browser (ESM) and imported by the node/tsx tests, like
// public/live-text.js, public/notify.js and public/profile-card.js. This module
// knows nothing about the DOM: it takes numbers and returns numbers, colour
// strings and SVG path data.

/** Half-sweep, in degrees. 0° is straight up and means "exactly on pace". */
export const SWEEP_DEG = 120;

/** The viewBox the SVG markup in index.html is drawn against. */
export const DIAL = { cx: 28, cy: 25, r: 17, w: 56, h: 44 };

/**
 * The ideal pace is clamped before it becomes the dial's midpoint, because both
 * ends of a window degenerate otherwise: just after a reset the pace is ~0 and
 * the left half collapses to a point (the first token spent would slam the
 * needle to the centre); at the very end of a window it is ~100 and the right
 * half collapses (any overage would read as "exhausted"). The clamp costs a
 * sub-degree of accuracy in the middle of a window, where accuracy matters, and
 * buys a readable dial at the edges, where it does not.
 */
const PACE_MIN = 2;
const PACE_MAX = 98;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Two decimals is plenty for a 56 px viewBox, and keeps the path data short. */
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Position on the dial: -1 nothing consumed, 0 exactly on the ideal pace, +1
 * quota exhausted.
 *
 * The two halves have DIFFERENT scales, deliberately: the pace advances with
 * the clock, so at 25 % into a window the left half maps used 0→25 % and the
 * right half maps used 25→100 %. That is what lets one axis answer both "am I
 * on pace" (the centre) and "is it gone" (the right end).
 *
 * `pace` is `idealPacePct` from /usage, NOT `ratioPct`: the latter carries
 * PACE_EPSILON in its denominator to keep the guardrail from tripping on the
 * first message after a reset, and baking that fudge in here would offset the
 * needle from the very tick it is supposed to line up with.
 */
export function dialPos(used, pace) {
  const u = clamp(used, 0, 100);
  // No reset time → no pace → we still know the consumption honestly, so fall
  // back to a plain linear 0→100 dial. The caller hides the pace tick.
  if (pace == null) return u / 50 - 1;
  const p = clamp(pace, PACE_MIN, PACE_MAX);
  return clamp(u <= p ? u / p - 1 : (u - p) / (100 - p), -1, 1);
}

/** Needle angle in degrees, from straight up, clockwise positive. */
export function dialAngle(used, pace) {
  return dialPos(used, pace) * SWEEP_DEG;
}

/**
 * Colour for a dial position. Amber at the centre, green towards "under pace",
 * red towards "exhausted" — the same oklab mix the divergent bar used, but keyed
 * on the dial position so the needle's tint and the arc under it can never
 * disagree.
 */
export function dialColor(pos) {
  const t = Math.round(clamp(pos, -1, 1) * 100);
  return t <= 0
    ? `color-mix(in oklab, var(--amber), var(--ok) ${-t}%)`
    : `color-mix(in oklab, var(--amber), var(--err) ${t}%)`;
}

/** A point on the dial, in viewBox units. `deg` is measured like dialAngle. */
export function dialPoint(deg, r = DIAL.r) {
  const a = (deg * Math.PI) / 180;
  return {
    x: round2(DIAL.cx + r * Math.sin(a)),
    y: round2(DIAL.cy - r * Math.cos(a)),
  };
}

/**
 * The gradient arc, as `n` solid segments.
 *
 * An SVG gradient cannot follow a path, and a plain horizontal one is
 * degenerate here: below ±90° the arc curls back inward, so sin(-120°) equals
 * sin(-60°) and the outer 30° of each side would be painted with the colour of
 * a completely different reading. Solid segments give a true along-the-sweep
 * gradient. They are built once and never repainted, so the extra nodes are free.
 */
export function arcSegments(n = 24) {
  const step = (2 * SWEEP_DEG) / n;
  // Each segment overlaps its neighbour slightly: butt-capped strokes leave
  // antialiasing seams otherwise, and the arc reads as a dashed line.
  const bleed = 0.6;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -SWEEP_DEG + i * step - (i === 0 ? 0 : bleed);
    const b = -SWEEP_DEG + (i + 1) * step + (i === n - 1 ? 0 : bleed);
    const p1 = dialPoint(a);
    const p2 = dialPoint(b);
    out.push({
      // large-arc-flag 0: every segment is well under 180°. sweep-flag 1:
      // clockwise on screen, i.e. towards increasing consumption.
      d: `M ${p1.x} ${p1.y} A ${DIAL.r} ${DIAL.r} 0 0 1 ${p2.x} ${p2.y}`,
      color: dialColor(-1 + (2 * i + 1) / n),
    });
  }
  return out;
}

/**
 * The multi-line tooltip, reused verbatim as the SVG's aria-label. The third
 * line is what makes the piecewise scale self-explanatory: it names which side
 * of the tick the needle sits on and what that means.
 *
 * `resetText` comes from the caller's fmtReset and is "" when resetsAt is null —
 * it is filtered out rather than joined, otherwise the tooltip ends on a blank
 * line (the same trap the old " · " separator had).
 */
export function dialTitle(label, w, resetText) {
  const head = `${label} rolling limit`;
  if (!w) return `${head}\nno data`;
  const r = Math.round;
  const used = `${r(w.usedPercentage)}% consumed`;
  if (w.idealPacePct == null) {
    return [head, used, "No reset time known, so there is no ideal pace to compare against.", resetText]
      .filter(Boolean)
      .join("\n");
  }
  const pos = dialPos(w.usedPercentage, w.idealPacePct);
  // A dead band around the tick: "on pace" should not flicker to "faster" on a
  // rounding wobble the eye cannot see on a 17 px radius anyway.
  const side =
    pos < -0.02
      ? "Needle left of centre: you are consuming slower than the clock."
      : pos > 0.02
        ? "Needle right of centre: you are burning faster than the clock."
        : "Needle on centre: exactly on the ideal pace.";
  return [
    head,
    `${used} · ideal pace ${r(w.idealPacePct)}% · ${r(w.ratioPct)}% of pace`,
    side,
    resetText,
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS — the new file's tests all green, and every pre-existing test still green (nothing else imports this module yet).

- [ ] **Step 5: Commit**

```bash
git add public/gauge-dial.js test/gauge-dial.test.ts
git commit -m "feat: pure geometry for the 240° quota dial

The dial's centre is the ideal pace and its right end is exhaustion, so the
two halves carry different scales on purpose. Clamping the pace to [2, 98]
keeps both halves readable at the edges of a window, where an unclamped pace
collapses one of them entirely."
```

---

### Task 2: Swap the header bars for the dials

**Files:**
- Modify: `public/index.html:160-201` (the `.quota` CSS block)
- Modify: `public/index.html:1024-1033` (the two gauge elements)
- Modify: `public/index.html:1279-1288` (the ESM bridge)
- Modify: `public/index.html:3938-3999` (`paceColor`, `paintGauge`, the `refreshUsage` bootstrap)

**Interfaces:**
- Consumes from Task 1: `dialPos`, `dialColor`, `arcSegments`, `dialTitle`, `SWEEP_DEG` — bridged onto `window` exactly as `notifyState` and `profileBlurb` already are.
- Produces: nothing for later tasks.

- [ ] **Step 1: Replace the `.quota` CSS block**

In `public/index.html`, delete the whole block from the comment `/* Quota gauges (5h / 7d subscription usage).` through the closing brace of `.quota .qpct { … }` (currently lines 160–201) and put this in its place:

```css
  /* Quota dials (5h / 7d subscription usage).
     A 240° speedometer whose CENTRE is the ideal pace and whose RIGHT END is
     exhaustion — see docs/superpowers/specs/2026-07-30-quota-dial-design.md.
     Position AND colour carry the reading, never colour alone. */
  .quota { min-width: 56px; }
  .dial { display: block; width: 56px; height: 44px; }
  .dial .arc path { fill: none; stroke-width: 4; opacity: 0.6; }
  /* No data: the scale stays, as a ghost, so the widget does not vanish. */
  .dial.nodata .arc path { opacity: 0.18; }
  /* The "on pace" reference, just outside the arc. The needle's tip meets it
     exactly when the consumption is on pace — they read as one line. */
  .dial .tick { stroke: var(--text); stroke-width: 1.5; opacity: 0.75; }
  .dial .needle {
    stroke: var(--text);
    stroke-width: 2;
    stroke-linecap: round;
    /* Rotated through the CSS transform PROPERTY, not the SVG attribute: only
       the property transitions reliably. transform-box/-origin put the pivot on
       the hub in viewBox units. */
    transform-box: view-box;
    transform-origin: 28px 25px;
    transition: transform 0.4s ease;
  }
  .dial .pct {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    fill: var(--text);
    transition: fill 0.4s ease;
  }
  .dial .unit {
    font-family: var(--mono);
    font-size: 8px;
    fill: var(--text-dim);
    letter-spacing: 0.08em;
  }
  @media (prefers-reduced-motion: reduce) {
    .dial .needle, .dial .pct { transition: none; }
  }
```

- [ ] **Step 2: Replace the two gauge elements**

Replace lines 1024–1033 of `public/index.html` (the two `<div class="gauge quota">` blocks) with:

```html
  <div class="gauge quota" id="quota5h" data-window="5h" title="5h rolling limit">
    <svg class="dial" viewBox="0 0 56 44" role="img" aria-label="5h rolling limit">
      <g class="arc"></g>
      <line class="tick" x1="28" y1="5" x2="28" y2="2" visibility="hidden"></line>
      <line class="needle" x1="28" y1="13" x2="28" y2="5" visibility="hidden"></line>
      <text class="pct" x="28" y="28" text-anchor="middle">—</text>
      <text class="unit" x="28" y="41" text-anchor="middle">5h</text>
    </svg>
  </div>
  <div class="gauge quota" id="quota7d" data-window="7d" title="7d rolling limit">
    <svg class="dial" viewBox="0 0 56 44" role="img" aria-label="7d rolling limit">
      <g class="arc"></g>
      <line class="tick" x1="28" y1="5" x2="28" y2="2" visibility="hidden"></line>
      <line class="needle" x1="28" y1="13" x2="28" y2="5" visibility="hidden"></line>
      <text class="pct" x="28" y="28" text-anchor="middle">—</text>
      <text class="unit" x="28" y="41" text-anchor="middle">7d</text>
    </svg>
  </div>
```

Note the `.label` and `.qpct` spans are gone: the window name now lives inside the arc's bottom opening, where a real dial puts its unit. That is what keeps the header growth to ~9 px.

The needle spans radius 12→20 (`y` 13→5 at rest) so it crosses the 4 px arc; the tick spans radius 20→23 (`y` 5→2), continuing where the needle tip stops. Both start hidden — `paintGauge` reveals them once there is data.

- [ ] **Step 3: Extend the ESM bridge**

In the `<script type="module" nonce="__CSP_NONCE__">` block at line 1279, add the import and the four window assignments:

```js
  import { extractLiveText } from "/live-text.js";
  import { profileBlurb, profileBadges } from "/profile-card.js";
  import { notifyState, BLINK_MS } from "/notify.js";
  import { dialPos, dialColor, arcSegments, dialTitle, SWEEP_DEG } from "/gauge-dial.js";
  window.extractLiveText = extractLiveText;
  window.profileBlurb = profileBlurb;
  window.profileBadges = profileBadges;
  window.notifyState = notifyState;
  window.BLINK_MS = BLINK_MS;
  window.dialPos = dialPos;
  window.dialColor = dialColor;
  window.arcSegments = arcSegments;
  window.dialTitle = dialTitle;
  window.SWEEP_DEG = SWEEP_DEG;
```

Do not add a new `<script>` tag — reuse this one, which already carries `__CSP_NONCE__`.

- [ ] **Step 4: Replace `paceColor` and `paintGauge`**

In `public/index.html`, delete `paceColor` (currently lines 3938–3947, comment included) and the whole `paintGauge` function (3949–3978), and put this in their place. `fmtReset` just above stays untouched.

```js
  /** Paints the static gradient arc of every dial. Runs once: the scale never
   *  changes, only the needle on top of it does. */
  function buildDialArcs() {
    if (!window.arcSegments) return;
    const NS = "http://www.w3.org/2000/svg";
    for (const g of document.querySelectorAll(".quota .dial .arc")) {
      g.replaceChildren(
        ...window.arcSegments().map(({ d, color }) => {
          const p = document.createElementNS(NS, "path");
          p.setAttribute("d", d);
          // Via the style PROPERTY: color-mix() is not reliably parsed as an
          // SVG presentation attribute.
          p.style.stroke = color;
          return p;
        }),
      );
    }
  }

  function paintGauge(el, w) {
    const svg = el.querySelector(".dial");
    const needle = svg.querySelector(".needle");
    const tick = svg.querySelector(".tick");
    const pct = svg.querySelector(".pct");
    const label = el.dataset.window;
    const title = window.dialTitle
      ? window.dialTitle(label, w, w ? fmtReset(w.resetsAt) : "")
      : label + " rolling limit";
    el.title = title;
    svg.setAttribute("aria-label", title);
    svg.classList.toggle("nodata", !w);
    // Guard on the ESM bridge (invariant 10): this function can be reached
    // before the module has run. Degrade to the number rather than paint a
    // needle at a wrong angle.
    if (!w || !window.dialPos) {
      needle.setAttribute("visibility", "hidden");
      tick.setAttribute("visibility", "hidden");
      pct.textContent = w ? Math.round(w.usedPercentage) + "%" : "—";
      pct.style.fill = "var(--text-dim)";
      return;
    }
    const pos = window.dialPos(w.usedPercentage, w.idealPacePct);
    needle.setAttribute("visibility", "visible");
    needle.style.transform = "rotate(" + (pos * window.SWEEP_DEG).toFixed(1) + "deg)";
    // Without a reset time there is no ideal pace, so there is nothing for the
    // tick to mark — drawing it would assert a reference we do not have.
    tick.setAttribute("visibility", w.idealPacePct == null ? "hidden" : "visible");
    pct.textContent = Math.round(w.usedPercentage) + "%";
    pct.style.fill = window.dialColor(pos);
  }
```

- [ ] **Step 5: Move the first paint to `DOMContentLoaded`**

At the bottom of `refreshUsage` (currently lines 3997–3998), replace:

```js
  refreshUsage();
  setInterval(refreshUsage, 60_000);
```

with:

```js
  // The ESM bridge (window.dialPos & co) runs AFTER this classic script — see
  // invariant 10 in CLAUDE.md. Painting now would leave blank dials in silence.
  document.addEventListener("DOMContentLoaded", () => {
    buildDialArcs();
    refreshUsage();
  });
  setInterval(refreshUsage, 60_000);
```

- [ ] **Step 6: Run the tests**

Run: `npm test`

Expected: PASS. Two pre-existing tests in `test/csp.test.ts` matter here and must stay green — "EVERY inline `<script>` block in index.html carries the marker" (no new script block was added) and "index.html has no inline event handler" (the SVG carries no `on*=` attribute).

- [ ] **Step 7: Verify no orphan references remain**

Run: `grep -n "qpct\|\.meter\|paceColor\|\.quota \.fill" public/index.html`

Expected: no output. Any hit is a leftover of the old bar — remove it.

- [ ] **Step 8: Build**

Run: `npm run build`

Expected: exit 0, no TypeScript errors. (`public/` is not compiled, but `src/server.ts` imports from `public/`, so a syntax error in the new module would surface here.)

- [ ] **Step 9: Commit**

```bash
git add public/index.html
git commit -m "feat: quota dials in the header, replacing the divergent bars

The bar pinned right at twice the ideal pace — a state nothing on screen
named — while 'the quota is gone' had no position at all. The dial puts both
readings on one axis: centre is the pace, right end is exhaustion.

First paint moves to DOMContentLoaded: the ESM bridge runs after this script
(invariant 10), and painting early leaves blank dials in silence."
```

---

### Task 3: Verify in the browser

**Files:** none modified — this task produces evidence, not code.

**Interfaces:** consumes the working tree from Task 2.

CLAUDE.md is explicit: tsc green is not evidence for a change with runtime surface, and invariant 10 is exactly the class of bug only a browser shows.

**Do NOT take over port 3789, and do not stop the running instance.** CLAUDE.md's "Running YOUR build" recipe used to say to — it was written for a human at a terminal, and it collided with invariant 8 and with `context/pilot-prompt.md`: an agent that stops the cockpit kills every sibling `sk-*` session mid-work, including the session this work is being driven from. That recipe has since been corrected to the side-by-side approach below. Do not edit `~/.shadok-ai/config.json` either; the running instance reads it.

Instead, run a **side-by-side instance on a free port** that structurally cannot become the npm build and cannot grab the Telegram bot. The three facts that make this safe, each verified in `src/server.ts` / `src/config.ts`:

- `START_PORT = Number(process.env.PORT ?? 3789)` (`src/server.ts:102`) — `PORT` only changes where the EADDRINUSE fallback walk *starts*; `MAX_PORT_TRIES = 20` (`src/server.ts:103`) still applies on top of it. Harmless for the safety argument here (3899 → 3900 → … climbs away from 3789, never toward it), but it is not true that pinning `PORT` removes the fallback dance.
- `SHADOK_VERSION_CHECK_MIN=0` disables the periodic `pollVersion` poll (`src/server.ts:878`), which is the call site that matters for an unattended side-by-side instance. It does not "remove the self-replacement path entirely", though: `triggerUpdate` has a second caller in the `POST /autoupdate` handler (`src/server.ts:893`), reachable only by a deliberate request this instance is never sent. Harmless in practice, but the poll and the handler are two separate paths and only the first is disabled here.
- `telegramConfig` keys the bot token by **launch dir** (`src/config.ts:98`, `cfg.tokens?.[cwd]`). The worktree path is not a key in `~/.shadok-ai/config.json`, so `token` is `null` and no bridge starts. Only one process can long-poll the bot, and this one will not try.

- [ ] **Step 1: Build, then start the side-by-side instance**

From the worktree:

```bash
npm run build
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js
```

Run it in the background and keep its PID. If port 3899 is taken, pick another free one above 3800 and use it consistently below.

- [ ] **Step 2: Confirm prod is untouched and you are on your own build**

```bash
curl -s localhost:3789/version    # the running cockpit — must still answer
curl -s localhost:3899/version    # yours
```

Expected: 3789 still responds (you did not disturb it), and 3899 reports `current: "0.1.0"` — the local package version. Also confirm your instance's startup output contains **no** `telegram:` bridge line; if it does, stop immediately and report, because it means it grabbed the bot from prod.

- [ ] **Step 3: Confirm your instance serves YOUR files**

```bash
curl -s localhost:3899/gauge-dial.js | head -5
```

Expected: the header comment of the module Task 1 created. If this 404s, the instance is serving a different `public/` and nothing below is meaningful.

- [ ] **Step 4: Check the dials in the browser**

Drive **http://localhost:3899** (your instance — never 3789) and confirm, for both dials:

1. The arc is drawn as 24 evenly spaced graduation marks — green at the lower left, amber at the top, red at the lower right — with uniform gaps between them, not dashed seams of uneven width.
2. The needle points somewhere sensible and the percentage sits inside the arc, tinted to match the needle's position.
3. The tick at 12 o'clock and the needle tip form one continuous line when consumption is on pace.
4. Hovering shows the four-line tooltip, and its pace-comparison line ("burning faster" / "consuming slower" / "exactly on pace") agrees with the needle — except deep in the needle's clamp bands (pace under 2 % or over 98 %), where the sentence is deliberately allowed to differ from the clamped needle (see Important-2 in the final review findings).
5. The header did not reflow onto two lines, and the toolbar buttons are still on one row.
6. **Reload the page several times.** A blank dial on even one reload means invariant 10 is still biting.

There is no interactive browser here, so drive it headlessly: borrow Playwright from `~/projects/aibrowser` (`node_modules/playwright` is installed there — require it by absolute path rather than installing anything into this worktree) and point it at `http://localhost:3899`. Screenshot the header region and save the PNGs under the SDD workspace so they can be attached to the PR. Read the screenshots back with the Read tool and judge them — a screenshot nobody looked at is not evidence.

Capture the browser console too, and treat **any** console error as a finding: a CSP violation or a failed module import is exactly how invariant 10 and invariant 12 show up, and both are silent in the DOM.

- [ ] **Step 5: Check the degraded states**

Force each one through `page.evaluate` and screenshot the result:

```js
// Absent window: ghost arc, no needle, no tick, "—".
paintGauge(document.getElementById("quota5h"), null);
// No reset time: needle shown on a linear scale, tick HIDDEN.
paintGauge(document.getElementById("quota7d"), { usedPercentage: 12, idealPacePct: null, ratioPct: null, resetsAt: null });
// Exhausted: needle hard right, red.
paintGauge(document.getElementById("quota5h"), { usedPercentage: 100, idealPacePct: 50, ratioPct: 192, resetsAt: null });
```

Note `paintGauge` lives in the page's classic script scope, so it is reachable from `page.evaluate` as a bare global. If it is not, report that rather than working around it — it would mean the script block did not execute at all.

Then reload to get back to live values. If `/usage` returns no data on this instance (no token for this launch dir), the live dials legitimately show the ghost state; the synthetic values above are then the whole visual check, and that is sufficient — say so in the report.

- [ ] **Step 6: Stop your instance and confirm prod is still healthy**

Stop the PID from Step 1. Nothing to restore: no config was edited and 3789 was never touched.

```bash
curl -s -o /dev/null -w '%{http_code}' localhost:3789/
curl -s -o /dev/null -w '%{http_code}' localhost:3899/
```

Expected: `3789` → `200` (the cockpit has been up the whole time), `3899` → connection refused. Leave no stray node process behind.

- [ ] **Step 7: Update the docs**

`CLAUDE.md` names `public/notify.js`, `public/live-text.js` and `public/profile-card.js` in its architecture map. Add the new module in the same style:

```markdown
| `public/gauge-dial.js` | Pure `dialPos` / `dialAngle` / `dialColor` / `arcSegments` / `dialTitle` — the geometry of the 240° quota dial, whose centre is the ideal pace and whose right end is exhaustion. ESM: loaded by the browser AND imported by `test/gauge-dial.test.ts`. |
```

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-07-30-quota-dial.md
git commit -m "docs: gauge-dial.js in the architecture map"
```

The plan file is included because Task 3's verification method was amended mid-execution: taking over port 3789 would have killed the cockpit hosting this very session, along with every sibling agent. The side-by-side instance verifies the same thing without touching shared state.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 piecewise scale, pace clamp `[2,98]`, `idealPacePct` not `ratioPct` | Task 1, `dialPos` + its tests |
| §1 degenerate: `idealPacePct == null` → linear, tick hidden | Task 1 (`dialPos`), Task 2 step 4 (tick), Task 3 step 5 |
| §1 degenerate: window absent → ghost arc, no needle, `—` | Task 2 steps 1 & 4, Task 3 step 5 |
| §2 240° arc with the gap at the bottom, ~56×44 | Task 1 `DIAL`/`dialPoint`, Task 2 step 2 |
| §2 static green→amber→red gradient arc | Task 1 `arcSegments`, Task 2 steps 1 & 4 |
| §2 pace tick at 12 o'clock | Task 2 steps 1 & 2 |
| §2 neutral needle | Task 2 step 1 (`stroke: var(--text)`) |
| §2 large % centred, tinted by position | Task 1 `dialColor`, Task 2 steps 2 & 4 |
| §2 `5h`/`7d` in the bottom opening | Task 2 step 2 |
| §2 `prefers-reduced-motion` | Task 2 step 1 |
| §3 pure module + test, following the existing pattern | Task 1 |
| §3 invariant 10: `DOMContentLoaded` **and** a guard | Task 2 steps 4 & 5, Task 3 step 4.6 |
| §3 invariant 12: no new script block, no inline handlers | Task 2 step 3, verified by `test/csp.test.ts` in step 6 |
| §4 four-line `title` + matching `aria-label` | Task 1 `dialTitle`, Task 2 step 4 |
| §4 reset line disappears when null, no dangling separator | Task 1 (`.filter(Boolean)`) + its test |
| §5 the full test table | Task 1 step 1 |
| §6 build then browser | Task 3 |

No gaps.

**Placeholders:** none — every code step carries the actual code.

**Type consistency:** the five bridged names (`dialPos`, `dialColor`, `arcSegments`, `dialTitle`, `SWEEP_DEG`) are exported in Task 1, bridged in Task 2 step 3 and consumed in Task 2 step 4 under exactly those names. `DIAL.cx`/`DIAL.cy` (28/25) match the hard-coded `transform-origin: 28px 25px` and the SVG `x`/`y` attributes; `DIAL.r` (17) matches the arc radius in `arcSegments`. `dialAngle` is exported and tested but not used by the browser code, which multiplies `dialPos` by `SWEEP_DEG` itself to reuse the same `pos` for the colour — deliberate, and the tests pin both to the same scale.
