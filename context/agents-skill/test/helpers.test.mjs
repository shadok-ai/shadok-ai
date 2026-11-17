import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
const { parseArgs, readState, writeState, deleteState } = await import("../pilotctl.mjs");

test("parseArgs splits command, positionals and flags", () => {
  const r = parseArgs(["prompt", "abc", "fais X", "--timeout", "30", "--worktree", "--cwd", "/tmp/y"]);
  assert.equal(r.cmd, "prompt");
  assert.deepEqual(r.pos, ["abc", "fais X"]);
  assert.equal(r.flags.timeout, "30");
  assert.equal(r.flags.worktree, true);
  assert.equal(r.flags.cwd, "/tmp/y");
});

test("parseArgs handles --continue and --resume", () => {
  const r = parseArgs(["spawn", "--continue", "--resume", "abc-123"]);
  assert.equal(r.flags.continue, true);
  assert.equal(r.flags.resume, "abc-123");
});

test("parseArgs: --profile takes a value, not a boolean", () => {
  const r = parseArgs(["spawn", "--worktree", "--profile", "Shadok-dev", "--cwd", "/tmp/y"]);
  assert.equal(r.flags.profile, "Shadok-dev");
  assert.equal(r.flags.cwd, "/tmp/y");
  assert.deepEqual(r.pos, []); // the profile name must not leak into positionals
});

test("state: write, read, delete", () => {
  assert.equal(readState("nope"), null);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x" });
  assert.deepEqual(readState("abc"), { sessionId: "abc", cwd: "/tmp/x" });
  deleteState("abc");
  assert.equal(readState("abc"), null);
});

test("reapCandidates: only our ids outside a restricted peer, never busy/watched/recent", async () => {
  const { reapCandidates } = await import("../pilotctl.mjs");
  const rows = [
    { id: "mine-idle", busy: false, clients: 0, idleSec: 4000 },
    { id: "theirs-idle", busy: false, clients: 0, idleSec: 4000 },
    { id: "mine-busy", busy: true, clients: 0, idleSec: 4000 },
  ];
  const ownIds = new Set(["mine-idle", "mine-busy"]);
  assert.deepEqual(reapCandidates(rows, { restricted: false, ownIds, idleSec: 1800 }), ["mine-idle"]);
  assert.deepEqual(reapCandidates(rows, { restricted: true, ownIds: new Set(), idleSec: 1800 }), ["mine-idle", "theirs-idle"]);
});

test("parseIdle reads 30m / 2h / 90s / bare minutes", async () => {
  const { parseIdle } = await import("../pilotctl.mjs");
  assert.equal(parseIdle(undefined), 1800);
  assert.equal(parseIdle("30m"), 1800);
  assert.equal(parseIdle("2h"), 7200);
  assert.equal(parseIdle("90s"), 90);
  assert.equal(parseIdle("45"), 2700);
  assert.throws(() => parseIdle("soon"));
});
