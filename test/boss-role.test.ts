import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROFILES, BOSS_PROFILE_NAME } from "../src/profiles.js";

// The lead's prompt ships to EVERY cockpit, and it used to be written as if
// there were only one: "read the repo, CLAUDE.md, docs/ and its specs" names
// shadok-ai's own layout, which is true for exactly one directory in the world.
// Everywhere else it sent the lead hunting for a structure that is not there.
//
// That is prose, so nothing but a test keeps it from drifting back — the same
// reason test/tweak-role.test.ts exists. The rule these assertions encode is
// not "never say CLAUDE.md": it is "never name THIS project's files as if they
// were universal".
const BOSS = DEFAULT_PROFILES.find((p) => p.name === BOSS_PROFILE_NAME);
const PROMPT = BOSS?.systemPrompt ?? "";

/** The convention files a project may carry, none of them guaranteed. */
const CONVENTION_FILES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "README"];

test("the lead profile still ships a prompt", () => {
  assert.ok(BOSS, `${BOSS_PROFILE_NAME} must be a default profile`);
  assert.ok(PROMPT.length > 0, "the lead must carry a system prompt");
});

test("no convention file is named as if it were the only one", () => {
  // The generalisation IS the enumeration. A prompt naming a single file is
  // back to assuming one project, whichever file it happens to name.
  const named = CONVENTION_FILES.filter((f) => PROMPT.includes(f));
  assert.ok(
    named.length >= 3,
    `the prompt must offer a choice of convention files, found only: ${named.join(", ") || "none"}`,
  );
});

test("this repository does not regress: CLAUDE.md is still read here", () => {
  // Generalising must not mean deleting. CLAUDE.md exists in this repo and is
  // where every invariant lives; a lead that stopped reading it would be a
  // worse agent on the one project we can actually check.
  assert.ok(PROMPT.includes("CLAUDE.md"), "CLAUDE.md must remain among the files the lead reads");
});

test("shadok-ai's own layout is not prescribed to other projects", () => {
  // `docs/` and its specs are this project's convention, not a universal one.
  assert.doesNotMatch(PROMPT, /docs\/ and its specs/i);
  assert.doesNotMatch(
    PROMPT,
    /read the repo, CLAUDE\.md, docs\//i,
    "the old shadok-ai-specific reading list must not come back",
  );
});

test("a missing convention file is information, never a failed lookup", () => {
  // This is the half that a well-meaning edit drops: without it, an agent in a
  // bare folder reports the absence as an error and stalls, instead of
  // treating it as what it is — a fact about the project.
  assert.match(PROMPT, /absence is information/i);
  assert.match(PROMPT, /not a failed lookup/i);
});

test("the lead infers conventions and is forbidden from inventing them", () => {
  // The failure mode of "assume nothing exists" is confabulation: an agent
  // that cannot find conventions describes the ones it expected to find.
  assert.match(PROMPT, /never invent one/i);
});

test("the prompt says out loud that the project may not be code at all", () => {
  // Naming the non-code case is what stops the lead reading every directory as
  // a software repository. These are the spec's own examples.
  assert.match(PROMPT, /Rails app|Xcode project|marketing copy/i);
});

test("the delegation half survived the rewrite", () => {
  // Part 1 touches KNOW only. These are the lead's safety rules, and a prose
  // edit to the paragraph above them is exactly how they would be lost.
  assert.match(PROMPT, /READ-ONLY/);
  assert.match(PROMPT, /shadok-ai-agents/);
  assert.match(PROMPT, /[Nn]ever land anything yourself/);
  assert.match(PROMPT, /merging is a human-reviewed step/i);
});
