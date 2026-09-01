import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROFILES, BOSS_PROFILE_NAME } from "../src/profiles.js";

// The shipped role catalogue, locked as PROSE — the same reason
// test/boss-role.test.ts and test/tweak-role.test.ts exist. A refactor cannot
// make these red by accident, which is precisely why they need a test: nothing
// else notices when a rule is edited out of a paragraph.
//
// Two families of assertion live here.
//
// 1. The false universal PR #199 fixed in the lead. A role prompt ships to
//    every cockpit, so naming THIS project's convention files as if every
//    project had them sends the agent hunting for a structure that is not
//    there. Shadok-dev is the most-spawned role in the catalogue, so in
//    practice it meets more foreign projects than the lead does.
// 2. The spec's filter for a NEW role (docs/superpowers/specs/
//    2026-08-31-onboarding-agent-design.md §6): a profile earns its place on
//    guardrails, secrets or method — never on topic. Two roles differing only
//    in subject matter are one role with two briefs.

const by = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.name, p]));
const promptOf = (name: string) => by[name]?.systemPrompt ?? "";
const denyOf = (name: string) => by[name]?.deny ?? [];

/** The convention files a project MAY carry, none of them guaranteed. */
const CONVENTION_FILES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "README"];

/** Roles that are told to read the project before they act. */
const READERS = [BOSS_PROFILE_NAME, "Shadok-dev", "Shadok-Content"];

test("no shipped role names one convention file as if it were the only one", () => {
  // The rule is NOT "never say CLAUDE.md" — this repository has one and a role
  // that stopped reading it would be worse here. It is "never name a single
  // file as if it were universal": the generalisation IS the enumeration.
  for (const p of DEFAULT_PROFILES) {
    const named = CONVENTION_FILES.filter((f) => (p.systemPrompt ?? "").includes(f));
    if (!named.length) continue; // a role that names none assumes none: fine
    assert.ok(
      named.length >= 3,
      `${p.name} names ${named.join(", ")} as if that were the project's layout`,
    );
  }
});

test("a reading role treats a missing convention file as information, not as a failed lookup", () => {
  // Without this half, an agent in a bare folder reports the absence as an
  // error and stalls, instead of taking it for what it is: a fact about the
  // project. Its failure mode is confabulation, hence the second assertion.
  for (const name of READERS) {
    const prompt = promptOf(name);
    assert.match(prompt, /absence is information/i, `${name} must not read an absence as a failure`);
    assert.match(prompt, /not a failed lookup/i, `${name}`);
    assert.match(prompt, /never invent one/i, `${name} must not invent the conventions it cannot find`);
  }
});

test("a reading role says out loud that the project may not be code at all", () => {
  for (const name of READERS) {
    assert.match(promptOf(name), /Rails app|Xcode project|marketing copy/i, `${name}`);
  }
});

