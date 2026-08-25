import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";
import { buildStartMsg } from "../pilotctl.mjs";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
// Run these as a ROOT spawn whatever the ambient environment. The suite is
// itself often run from inside a piloted session, which exports
// SHADOK_SESSION_ID — the spawn would then correctly link to that session and
// the assertions below would pass or fail depending on WHERE the tests ran.
// The parent-linking rule is covered by the buildStartMsg tests, which pass an
// explicit env.
delete process.env.SHADOK_SESSION_ID;
const { run, readState, writeState } = await import("../pilotctl.mjs");

test("spawn starts a session and writes the local state", async () => {
  const mock = await startMockServer({
    start: [{ type: "ready", sessionId: "abc-123", cwd: "/tmp/x", branch: "shadok-ai/abc123" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    const r = await run(["spawn", "--cwd", "/tmp/x", "--worktree"]);
    assert.equal(r.sessionId, "abc-123");
    assert.equal(r.cwd, "/tmp/x");
    assert.equal(r.branch, "shadok-ai/abc123");
    assert.deepEqual(mock.received[0], { type: "start", cwd: "/tmp/x", worktree: true });
    const st = readState("abc-123");
    assert.equal(st.cwd, "/tmp/x");
    assert.equal(st.branch, "shadok-ai/abc123");
  } finally {
    await mock.close();
  }
});

test("spawn --profile passes the profile to the server", async () => {
  const mock = await startMockServer({
    start: [{ type: "ready", sessionId: "prof-1", cwd: "/tmp/x", branch: "shadok-ai/prof1" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    await run(["spawn", "--cwd", "/tmp/x", "--worktree", "--profile", "Shadok-dev"]);
    // Without it a delegated agent starts as bare Claude: no role, no guardrail,
    // no secrets — the profile is the heart of delegation.
    assert.deepEqual(mock.received[0], {
      type: "start",
      cwd: "/tmp/x",
      worktree: true,
      profile: "Shadok-dev",
    });
  } finally {
    await mock.close();
  }
});

test("spawn --resume keeps the existing branch/baseSha when the server sends none", async () => {
  const mock = await startMockServer({
    start: [{ type: "ready", sessionId: "abc-123", cwd: "/tmp/x" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  writeState("abc-123", {
    sessionId: "abc-123",
    cwd: "/tmp/x",
    branch: "shadok-ai/abc123",
    baseSha: "deadbeef",
    holderPid: null,
  });
  try {
    await run(["spawn", "--resume", "abc-123", "--cwd", "/tmp/x"]);
    const st = readState("abc-123");
    assert.equal(st.branch, "shadok-ai/abc123");
    assert.equal(st.baseSha, "deadbeef");
  } finally {
    await mock.close();
  }
});

test("spawn propagates the server's error", async () => {
  const mock = await startMockServer({
    start: [{ type: "error", message: "worktree creation failed: boom" }],
  });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    await assert.rejects(() => run(["spawn"]), /worktree creation failed/);
  } finally {
    await mock.close();
  }
});

test("buildStartMsg carries the spawner's own session id as parent", () => {
  // The link is what makes the spawner — and only the spawner — hear back.
  assert.equal(buildStartMsg({ worktree: true }, { SHADOK_SESSION_ID: "boss-id" }).parent, "boss-id");
});

test("buildStartMsg omits parent when the spawner has no session id", () => {
  // A human shell or the CLI: this creates a root, not an orphan child.
  assert.equal("parent" in buildStartMsg({ worktree: true }, {}), false);
});

test("buildStartMsg lets an explicit --parent win over the ambient session id", () => {
  assert.equal(buildStartMsg({ parent: "chosen" }, { SHADOK_SESSION_ID: "boss-id" }).parent, "chosen");
});

test("buildStartMsg treats --parent none as a deliberate detach", () => {
  assert.equal(buildStartMsg({ parent: "none" }, { SHADOK_SESSION_ID: "boss-id" }).parent, null);
});

test("buildStartMsg still forwards the other spawn flags", () => {
  const m = buildStartMsg({ cwd: "/w", worktree: true, profile: "Shadok-dev" }, {});
  assert.equal(m.cwd, "/w");
  assert.equal(m.worktree, true);
  assert.equal(m.profile, "Shadok-dev");
});
