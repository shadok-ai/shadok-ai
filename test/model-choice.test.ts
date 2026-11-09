import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CHOICES, composeModel, isLongContext } from "../public/model-choice.js";
import { windowForModel } from "../src/context.js";

test("the default choice emits no flag at all", () => {
  // What keeps the feature invisible to anyone who ignores it: an untouched
  // picker must leave the spawn byte-for-byte as it was before this existed.
  assert.equal(MODEL_CHOICES[0].id, "");
  assert.equal(composeModel("", false), null);
  assert.equal(composeModel("", true), null);
  assert.equal(composeModel(undefined, false), null);
});

test("a choice is an alias, never a pinned model name", () => {
  // A pinned name rots: the profile panel still suggests `claude-opus-4-8`,
  // current when it was written and stale now. An alias resolves to the latest
  // model of its family, so the list cannot go quietly wrong between releases.
  for (const c of MODEL_CHOICES.slice(1)) {
    assert.match(c.id, /^[a-z]+$/, `${c.id} should be a bare alias`);
    assert.doesNotMatch(c.id, /^claude-/, `${c.id} pins a model name`);
  }
});

test("the long window is a suffix on the model, and needs one", () => {
  assert.equal(composeModel("opus", true), "opus[1m]");
  assert.equal(composeModel("opus", false), "opus");
  // A bare `[1m]` is not a valid setting. Emitting one — or silently dropping
  // the flag and leaving the box ticked — would run the agent on the standard
  // window while the picker claimed otherwise.
  assert.equal(composeModel("", true), null);
});

test("what composeModel writes, windowForModel reads back", () => {
  // The coupling that makes the checkbox mean something (invariant 22): the
  // gauge resolves the window from this very string. If the two spellings ever
  // drift, an agent on the long window is metered against 200k and the bar is
  // wrong for precisely the sessions that asked for more room.
  const big = windowForModel(composeModel("opus", true));
  const small = windowForModel(composeModel("opus", false));
  assert.ok(big > small, "the [1m] suffix must select a larger window");
  assert.ok(isLongContext(composeModel("sonnet", true)));
  assert.ok(!isLongContext(composeModel("sonnet", false)));
});
