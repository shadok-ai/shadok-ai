import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeVersion, seedPlan } from "../src/claude-home.js";

test("parseClaudeVersion pulls the semver out of the CLI banner", () => {
  assert.equal(parseClaudeVersion("2.1.226 (Claude Code)\n"), "2.1.226");
  assert.equal(parseClaudeVersion("2.1.226-beta.3 (Claude Code)"), "2.1.226-beta.3");
});

test("parseClaudeVersion returns null rather than guessing", () => {
  // A CLI that changed its banner must NOT produce a bogus version string:
  // lastOnboardingVersion is compared by Claude Code itself.
  assert.equal(parseClaudeVersion("command not found"), null);
  assert.equal(parseClaudeVersion(""), null);
});

test("a virgin file gets every global key plus the project entry", () => {
  const out = seedPlan({}, { version: "2.1.226", cwd: "/w/agent-1" });
  assert.deepEqual(out, {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
    theme: "dark",
    projects: {
      "/w/agent-1": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  });
});

test("an already-onboarded file needs no write at all", () => {
  // THE property that makes this safe on a developer's Mac: nothing to add
  // means nothing is written, so ~/.claude.json is never rewritten for nothing.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.0.0",
    theme: "light",
    projects: {
      "/w/agent-1": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
  assert.equal(seedPlan(existing, { version: "2.1.226", cwd: "/w/agent-1" }), null);
});

test("a present value is NEVER overwritten", () => {
  // The user's theme and their onboarding version are theirs. We only ever add.
  const out = seedPlan({ theme: "light", lastOnboardingVersion: "1.0.0" }, { version: "2.1.226" });
  assert.equal(out?.theme, "light");
  assert.equal(out?.lastOnboardingVersion, "1.0.0");
  assert.equal(out?.hasCompletedOnboarding, true);
});

test("other projects and unknown top-level keys survive untouched", () => {
  // ~/.claude.json carries megabytes of per-project history. Losing a key here
  // costs far more than the first-run screen this module exists to avoid.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
    theme: "dark",
    userID: "abc",
    projects: { "/other": { lastCost: 42, hasTrustDialogAccepted: true } },
  };
  const out = seedPlan(existing, { version: "2.1.226", cwd: "/w/new" });
  assert.equal(out?.userID, "abc");
  assert.deepEqual(out?.projects?.["/other"], { lastCost: 42, hasTrustDialogAccepted: true });
  assert.deepEqual(out?.projects?.["/w/new"], {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  });
});

test("an existing project entry keeps its own keys and gains only what's missing", () => {
  const existing = { projects: { "/w/a": { lastCost: 1, hasTrustDialogAccepted: false } } };
  const out = seedPlan(existing, { version: "2.1.226", cwd: "/w/a" });
  // hasTrustDialogAccepted is PRESENT (false) → left alone, per the additive rule.
  assert.equal(out?.projects?.["/w/a"].hasTrustDialogAccepted, false);
  assert.equal(out?.projects?.["/w/a"].lastCost, 1);
  assert.equal(out?.projects?.["/w/a"].hasCompletedProjectOnboarding, true);
});

test("no cwd means globals only — no empty projects map invented", () => {
  const out = seedPlan({}, { version: "2.1.226" });
  assert.equal(out?.projects, undefined);
});
