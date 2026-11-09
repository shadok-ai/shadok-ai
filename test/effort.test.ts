import assert from "node:assert/strict";
import test from "node:test";
import { EFFORT_LEVELS, isEffortLevel, profileArgs } from "../src/profiles.js";
import { EFFORT_CHOICES, effortLabel } from "../public/effort-choice.js";
import { mergeChannels, upsertInto, type Channel } from "../src/channels.js";

// `--effort` is how much the model thinks before answering. Two facts about the
// CLI shape everything here, both verified against 2.1.300:
//   * an UNKNOWN value is not rejected, it is ignored with a warning — so a
//     typo that reaches the CLI is a silent no-op, and validation is ours;
//   * the valid set is exactly low|medium|high|xhigh|max (the CLI prints it).

test("the level set is the one the CLI accepts, in increasing order", () => {
  assert.deepEqual([...EFFORT_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
});

test("validation is a whitelist: anything else is refused, never passed through", () => {
  for (const ok of EFFORT_LEVELS) assert.equal(isEffortLevel(ok), true, ok);
  // "ultrathink" and "ultracode" are real words elsewhere in Claude Code and
  // neither is an effort level — exactly the kind of plausible typo that would
  // reach the CLI and do nothing.
  for (const bad of ["", "ultrathink", "ultracode", "HIGH", "auto", "none", "1"])
    assert.equal(isEffortLevel(bad), false, bad);
});

test("the picker's levels cannot drift from the validated ones", () => {
  // Two lists of the same five values (server whitelist, browser picker) is a
  // drift waiting to happen: the picker would offer a level the server refuses.
  const offered = EFFORT_CHOICES.map((c) => c.id).filter(Boolean);
  assert.deepEqual(offered, [...EFFORT_LEVELS]);
});

test("the picker leads with the sentinel that emits no flag at all", () => {
  // Same contract as MODEL_CHOICES: "" is not a level, it means "whatever the
  // profile says" — which is what keeps this invisible to whoever never opens it.
  assert.equal(EFFORT_CHOICES[0].id, "");
  assert.match(EFFORT_CHOICES[0].label, /profile/i);
});

test("a label exists for every level, and for nothing-set", () => {
  for (const l of EFFORT_LEVELS) assert.ok(effortLabel(l).length > 0, l);
  assert.match(effortLabel(null), /profile|default/i);
  assert.match(effortLabel(""), /profile|default/i);
});

// ── What reaches the CLI ──────────────────────────────────────────────────

// profileArgs also emits `--settings` (the cockpit's own Artifact deny) and
// `--model`; asserting on the whole array would make these tests fail for
// reasons that have nothing to do with effort. So read back just the flag.
function effortOf(args: string[]): string | null {
  const i = args.indexOf("--effort");
  return i === -1 ? null : args[i + 1];
}
const effortCount = (args: string[]) => args.filter((a) => a === "--effort").length;

test("a profile's effort becomes --effort at spawn", () => {
  assert.equal(effortOf(profileArgs({ name: "x", effort: "high" })), "high");
});

test("no effort anywhere emits no flag — an untouched install is unchanged", () => {
  assert.equal(effortOf(profileArgs({ name: "x" })), null);
  assert.equal(effortOf(profileArgs(null)), null);
});

test("the AGENT's effort wins over its role's, and only one flag is emitted", () => {
  // Same rule as --model: appending a second --effort would leave the CLI to
  // arbitrate a conflict we created.
  const args = profileArgs({ name: "x", effort: "low" }, null, "max");
  assert.equal(effortOf(args), "max");
  assert.equal(effortCount(args), 1);
});

test("an agent carries an effort with NO profile at all", () => {
  assert.equal(effortOf(profileArgs(null, null, "xhigh")), "xhigh");
});

test("an invalid effort never reaches the CLI, whichever side it came from", () => {
  // The CLI would ignore it with a warning nobody reads, and the agent would
  // run at the default while the picker claimed otherwise.
  assert.equal(effortOf(profileArgs({ name: "x", effort: "ultrathink" })), null);
  assert.equal(effortOf(profileArgs({ name: "x" }, null, "bogus")), null);
  // A bad override does NOT silently fall back to the role's level either:
  // that would run an agent at an effort nobody chose.
  assert.equal(effortOf(profileArgs({ name: "x", effort: "high" }, null, "bogus")), null);
});

test("effort rides alongside the model and the role, not instead of them", () => {
  const args = profileArgs({ name: "x", systemPrompt: "r", model: "opus", effort: "high" });
  // Order matters only in that each flag keeps its own value next to it.
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "r");
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(effortOf(args), "high");
});

// ── The effort SURVIVES the client ────────────────────────────────────────

test("a browser PUT cannot erase the effort the channel carries", () => {
  // `effort` is SERVER_OWNED: the browser round-trips the channel list and
  // knows nothing about it, so without that protection every PUT /channels
  // would drop a per-agent effort — the class of loss that cost nine agents
  // their profile during the 2026-09-24 restart churn.
  const stored: Channel[] = [{ id: "c1", name: "dev", sessionId: "s1", effort: "max" }];
  const fromClient: Channel[] = [{ id: "c1", name: "dev", sessionId: "s1" }];
  const merged = mergeChannels(stored, fromClient);
  assert.equal(merged[0].effort, "max");
});

test("the server can still change it — that is the only writer", () => {
  const stored: Channel[] = [{ id: "c1", name: "dev", sessionId: "s1", effort: "low" }];
  assert.equal(upsertInto(stored, { sessionId: "s1", effort: "high" })[0].effort, "high");
  // null is how a picker says "back to the profile's".
  assert.equal(upsertInto(stored, { sessionId: "s1", effort: null })[0].effort, null);
});