test("shadok-ai's own layout is not prescribed to other projects", () => {
  // The two wordings this repository actually shipped, verbatim.
  assert.doesNotMatch(promptOf("Shadok-dev"), /Read the repo, CLAUDE\.md and docs/i);
  assert.doesNotMatch(promptOf("Shadok-Content"), /Read the repo, README, CLAUDE\.md, docs\//i);
});

test("Shadok-dev keeps what makes it a dev: small tested changes, and it never lands", () => {
  // Generalising the reading half must not cost the safety half.
  const dev = promptOf("Shadok-dev");
  assert.match(dev, /worktree/i);
  assert.match(dev, /never merge into main yourself/i);
  assert.match(dev, /run the tests/i);
  assert.ok(!denyOf("Shadok-dev").length, "Shadok-dev is the unguarded role");
});

// ── Part 4: the three new roles ──────────────────────────────────────────

test("each new role carries a guardrail shape no other shipped role has", () => {
  // This is the spec's filter, encoded. A role that ends up with the same deny
  // list as an existing one earns its place on method alone, and the next
  // person cannot tell the two apart on the card.
  for (const name of ["Shadok-QA", "Shadok-Release", "Shadok-Product"]) {
    const mine = JSON.stringify([...denyOf(name)].sort());
    assert.ok(denyOf(name).length, `${name} must carry guardrails of its own`);
    for (const other of DEFAULT_PROFILES) {
      if (other.name === name) continue;
      assert.notEqual(
        JSON.stringify([...(other.deny ?? [])].sort()),
        mine,
        `${name} has exactly ${other.name}'s guardrails — then it is one role with two briefs`,
      );
    }
  }
});

test("Shadok-QA may write tests and may not edit the source it is testing", () => {
  const deny = denyOf("Shadok-QA");
  assert.ok(
    deny.some((d) => /^Write\(/.test(d)) && deny.some((d) => /^Edit\(/.test(d)),
    "the source directories must be write-protected — that is the whole shape of this role",
  );
  // Its deliverable is a branch carrying a failing test, so git must stay open
  // to it. Reusing READONLY_DENY here would block exactly the wrong half.
  assert.ok(!deny.some((d) => d.startsWith("Bash(git")), "QA delivers a diff: git writes stay open");
});

test("Shadok-QA reproduces before it writes, and hands the fix over", () => {
  const qa = promptOf("Shadok-QA");
  assert.match(qa, /deliverable is a failing test/i);
  assert.match(qa, /never a fix/i);
  assert.match(qa, /proves nothing/i, "a test that passes on the broken code must be called out");
  // Same false universal as above, one level down: `test/` is this project's
  // convention, `spec/` and `__tests__/` are other people's.
  assert.match(qa, /how this project already tests itself/i);
});

test("Shadok-Release may run the deployment path and may not edit what it deploys", () => {
  const deny = denyOf("Shadok-Release");
  assert.ok(
    deny.includes("Write") && deny.includes("Edit"),
    "file edits are blocked outright — changing what you ship while shipping it is how a release stops being reproducible",
  );
  assert.ok(deny.includes("Bash(git commit:*)") && deny.includes("Bash(git push:*)"));
  // The inverse of Shadok-dev, which may write everything and deploys nothing:
  // running commands is what this role is FOR, so Bash stays open.
  assert.ok(!deny.includes("Bash"), "the deployment path must remain runnable");
});

test("Shadok-Release prepares and reports, and never pulls the trigger", () => {
  const rel = promptOf("Shadok-Release");
  assert.match(rel, /never decide to release/i);
  assert.match(rel, /human/i);
  assert.match(rel, /roll ?back/i, "a release with no named rollback is a decision, not a step");
});

test("Shadok-Release is not written for one kind of production", () => {
  // The spec's §6 line names signing certificates and App Store Connect. That
  // is ONE deployment target; this prompt ships to cockpits that publish an npm
  // package, a container image or a static site. Same rule as the convention
  // files: the generalisation is the enumeration.
  const rel = promptOf("Shadok-Release");
  const targets = ["registry", "app store", "container image", "static site", "deploy script"];
  const named = targets.filter((t) => new RegExp(t, "i").test(rel));
  assert.ok(named.length >= 3, `only ${named.join(", ") || "none"} named as a kind of production`);
});

test("Shadok-Product is read-only on the code and writes documents", () => {
  const deny = denyOf("Shadok-Product");
  assert.ok(deny.includes("Bash(git commit:*)"), "a human commits the spec");
  assert.ok(
    deny.some((d) => /^Edit\(/.test(d)),
    "read-only on the source: a spec agent that edits code is a dev agent",
  );
  // Its deliverable IS a file, so the write tools must not be blocked outright
  // (the trap Shadok-Content documents).
  assert.ok(!deny.includes("Write") && !deny.includes("Edit"));
});

test("Shadok-Product interrogates before it proposes", () => {
  const prod = promptOf("Shadok-Product");
  assert.match(prod, /before you propose/i);
  assert.match(prod, /out of scope/i, "the 'no' is the most valuable line in a spec");
  assert.match(prod, /Markdown/i);
});

test("the lead can hand work to every role this build ships", () => {
  // A role the lead cannot name is a role nobody spawns. If the lead ever
  // reads the live profile list instead (spec §4), replace this assertion —
  // do not delete it.
  const boss = promptOf(BOSS_PROFILE_NAME);
  for (const p of DEFAULT_PROFILES) {
    if (p.name === BOSS_PROFILE_NAME) continue;
    assert.ok(boss.includes(p.name), `the lead must know it can delegate to ${p.name}`);
  }
});
