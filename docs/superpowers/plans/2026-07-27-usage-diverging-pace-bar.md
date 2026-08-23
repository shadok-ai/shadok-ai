# Barre de pace divergente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For each usage window (5h / 7d), replace the two stacked bars (usage + pace) with a single diverging bar centred on "on pace": green to the left (below pace) → amber in the centre → red to the right (above).

**Architecture:** A purely frontend change in `public/index.html`. We touch the `.quota` gauges' CSS, the markup of the two gauges, and the `paintGauge` JS function. No new data: `/usage` already serves `usedPercentage`, `idealPacePct`, `ratioPct` and `resetsAt` per window. The fill's position derives from `ratioPct` (centre = ratio 100), the colour is interpolated through `color-mix`.

**Tech Stack:** Vanilla HTML/CSS/JS (no front-end build, no JS test framework). A TypeScript ESM server (untouched). Verification = the browser.

## Global Constraints

- Frontend only: modify `public/index.html` and nothing else. No server change (`src/*.ts`), and none to the `/usage` protocol.
- Reuse the existing theme CSS variables `--ok` (green), `--amber`, `--err` (red), `--bg-inset`, `--line`, `--text-dim` — theme-aware (light + dark).
- The centre of each bar = ratio 100 % (on pace). A symmetric linear scale: `pos = clamp((ratioPct - 100) / 100, -1, +1)`. The left edge = ratio 0, the right edge = ratio ≥ 200.
- Redundant information, position + colour (colour-blind accessibility): below pace = left, above = right, independently of the colour.
- `w === null` (no data) → an empty bar, the figure `—`, tooltip = the base label. No regression on that state.
- Do NOT restart the server yourself (invariant #7 of CLAUDE.md): the browser check happens after a restart triggered by the human.

---

### Task 1: Barre divergente (CSS + markup + rendu JS)

Everything lives in `public/index.html` and changes together (structure, style, rendering). A single coherent task.

**Files:**
- Modify: `public/index.html` — bloc CSS `.quota` (~lignes 84-113), markup `#quota5h`/`#quota7d` (~lignes 803-814), fonction `paintGauge` (~lignes 2631-2660).

**Interfaces:**
- Consumes: the window object served by `/usage` — `{ usedPercentage:number, idealPacePct:number|null, ratioPct:number|null, resetsAt:number|null }`. The existing `fmtReset(resetsAt)` helper (returns "" when null).
- Produces: `paintGauge(el, w)` (signature unchanged, called by `refreshUsage`) + a new `paceColor(ratio:number): string` helper.

- [ ] **Step 1: Replace the `.quota` gauges' CSS**

In `public/index.html`, replace the current CSS block (the "Quota gauges …" comment through the end of `.quota .qpct`, ~lines 84-113) with:

```css
  /* Quota gauges (5h / 7d subscription usage).
     One diverging bar per window: the fill starts from the centre (= "on
     pace", ratio 100 %), green towards the left when we are BELOW pace, red
     towards the right when we are ABOVE. Position AND colour carry the
     information (accessibility). */
  .quota { min-width: 92px; }
  .quota .meter {
    position: relative;
    height: 6px;
    background: var(--bg-inset);
    border: 1px solid var(--line);
    border-radius: 3px;
    overflow: hidden;
    margin: 2px 0;
  }
  /* The central "on pace" tick. */
  .quota .meter::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 0; bottom: 0;
    width: 1px;
    margin-left: -0.5px;
    background: var(--text-dim);
    opacity: 0.55;
    z-index: 1;
  }
  /* The fill: left + width + background-color set inline by paintGauge. */
  .quota .fill {
    position: absolute;
    top: 0; bottom: 0;
    left: 50%;
    width: 0;
    background: var(--ok);
    transition: left 0.4s ease, width 0.4s ease, background-color 0.4s ease;
  }
  .quota .qpct {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
  }
```

Note: we remove the `.quota .meter.pace .fill`, `.quota.warn .meter.usage .fill` and `.quota.crit .meter.usage .fill` rules (the colour becomes continuous, computed in JS).

- [ ] **Step 2: Replace the two gauges' markup**

Replace (~lines 803-814) the two blocks with two `.meter` each by a single `.meter` each:

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

- [ ] **Step 3: Rewrite `paintGauge` + add `paceColor`**

Replace the current `paintGauge` function (~lines 2631-2660) with:

```js
  /** The fill's colour: a continuous green → amber → red gradient following the
   *  usage/pace ratio (0 → 100 → 200). Amber surrounds the "on pace" centre. */
  function paceColor(ratio) {
    if (ratio <= 100) {
      const t = Math.round(Math.max(0, ratio));            // 0 → green, 100 → amber
      return "color-mix(in oklab, var(--ok), var(--amber) " + t + "%)";
    }
    const t = Math.round(Math.min(100, ratio - 100));      // 100 → amber, 200 → red
    return "color-mix(in oklab, var(--amber), var(--err) " + t + "%)";
  }

  function paintGauge(el, w) {
    const fill = el.querySelector(".meter .fill");
    const pct = el.querySelector(".qpct");
    const base = el.id === "quota5h" ? "5-hour rolling limit" : "7-day rolling limit";
    if (!w) {
      fill.style.width = "0%";
      fill.style.left = "50%";
      fill.style.background = "var(--ok)";
      pct.textContent = "—";
      el.title = base;
      return;
    }
    const used = Math.round(w.usedPercentage);
    const pace = w.idealPacePct == null ? null : Math.round(w.idealPacePct);
    const ratio = w.ratioPct == null ? null : Math.round(w.ratioPct);
    // With no ratio (no computable pace) we centre: an empty bar + the tick alone.
    const r = ratio == null ? 100 : ratio;
    // Ratio → position [-1, +1]; 50 % (the centre) = on pace (ratio 100).
    const pos = Math.max(-1, Math.min(1, (r - 100) / 100));
    const half = Math.abs(pos) * 50;                       // % of the half width
    fill.style.left = (pos < 0 ? 50 - half : 50) + "%";
    fill.style.width = half + "%";
    fill.style.background = paceColor(r);
    pct.textContent = used + "%";
    // fmtReset returns "" when resetsAt is null (the separator goes with it).
    const reset = fmtReset(w.resetsAt);
    el.title = base + " — " + used + "% used"
      + (pace === null ? "" : ", ideal pace " + pace + "% (" + ratio + "% of pace)")
      + (reset ? " · " + reset : "");
  }
```

- [ ] **Step 4: Build (checks we broke nothing)**

Run : `cd ~/projects/shadok-ai && npm run build`
Expected: compiles with no error (no `.ts` touched, but we confirm the repo still builds).

- [ ] **Step 5 : Commit**

```bash
cd ~/projects/shadok-ai
git add public/index.html
git commit -m "Usage gauges: a diverging pace bar (green/amber/red, centred on pace)"
```

- [ ] **Step 6: Browser check (after a restart triggered by the human)**

Ask the human to restart the server (the CLAUDE.md command), then open http://localhost:3789 and check:

1. Two gauges (5h, 7d), each **a single** bar with a central tick.
2. With the current values (5h ratio ~21 %, 7d ratio ~27 %): a **green fill to the left** of the centre in both cases (well below pace).
3. Survol → tooltip `… — X% used, ideal pace Y% (Z% of pace) · resets in …`.
4. The compact figure = `% used` to the right of the bar.
5. Switching light/dark theme: colours and tick stay readable.
6. (Optional, a sanity check of the right-hand side): in the console, `paceColor(150)` → an amber→red mix at 50 %, `paceColor(30)` → a green→amber mix at 30 %.

---

## Self-Review

**1. Spec coverage :**
- A single diverging bar per window → Steps 1-3 ✓
- Centre = ratio 100, a symmetric scale `clamp((ratio-100)/100)` → Step 3 (`pos`) ✓
- A green→amber→red gradient as a function of the ratio → Step 3 (`paceColor`) ✓
- Tick central → Step 1 (`.meter::before`) ✓
- The compact `%used` figure + a precise tooltip → Step 3 ✓
- Theme-aware → CSS variables, Step 1 ✓; verified in Step 6 ✓
- The `null` state → Step 3 (the `if (!w)` branch) ✓
- Build OK + browser check → Steps 4, 6 ✓

**2. Placeholder scan:** no TBD/TODO; all the code is supplied in full.

**3. Type consistency:** `paintGauge(el, w)`'s signature is unchanged (called by `refreshUsage`, lines 2665-2666, not modified); `paceColor(ratio)` is defined and used in `paintGauge` under the same name; `fmtReset` is reused as is.
