import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
const { parseArgs, readState, writeState, deleteState } = await import("../pilotctl.mjs");

test("parseArgs sépare commande, positionnels et flags", () => {
  const r = parseArgs(["prompt", "abc", "fais X", "--timeout", "30", "--worktree", "--cwd", "/tmp/y"]);
  assert.equal(r.cmd, "prompt");
  assert.deepEqual(r.pos, ["abc", "fais X"]);
  assert.equal(r.flags.timeout, "30");
  assert.equal(r.flags.worktree, true);
  assert.equal(r.flags.cwd, "/tmp/y");
});

test("parseArgs gère --continue et --resume", () => {
  const r = parseArgs(["spawn", "--continue", "--resume", "abc-123"]);
  assert.equal(r.flags.continue, true);
  assert.equal(r.flags.resume, "abc-123");
});

test("parseArgs: --profile prend une valeur, pas un booléen", () => {
  const r = parseArgs(["spawn", "--worktree", "--profile", "Shadok-dev", "--cwd", "/tmp/y"]);
  assert.equal(r.flags.profile, "Shadok-dev");
  assert.equal(r.flags.cwd, "/tmp/y");
  assert.deepEqual(r.pos, []); // le nom du profil ne doit pas fuir en positionnel
});

test("state: écriture, lecture, suppression", () => {
  assert.equal(readState("nope"), null);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x" });
  assert.deepEqual(readState("abc"), { sessionId: "abc", cwd: "/tmp/x" });
  deleteState("abc");
  assert.equal(readState("abc"), null);
});
