// The quota meters (5h / 7d): index.html renders a FLAT BAR whose length is the
// quota consumed, with a marker at the ideal pace (the share of the window's
// time already elapsed) — see docs/superpowers/specs/2026-10-30-quota-bar-design.md
// (it replaced the 240° dial of 2026-07-30-quota-dial-design.md).
//
// This module is the PURE core (no DOM): it turns the usage numbers into the
// pace POSITION (−1 nothing / 0 on pace / +1 exhausted) and the COLOUR that
// encodes ahead-of / behind-the-clock, plus the multi-line tooltip. The bar's
// length and the marker's position are the raw percentages and need no maths —
// so all that lives here is the colour scale and the words. Loaded as-is by the
// browser (ESM) and imported by the node/tsx tests, like public/live-text.js,
// public/notify.js and public/profile-card.js.

/**
 * The ideal pace is clamped before it becomes the position's midpoint, because
 * both ends of a window degenerate otherwise: just after a reset the pace is ~0
 * and the "under pace" half collapses to a point (the first token spent would
 * read as on pace); at the very end of a window it is ~100 and the "over pace"
 * half collapses (any overage would read as "exhausted"). Away from the bands
 * the clamp costs a sub-percent of accuracy — but *inside* the bands (pace < 2
 * or > 98) the error is larger (see `dialTitle`'s unclamped `side`, and the two
 * tests that cover it), because the colour is reading a clamped pace it does not
 * have. The trade is still the right one there: the pace is too young or too old
 * to mean much.
 *
 * `PACE_MIN` also has to stay ≤ the pace guardrail's own `PACE_EPSILON`
 * (`src/pace.ts`, currently both 2) for a property the meter depends on: the
 * guard blocks a prompt at `used > pace + PACE_EPSILON`, and the fill turns red
 * (crosses the on-pace point) at `used > clamp(pace, PACE_MIN, PACE_MAX)`. With
 * `PACE_MIN <= PACE_EPSILON` the fill reddens at or before the guard blocks, so
 * the gauge always warns before a send is refused, never after. Do not couple
 * the two constants across files for this — just keep it in mind when either one
 * changes, since nothing enforces it in code.
 */
const PACE_MIN = 2;
const PACE_MAX = 98;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The pace position that drives the fill COLOUR: -1 nothing consumed, 0 exactly
 * on the ideal pace, +1 quota exhausted. (The fill's LENGTH and the marker's
 * position are the raw `usedPercentage` / `idealPacePct` — not this.)
 *
 * The two halves have DIFFERENT scales, deliberately: the pace advances with
 * the clock, so at 25 % into a window the left half maps used 0→25 % and the
 * right half maps used 25→100 %. That is what lets the single number answer both
 * "am I on pace" (0) and "is it gone" (+1).
 *
 * `pace` is `idealPacePct` from /usage, NOT `ratioPct`: the latter carries
 * PACE_EPSILON in its denominator to keep the guardrail from tripping on the
 * first message after a reset, and baking that fudge in here would offset the
 * colour from the very pace the marker sits on.
 */
export function dialPos(used, pace) {
  const u = clamp(used, 0, 100);
  // No reset time → no pace → we still know the consumption honestly, so fall
  // back to a plain linear 0→100 scale. The caller hides the pace marker.
  if (pace == null) return u / 50 - 1;
  const p = clamp(pace, PACE_MIN, PACE_MAX);
  return clamp(u <= p ? u / p - 1 : (u - p) / (100 - p), -1, 1);
}

/**
 * Colour for a pace position. The accent at the on-pace point, green towards
 * "under pace", red towards "exhausted" — an oklab mix keyed on the position so
 * the fill's tint always agrees with where it sits relative to the pace marker.
 */
export function dialColor(pos) {
  const t = Math.round(clamp(pos, -1, 1) * 100);
  return t <= 0
    ? `color-mix(in oklab, var(--amber), var(--ok) ${-t}%)`
    : `color-mix(in oklab, var(--amber), var(--err) ${t}%)`;
}

/**
 * The multi-line tooltip, reused verbatim as the gauge's aria-label. The third
 * line is what makes the reading self-explanatory: it states whether
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
  // Unclamped on purpose: dialPos clamps the pace to keep the FILL COLOUR readable
  // at the edges of a window, but the sentence must state what is actually
  // happening. Inside the clamp bands the two can disagree — a true sentence
  // beside a clamped tint beats a false one.
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
