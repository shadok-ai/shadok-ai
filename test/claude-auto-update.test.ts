import assert from "node:assert/strict";
import test from "node:test";
import {
  autoInstallVerdict, failingOnInstalled, newerPublished, lockHeld, autoInstallEnabled,
  type AutoInstallInput,
} from "../src/claude-auto-update.js";

const base: AutoInstallInput = {
  enabled: true,
  failingOnCurrent: 1,
  inFlight: false,
  externalInstall: false,
  sinceLastSettledMs: Infinity,
  sinceLastFailureMs: Infinity,
  settleMs: 60 * 60_000,
  failureBackoffMs: 30 * 60_000,
};

test("a failed footer on the installed binary starts an install", () => {
  assert.deepEqual(autoInstallVerdict(base), { install: true });
});

test("never two installs at once: in this process or another one", () => {
  assert.equal(autoInstallVerdict({ ...base, inFlight: true }).install, false);
  assert.equal(autoInstallVerdict({ ...base, externalInstall: true }).install, false);
});

test("no loop: settled or failed recently → wait", () => {
  assert.equal(autoInstallVerdict({ ...base, sinceLastSettledMs: 5 * 60_000 }).install, false);
  assert.equal(autoInstallVerdict({ ...base, sinceLastFailureMs: 5 * 60_000 }).install, false);
  assert.equal(autoInstallVerdict({ ...base, sinceLastSettledMs: 61 * 60_000, sinceLastFailureMs: 31 * 60_000 }).install, true);
});

test("nothing failing, or disabled → nothing", () => {
  assert.equal(autoInstallVerdict({ ...base, failingOnCurrent: 0 }).install, false);
  assert.equal(autoInstallVerdict({ ...base, enabled: false }).install, false);
});

test("an agent still on the OLD binary needs a reload, not another install", () => {
  assert.equal(failingOnInstalled("2.1.320", "2.1.326"), false);
  assert.equal(failingOnInstalled("2.1.326", "2.1.326"), true);
  // an unknown version must not hide a real failure (the time gates bound it)
  assert.equal(failingOnInstalled(null, "2.1.326"), true);
  assert.equal(failingOnInstalled("2.1.326", null), true);
});

test("newerPublished compares numerically, unknown means try", () => {
  assert.equal(newerPublished("2.1.99", "2.1.100"), true);
  assert.equal(newerPublished("2.1.100", "2.1.100"), false);
  assert.equal(newerPublished("2.1.101", "2.1.100"), false);
  assert.equal(newerPublished(null, "2.1.100"), true);
  assert.equal(newerPublished("2.1.100", null), true);
});

test("a lock expires by age, never by pid", () => {
  const now = 1_000_000_000;
  assert.equal(lockHeld(null, now, 20 * 60_000), false);
  assert.equal(lockHeld(now - 60_000, now, 20 * 60_000), true);
  assert.equal(lockHeld(now - 21 * 60_000, now, 20 * 60_000), false);
});

test("SHADOK_CLAUDE_AUTO_INSTALL=0 turns it off, default on", () => {
  assert.equal(autoInstallEnabled(undefined), true);
  assert.equal(autoInstallEnabled("1"), true);
  for (const v of ["0", "false", "off", "no", " OFF "]) assert.equal(autoInstallEnabled(v), false);
});
