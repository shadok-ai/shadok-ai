# Quota gauges — from divergent bar to 240° dial

Date: 2026-07-30
Status: validated, ready for an implementation plan

## Problem

The two header quota gauges (`.quota`, `#quota5h` / `#quota7d` in
`public/index.html`) are divergent bars: the fill starts at the centre tick
("on pace") and grows left in green when under pace, right in red when over.
`paintGauge` drives them from `ratioPct` (consumption ÷ ideal pace).

Three concrete defects:

1. **The right end means nothing legible.** `pos = (ratio − 100) / 100` clamped
   to ±1, so the bar is pinned right at `ratio = 200` — i.e. *twice* the ideal
   pace. Nothing on screen says that, and "twice the pace" is not a state a user
   has any feel for. Meanwhile the state that actually matters — *the quota is
   gone* — has no position on the bar at all.
2. **The consumption and the pace are two separate readings.** The `%` under the
   bar is `usedPercentage`; the bar itself is the ratio. They move independently
   and the eye has to combine them.
3. **A bar is the wrong metaphor for a signed deviation.** A progress bar reads
   as "how far along"; what these show is "am I ahead of or behind the clock".

## Scope

Only the two header quota gauges and the geometry that drives them. The
`/usage` endpoint, `src/pace.ts`, `src/usage.ts` and the pace guardrail are
**unchanged** — the payload already carries everything needed
(`usedPercentage`, `idealPacePct`, `ratioPct`, `resetsAt`).

**Explicitly out of scope:** the per-tab context-window bar (`.ctxbar`). That
one shows a context window filling up — a genuine "how far along" with no pace
to compare against — so a bar stays right for it.

## 1. The scale is piecewise, and that is the point

The dial's axis is *consumption*, but its centre is the *ideal pace*:

- far left = nothing consumed
- centre = exactly on ideal pace
- far right = quota exhausted

Since the ideal pace advances with the clock, the two halves have different
scales, and that is deliberate. At 25 % into the 5 h window the left half maps
used 0→25 % and the right half maps used 25→100 %. Both halves stay meaningful:
the centre always answers "am I on pace", the right end always answers "is it
gone".

Needle angle, measured from straight up (0° = on pace), sweeping ±120°:

```
p     = clamp(pace, 2, 98)
t     = used <= p ?  used / p - 1          // -1 … 0
                  : (used - p) / (100 - p) //  0 … +1
angle = clamp(t, -1, 1) * 120
```

`p` is clamped to `[2, 98]` because both ends of a window degenerate otherwise:
just after a reset the ideal pace is ~0 and the left half would collapse to a
point (every non-zero consumption would slam the needle to the centre); at the
very end of a window it is ~100 and the right half would collapse (any overage
would slam it hard right). Outside those bands the clamp costs a sub-degree
error, where accuracy actually matters — but *inside* them the error is not
sub-degree at all: it can reach 60° (e.g. pace 0.5 / used 1.5, or pace 99 /
used 99 — both burn 3x/exactly-on the real clock but the clamped needle alone
would put them on the wrong side of centre). The needle still makes the right
trade there — a pace that young or that old is not worth reading precisely —
but the tooltip's explanatory sentence is derived from the *unclamped*
comparison specifically so it cannot repeat the needle's simplification as
fact. See `dialTitle` in `public/gauge-dial.js`.

Note this reads `idealPacePct` directly rather than `ratioPct`. `ratioPct`
carries `PACE_EPSILON` in its denominator (`used / (pace + 2)`), which exists to
stop the *guardrail* from tripping on the first message after a reset. Baking
that fudge into the geometry would offset the needle from the tick it is
supposed to line up with. `ratioPct` is still quoted in the tooltip, where it
matches what the guardrail will say.

### Degenerate inputs

| Input | Behaviour |
|---|---|
| `idealPacePct == null` (reset time unknown) | Linear fallback `t = used / 50 - 1` (0 % left, 100 % right) and **the pace tick is hidden**. Consumption is still known honestly; where "on pace" sits is not, so we do not draw it. |
| window absent (`w == null`) | Dim grey arc, no needle, `—` instead of a percentage. |

## 2. Rendering

