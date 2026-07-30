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
 * half collapses (any overage would read as "exhausted"). Away from the bands
 * the clamp costs a sub-degree of accuracy, where accuracy matters — but
 * *inside* the bands (pace < 2 or > 98) the error is not sub-degree at all: it
 * can reach 60° (see `dialTitle`'s unclamped `side`, and the two tests that
 * cover it), because the needle is reading a clamped pace it does not have.
 * The trade is still the right one there: the pace is too young or too old to
 * mean much, and the alternative is a needle pinned uselessly at an extreme.
 *
 * `PACE_MIN` also has to stay ≤ the pace guardrail's own `PACE_EPSILON`
 * (`src/pace.ts`, currently both 2) for a property the dial depends on: the
 * guard blocks a prompt at `used > pace + PACE_EPSILON`, and the dial goes
 * right-of-centre at `used > clamp(pace, PACE_MIN, PACE_MAX)`. With
 * `PACE_MIN <= PACE_EPSILON` the dial crosses centre at or before the guard
 * blocks, so the gauge always warns before a send is refused, never after. Do
 * not couple the two constants across files for this — just keep it in mind
 * when either one changes, since nothing enforces it in code.
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

/** A point on the dial's rim, in viewBox units. `deg` is measured like dialAngle. */
export function dialPoint(deg) {
  const a = (deg * Math.PI) / 180;
  return {
    x: round2(DIAL.cx + DIAL.r * Math.sin(a)),
    y: round2(DIAL.cy - DIAL.r * Math.cos(a)),
  };
}

/**
 * Angular gap trimmed from each internal end of a segment, so the arc reads as
 * 24 evenly spaced graduation marks — a deliberate instrument scale, not a
 * smooth band. Trimmed only between segments: the sweep still spans the full
 * ±SWEEP_DEG, so the outer marks line up with the needle at its extremes.
 */
const GAP_DEG = 0.8;

/**
 * The gradient arc, as `n` solid segments.
 *
 * An SVG gradient cannot follow a path, and a plain horizontal one is
 * degenerate here: below ±90° the arc curls back inward, so sin(-120°) equals
 * sin(-60°) and the outer 30° of each side would be painted with the colour of
 * a completely different reading. Solid segments give a true along-the-sweep
 * gradient, and the gap between them is the point: 24 flat-coloured marks read
 * as an instrument scale, not as one smooth band pretending to be a gradient
 * it structurally cannot render. They are built once and never repainted, so
 * the extra nodes are free.
 */
export function arcSegments(n = 24) {
  const step = (2 * SWEEP_DEG) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -SWEEP_DEG + i * step + (i === 0 ? 0 : GAP_DEG / 2);
    const b = -SWEEP_DEG + (i + 1) * step - (i === n - 1 ? 0 : GAP_DEG / 2);
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
 * line is what makes the piecewise scale self-explanatory: it states whether
 * consumption is ahead of, behind, or on the ideal pace.
 *
 * `resetText` comes from the caller's fmtReset and is "" when resetsAt is null —
 * it is filtered out rather than joined, otherwise the tooltip ends on a blank
 * line.
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
  // Unclamped on purpose: dialPos clamps the pace to keep the NEEDLE readable at
  // the edges of a window, but the sentence must state what is actually happening.
  // Inside the clamp bands the two can disagree — a true sentence beside a clamped
  // needle beats a false one.
  const off = w.usedPercentage - w.idealPacePct;
  const side =
    off < -0.5
      ? "Consuming slower than the clock."
      : off > 0.5
        ? "Burning faster than the clock."
        : "Exactly on the ideal pace.";
  return [
    head,
    `${used}, ideal pace ${r(w.idealPacePct)}%, ${r(w.ratioPct)}% of pace`,
    side,
    resetText,
  ]
    .filter(Boolean)
    .join("\n");
}
