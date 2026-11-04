import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeVersion, seedPlan, seedPlanForCwds, settingsPlan } from "../src/claude-home.js";

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
    autoModeEnvSetup: { dismissed: true },
    resumeReturnDismissed: true,
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
    autoModeEnvSetup: { dismissed: true },
    resumeReturnDismissed: true,
    projects: {
      "/w/agent-1": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
  assert.equal(seedPlan(existing, { version: "2.1.226", cwd: "/w/agent-1" }), null);
});

test("a present value is NEVER overwritten", () => {
  // The onboarding version already recorded is the CLI's business, not ours.
  const out = seedPlan({ lastOnboardingVersion: "1.0.0" }, { version: "2.1.226" });
  assert.equal(out?.lastOnboardingVersion, "1.0.0");
  assert.equal(out?.hasCompletedOnboarding, true);
});

test("seedPlanForCwds trusts EVERY cwd in a single object (one atomic write)", () => {
  // The fix for the shared-group-HOME trust race: a group HOME is seeded for
  // ALL its channels' cwds in ONE write, not one racy write per spawn. The
  // result is a single object carrying the globals plus every cwd's trust.
  const out = seedPlanForCwds({}, { version: "2.1.226", cwds: ["/w/a", "/w/b", "/w/c"] });
  assert.equal(out?.hasCompletedOnboarding, true);
  assert.equal(out?.lastOnboardingVersion, "2.1.226");
  const projects = out?.projects as Record<string, { hasTrustDialogAccepted?: boolean }>;
  assert.equal(projects["/w/a"].hasTrustDialogAccepted, true);
  assert.equal(projects["/w/b"].hasTrustDialogAccepted, true);
  assert.equal(projects["/w/c"].hasTrustDialogAccepted, true);
});

test("seedPlanForCwds needs no write when every cwd is already trusted", () => {
  // Same no-op guarantee as seedPlan: a complete file is never rewritten.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
    autoModeEnvSetup: { dismissed: true },
    resumeReturnDismissed: true,
    projects: {
      "/w/a": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      "/w/b": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
  assert.equal(seedPlanForCwds(existing, { version: "2.1.226", cwds: ["/w/a", "/w/b"] }), null);
});

test("seedPlanForCwds adds only the missing cwd and preserves the rest", () => {
  // The race's exact shape: a sibling's trust is already present, one cwd is
  // missing. The seed must ADD the missing one without disturbing the others.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
    autoModeEnvSetup: { dismissed: true },
    resumeReturnDismissed: true,
    projects: {
      "/w/a": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, someUserField: 7 },
    },
  };
  const out = seedPlanForCwds(existing, { version: "2.1.226", cwds: ["/w/a", "/w/darts"] });
  const projects = out?.projects as Record<string, Record<string, unknown>>;
  assert.equal(projects["/w/darts"].hasTrustDialogAccepted, true);
  // the sibling entry is untouched, including its own fields
  assert.equal(projects["/w/a"].hasTrustDialogAccepted, true);
  assert.equal(projects["/w/a"].someUserField, 7);
});

test("seedPlanForCwds with no cwds still seeds the globals (and only them)", () => {
  const out = seedPlanForCwds({}, { version: "2.1.226", cwds: [] });
  assert.equal(out?.hasCompletedOnboarding, true);
  assert.equal("projects" in (out ?? {}), false);
});

test("no theme is ever written", () => {
  // Verified 2026-08-08 on a clean container: the CLI DELETES an unknown
  // top-level theme key on its next write, and the picker is already skipped
  // without it. Seeding one would be cargo cult that also implies we control
  // the theme.
  const out = seedPlan({}, { version: "2.1.226" });
  assert.equal("theme" in (out ?? {}), false);
});

test("other projects and unknown top-level keys survive untouched", () => {
  // ~/.claude.json carries megabytes of per-project history. Losing a key here
  // costs far more than the first-run screen this module exists to avoid.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
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
  // This assertion used to read `false` — it pinned the bug. A stale false makes
  // the trust dialog greet every spawn, forever, which defeats the module; and
  // shadok is what chose this directory in the first place.
  assert.equal(out?.projects?.["/w/a"].hasTrustDialogAccepted, true);
  assert.equal(out?.projects?.["/w/a"].lastCost, 1);
  assert.equal(out?.projects?.["/w/a"].hasCompletedProjectOnboarding, true);
});

test("no cwd means globals only — no empty projects map invented", () => {
  const out = seedPlan({}, { version: "2.1.226" });
  assert.equal(out?.projects, undefined);
});

test("settingsPlan records an explicit tui choice on a fresh install", () => {
  // The fullscreen upsell appears AFTER the sign-in, so no pre-login probe ever
  // saw it. A choice already made cannot be upsold.
  assert.deepEqual(settingsPlan({}), { tui: "fullscreen" });
});

test("settingsPlan never overrides the user's own tui choice", () => {
  assert.equal(settingsPlan({ tui: "classic" }), null);
  assert.equal(settingsPlan({ tui: "fullscreen" }), null);
});

