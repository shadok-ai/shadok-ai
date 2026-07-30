import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
const { run, readState, writeState } = await import("../pilotctl.mjs");

test("spawn démarre une session et écrit l'état local", async () => {
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

test("spawn --resume conserve branch/baseSha existants quand le serveur n'en renvoie pas", async () => {
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

test("spawn propage l'erreur du serveur", async () => {
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
