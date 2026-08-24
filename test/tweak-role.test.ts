import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Shadok-Tweak role is the whole product for someone who is not a
// developer: it is all that stands between "I'd like a button here" and a wall
// of git vocabulary. It is prose, so nothing but a test keeps its intent from
// being rewritten away — the same reason DEFAULT_PROFILES' prompts are asserted.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLE = fs.readFileSync(path.join(HERE, "..", "context", "tweak-prompt.md"), "utf8");

test("the role addresses a non-developer BEFORE it explains any procedure", () => {
  // Ordering is the fix: this rule used to be the last paragraph, after eighty
  // lines of git, and it read as an afterthought because it was one.
  const audience = ROLE.indexOf("## Who you are talking to");
  const procedure = ROLE.indexOf("## How you work");
  assert.ok(audience > 0, "the role must have an audience section");
  assert.ok(procedure > 0, "the role must have a procedure section");
  assert.ok(audience < procedure, "who you talk to comes first");
});

test("the jargon that must never reach the user is listed, not merely discouraged", () => {
  // "Avoid jargon" is unfalsifiable advice. The words themselves have to be
  // named, with what to say instead.
  for (const w of ["pull request", "branch", "commit", "worktree", "fork", "CI", "diff"])
    assert.ok(ROLE.includes(w), `the banned-words table must name "${w}"`);
  assert.match(ROLE, /your change/i);
  assert.match(ROLE, /being installed/i);
});

test("the role forbids handing a technical decision back to the user", () => {
  assert.match(ROLE, /never make them arbitrate/i);
});

test("the role caps the length of an ordinary answer", () => {
  // Without a number this degrades into an essay on every turn.
  assert.match(ROLE, /three lines/i);
});

test("the job ends when the change is VISIBLE, never at the merge", () => {
  assert.match(ROLE, /reload the page/i);
  assert.match(ROLE, /never say "it's live" from the fact that it was merged/i);
});

test("the role checks the update channel before promising anything", () => {
  // A beta instance never receives an ordinary merge. Promising otherwise is
  // how a non-developer ends up waiting forever for a change that landed.
  assert.match(ROLE, /updateChannel/);
  assert.match(ROLE, /autoUpdate/);
  assert.match(ROLE, /\/version/);
});

test("the GitHub sign-in is scripted, and asks for no token", () => {
  assert.match(ROLE, /github\.com\/login\/device/);
  assert.match(ROLE, /Nothing about tokens/i);
});

test("the safety rules survived the rewrite", () => {
  // Losing these to a prose edit would let a tweak agent kill the cockpit it
  // is talking through (invariant 8).
  assert.match(ROLE, /Never touch port 3789/i);
  assert.match(ROLE, /npm test/);
  assert.match(ROLE, /CLAUDE\.md/);
  assert.match(ROLE, /[Nn]ever merge/);
});