Inline SVG, roughly 56 × 44 px, replacing `.meter` / `.fill` / `.qpct`. The arc
spans 240° with its gap at the bottom (ends at about 7-8 and 4-5 o'clock).

- **Arc**: 24 evenly spaced graduation marks stepping `--ok` → `--amber` →
  `--err`, painted once and never recomputed. Not a smooth gradient: an SVG
  gradient cannot follow a path, and a plain horizontal one is degenerate here
  (below ±90° the arc curls back inward, so `sin(-120°) == sin(-60°)` and the
  outer 30° of each side would be painted with the colour of a completely
  different reading). Solid segments sidestep that, and the small gap between
  them reads as an instrument scale — deliberate, not a rendering compromise.
- **Pace tick**: a short bright mark at 12 o'clock, the reference the needle is
  read against. Hidden when there is no pace (see above).
- **Needle**: a short stroke from radius 12 to 20 (not from a hub — there is no
  hub dot; one would collide with the percentage, which is the primary
  reading), in neutral `--text`. A coloured needle on a coloured arc loses
  contrast exactly where the reading happens; real dials use a light needle
  over a coloured scale.
- **Percentage consumed**: large mono, centred, **tinted by the needle's
  position** (green → amber → red). It is the largest element on the widget, so
  the verdict is carried twice — by position *and* by colour — and never by
  colour alone.
- **`5h` / `7d`**: small and dim in the arc's bottom gap, where a real dial puts
  its unit. This absorbs today's separate `.label` and `.qpct` rows, so the
  header grows by roughly 9 px rather than 23 px.

Colour mixing reuses the existing `color-mix(in oklab, …)` approach of
`paceColor`, but keyed on the dial position `t` rather than on `ratioPct`, so
the tint and the needle can never disagree.

Motion: the needle animates its angle on update, suppressed under
`prefers-reduced-motion: reduce` — matching how `.led.busy` is already handled.

## 3. Code shape

The geometry becomes a **pure module, `public/gauge-dial.js`**, exporting
`dialAngle(used, pace)` and the position → colour mix. This follows the
established pattern of `public/live-text.js`, `public/notify.js` and
`public/profile-card.js`: an ESM module loaded by the browser (bridged onto
`window`) *and* imported directly by `test/gauge-dial.test.ts`. `paintGauge` in
`index.html` keeps only DOM work.

**Invariant 10 applies and must be handled explicitly.** `refreshUsage()` is
called at parse time today, and the `<script type="module">` that populates the
bridge runs *after* the document is parsed — so the first paint would read an
`undefined` function inside an unawaited async call and leave the dials blank
**in silence**, with tsc and the tests green. Two mitigations, both required:

- the first `refreshUsage()` call moves to `DOMContentLoaded`;
- `paintGauge` guards on the bridged function existing, and falls back to
  painting the percentage text only.

**Invariant 12 applies** to any new inline `<script>` block: it must carry the
`__CSP_NONCE__` marker, and interaction must go through `addEventListener`
rather than inline handlers. There is no new script block planned, but the SVG
must not introduce one.

## 4. Tooltip

A multi-line native `title`, with an identical `aria-label` on the SVG
(`role="img"`), so the dial is legible to a screen reader and to a hover:

```
5h rolling limit
42% consumed, ideal pace 31%, 135% of pace
Burning faster than the clock.
Resets in 3 h 12 min
```

(`·` is avoided as a separator: several screen readers announce it as "middle
dot".) Line 3 is what makes the piecewise scale self-explanatory — but it is
derived from the *unclamped* comparison between `usedPercentage` and
`idealPacePct`, not from the needle's (clamped) position: inside the clamp
bands the two can disagree, and a sentence that only describes where the
needle points can end up stating the opposite of what is actually happening
(see §1 above, and `dialTitle` in `public/gauge-dial.js`). Line 4 comes from
the existing `fmtReset`, and — as today — the whole line disappears when
`resetsAt` is null rather than leaving a dangling separator.

The reset time stays in the tooltip only. There is no room for it inside a
44 px dial without crowding out the percentage, which is the primary reading.

## 5. Testing

`test/gauge-dial.test.ts`, over the pure module:

| Case | Expected |
|---|---|
| `used == pace` | 0° (needle on the tick) |
| `used == 0` | −120° |
| `used == 100`, pace 50 | +120° |
| `used == pace / 2` | −60° |
| pace ~0 (window just reset) | clamped, left half still resolves |
| pace ~100 (window ending) | clamped, right half still resolves |
| `pace == null` | linear: 0 % → −120°, 50 % → 0°, 100 % → +120° |
| monotonicity | angle never decreases as `used` grows, across the seam at `used == pace` |

## 6. Verification

`npm run build`, then the browser — per CLAUDE.md, tsc green is not evidence for
a change with runtime surface, and invariant 10 is precisely the class of bug
that only the browser shows. Check both dials at a realistic pace, the no-pace
fallback, and the absent-window state.