test("settingsPlan keeps every other setting untouched", () => {
  // settings.json is hand-edited: permissions, hooks, model. Losing one of
  // those to suppress an upsell would be a terrible trade.
  const out = settingsPlan({ permissions: { allow: ["Bash(git *)"] }, model: "opus" });
  assert.deepEqual(out, { permissions: { allow: ["Bash(git *)"] }, model: "opus", tui: "fullscreen" });
});

test("a directory already trusted needs no write", () => {
  // The assertion must not make every spawn rewrite a multi-megabyte file.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
    autoModeEnvSetup: { dismissed: true },
    resumeReturnDismissed: true,
    projects: { "/w/a": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  };
  assert.equal(seedPlan(existing, { version: "2.1.226", cwd: "/w/a" }), null);
});

test("only the trust flag is asserted — every other key stays additive", () => {
  // The exception is deliberately ONE key wide. Anything else present is the
  // CLI's business, and overwriting it would be the cargo cult we removed.
  const existing = { projects: { "/w/a": { hasCompletedProjectOnboarding: false, lastCost: 7 } } };
  const out = seedPlan(existing, { version: "2.1.226", cwd: "/w/a" });
  assert.equal(out?.projects?.["/w/a"].hasTrustDialogAccepted, true);
  assert.equal(out?.projects?.["/w/a"].hasCompletedProjectOnboarding, false);
  assert.equal(out?.projects?.["/w/a"].lastCost, 7);
});

test("the auto-mode environment screen is dismissed, never accepted", () => {
  // That screen offers to scan the user's shell history — PRE-TICKED — and
  // their other repos, and it blocks. Declining for someone is defensible;
  // accepting for them is not. `dismissed: true` is what "Don't show again"
  // writes; `dismissedAt` is "Not now", which brings it back in seven days.
  const out = seedPlan({}, { version: "2.1.241" });
  assert.deepEqual(out?.autoModeEnvSetup, { dismissed: true });
});

test("a COUNTER is not an answer — the verdict is merged into it", () => {
  // THE case that matters, and the one an additive-on-the-whole-key rule got
  // wrong: the CLI writes {denials: n} by itself from the first refusal. Skip
  // then, and the seeding protects only instances that never denied anything —
  // precisely the ones that can never reach the denials >= 5 threshold.
  const out = seedPlan({ autoModeEnvSetup: { denials: 3 } }, { version: "2.1.241" });
  assert.deepEqual(out?.autoModeEnvSetup, { denials: 3, dismissed: true });
});

test("a real answer is left alone, in both its forms", () => {
  const decided = seedPlan(
    { autoModeEnvSetup: { dismissed: false, denials: 9 } },
    { version: "2.1.241" },
  );
  assert.equal(decided?.autoModeEnvSetup?.dismissed, false);
  // "Not now" is an answer too: the user asked to be asked again later.
  const later = seedPlan(
    { autoModeEnvSetup: { dismissedAt: 1234, denials: 2 } },
    { version: "2.1.241" },
  );
  assert.deepEqual(later?.autoModeEnvSetup, { dismissedAt: 1234, denials: 2 });
});

test("an instance already dismissed needs no write", () => {
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.241",
    autoModeEnvSetup: { dismissed: true },
    resumeReturnDismissed: true,
  };
  assert.equal(seedPlan(existing, { version: "2.1.241" }), null);
});

test("the resume quota dialog is dismissed on a fresh instance", () => {
  // "Resume this conversation? … will use N% of your 5-hour limit" blocks
  // every resume of a large agent — reconcileOnBoot, Reload agent, /reload —
  // and a cron-driven cockpit has nobody to answer it.
  const out = seedPlan({}, { version: "2.1.304" });
  assert.equal(out?.resumeReturnDismissed, true);
});

test("the resume quota flag is global — never written into a project entry", () => {
  const out = seedPlan({}, { version: "2.1.304", cwd: "/w/a" });
  assert.equal("resumeReturnDismissed" in (out?.projects?.["/w/a"] ?? {}), false);
});

test("an explicit resume quota choice is never overridden", () => {
  // `false` is a user who wants the warning back; `true` needs nothing.
  const wanted = seedPlan({ resumeReturnDismissed: false }, { version: "2.1.304" });
  assert.equal(wanted?.resumeReturnDismissed, false);
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.304",
    autoModeEnvSetup: { dismissed: true },
    resumeReturnDismissed: false,
  };
  assert.equal(seedPlan(existing, { version: "2.1.304" }), null);
});

test("a file missing ONLY the resume quota flag still gets it", () => {
  // Every instance seeded before this key existed is exactly this shape.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.304",
    autoModeEnvSetup: { dismissed: true },
  };
  assert.deepEqual(seedPlan(existing, { version: "2.1.304" }), {
    ...existing,
    resumeReturnDismissed: true,
  });
});
