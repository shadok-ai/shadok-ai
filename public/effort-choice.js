// How hard a single agent thinks before answering: the choices offered, and how
// one is spelled.
//
// Loaded as-is by the browser (ESM, served by express.static) and imported by
// the node/tsx tests, like public/model-choice.js — its twin, and the module to
// read first: a per-agent effort is the same shape as a per-agent model, down to
// the "" sentinel.
//
// Why a PICKER and not a text field like the profile panel's model: the CLI does
// not reject an unknown --effort value, it ignores it with a warning (verified
// on 2.1.300, which prints `Valid values: low, medium, high, xhigh, max`). A
// typo would therefore leave the agent at the default effort while the UI
// claimed otherwise — the silent-no-op failure this project keeps paying for.
//
// See docs/superpowers/specs/2026-10-14-agent-effort-design.md.

/**
 * What the picker offers, in increasing order of thinking.
 *
 * `""` is the sentinel for "whatever the profile says", NOT a level: it emits no
 * flag at all, which is what keeps this feature invisible to someone who never
 * opens it. `test/effort.test.ts` holds these ids against the server's
 * `EFFORT_LEVELS` whitelist, so the picker can never offer a level the server
 * refuses.
 */
export const EFFORT_CHOICES = [
  { id: "", label: "profile default" },
  { id: "low", label: "Low — answer fast" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max — think hardest" },
];

/** Pure: how a stored effort reads in a menu or a badge. */
export function effortLabel(effort) {
  const e = String(effort ?? "").trim();
  const found = EFFORT_CHOICES.find((c) => c.id === e);
  return found ? found.label : "profile default";
}
