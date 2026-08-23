# Design — A diverging pace bar (the 5h / 7d usage gauges)

Date: 2026-07-27
Status: agreed (brainstorming)

## Problem

The usage gauges in the header currently show, for each window (5h and 7d), **two
stacked 3px bars**: actual usage and the ideal pace (the fraction of the window
elapsed). The user reads the relation between the two (a usage bar longer than
the pace bar = we are spending faster than time passes) — but that is indirect:
it takes comparing two lengths.

We want to replace, for each window, those two bars with **a single diverging
bar** that materialises the usage/pace ratio directly.

## Scope

- **Frontend only** (`public/index.html`): the CSS of the `.quota` gauges and the
  `paintGauge` JS function.
- **No server change.** The data needed is already served by `/usage`: each
  window exposes `usedPercentage`, `idealPacePct`, `ratioPct`, `resetsAt`.
  `ratioPct` = `usedPercentage / idealPacePct * 100`.

Out of scope: the pace guard's logic (`src/pace.ts`), the ratio computation, the
endpoints, Telegram's behaviour.

## Design

### The concept: a diverging bar centred on "on pace"

For each window, a single horizontal bar.

- **The centre** of the bar = ratio 100 % (usage exactly at the pace of elapsed
  time). A discreet tick marks that point.
- The fill starts **from the centre**:
  - to the **left** when `ratioPct < 100` (below pace, there is headroom);
  - to the **right** when `ratioPct > 100` (above pace, burning too fast).
- **A symmetric linear scale.** We map the ratio onto a position
  `pos ∈ [-1, +1]`:

  ```
  pos = clamp((ratioPct - 100) / 100, -1, +1)
  ```

  So: the left edge = ratio 0 %; the centre = ratio 100 %; the right edge =
  ratio ≥ 200 % (pinned). Ratio 50 % → halfway left; ratio 150 % → halfway right.
  The fill's length = `|pos|` × half the width.

### Colour: a green → amber → red gradient

The fill's colour follows the ratio continuously:

- a low ratio (far left) → **solid green** (`--ok`): plenty of headroom;
- a ratio approaching 100 % (near the centre, from either side) → **amber**
  (`--amber`): a warning, we are reaching the pace;
- a ratio above it, towards the right edge → **red** (`--err`): overshooting.

Amber thus keeps the alert role it has in the current version (the `warn`
threshold started at ratio 70), while staying on the left/green side as long as
we are below pace. Implementation: interpolation between the existing CSS
variables (`--ok`, `--amber`, `--err`) through `color-mix`, or a colour computed
in JS. The hue is a function of the ratio, independent of the fill's length.

The rendering must stay readable in the light **and** dark themes (the
`--ok/--amber/--err` variables are already theme-aware). Green/red alone is not
enough to tell the state apart for a colour-blind viewer: the left/right
**position** relative to the centre carries the information redundantly (position
+ colour), which satisfies accessibility.

### A compact figure + a tooltip

- We keep the `5h` / `7d` label and a **small compact figure** next to the bar:
  the `% used` (as today), for the glance.
- A **tooltip** (`title`) on hover, with the precise values — already produced by
  `paintGauge` today, and kept:
  `<window> — X% used · ideal pace Y% · ratio Z% · resets in …`.

### The "no data" state

When the window is `null` (no token, a failed fetch), the bar is empty (pos = 0,
no fill), the figure shows `—`, and the tooltip is the base label. Identical to
the current behaviour.

## Components touched

| Element | Change |
|---|---|
| CSS `.quota .meter` (two stacked bars) | replaced by **one** diverging bar: a track with a central tick, the fill positioned absolutely from the centre (left/right). |
| CSS `.quota.warn/.crit .fill` | removed (the colour becomes continuous, computed). |
| HTML `#quota5h` / `#quota7d` | a single `.meter` instead of two (`usage` + `pace`). |
| JS `paintGauge(el, w)` | computes `pos` from `ratioPct`, positions the fill from the centre, applies the interpolated colour, keeps the `%used` figure and the tooltip. |

## Success criteria

1. Each window (5h, 7d) shows **one** centred diverging bar.
2. Below pace → a green fill on the left; above → red on the right; near the pace
   → amber. A continuous transition.
3. A central "on pace" tick is visible.
4. The tooltip gives precise usage / ideal pace / ratio / reset.
5. Readable in the light and dark themes.
6. `null` → an empty bar, `—`. No regression.
7. `npm run build` OK (no TS change, but we check), the rendering verified in the
   browser after a restart.
