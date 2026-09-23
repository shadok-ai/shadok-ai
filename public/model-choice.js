// The model a single agent runs on: the choices offered, and how one is spelled.
//
// Loaded as-is by the browser (ESM, served by express.static) and imported by
// the node/tsx tests, like public/tour-steps.js and public/gauge-dial.js. The
// composition lives here rather than inline in the popin because `[1m]` is a
// SUFFIX on a setting, and getting that string wrong is invisible: the agent
// simply runs on the standard window while the picker claims otherwise.
//
// See docs/superpowers/specs/2026-09-23-agent-model-design.md.

/**
 * What the picker offers, in order.
 *
 * ALIASES, not full model names. `claude --model` takes either, but an alias
 * resolves to the latest model of that family and a pinned name rots — the
 * profile panel still suggests `claude-opus-4-8`, which was current when it was
 * written and is not any more. An alias cannot drift that way, so the one list
 * a release can invalidate is kept as short as possible.
 *
 * `""` is the sentinel for "whatever the profile says", NOT a model: it emits
 * no flag at all, which is what makes this whole feature invisible to someone
 * who never touches it.
 */
export const MODEL_CHOICES = [
  { id: "", label: "profile default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

/**
 * Pure: the `--model` value for a choice, or null when there is nothing to say.
 *
 * The long-context window is selected per SESSION, by suffixing the model
 * setting with `[1m]` — it is not a model of its own and not an account-wide
 * switch, which is exactly why it belongs beside a per-agent picker rather than
 * on a profile shared by every agent of that role. `windowForModel` reads that
 * same suffix back off the setting (invariant 22), so the two spellings must
 * agree; that agreement is what the tests here hold.
 *
 * Long context with no model is deliberately NOT expressible: a bare `[1m]` is
 * not a valid setting, and silently dropping the flag would leave the box
 * ticked over an agent running the standard window.
 */
export function composeModel(alias, longContext) {
  const a = String(alias ?? "").trim();
  if (!a) return null;
  return longContext ? `${a}[1m]` : a;
}

/** Pure: does this stored setting ask for the long window? Twin of `composeModel`. */
export function isLongContext(model) {
  return /\[1m\]/i.test(String(model ?? ""));
}
