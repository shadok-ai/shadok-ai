import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-talk-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
const { run } = await import("../pilotctl.mjs");

test("talk without a session key is refused (not running as a piloted agent)", async () => {
  delete process.env.SHADOK_SESSION_KEY;
  await assert.rejects(() => run(["talk", "H", "hi"]), /SHADOK_SESSION_KEY/);
});

test("talk POSTs the session key, handle and message, and returns the server's reply", async () => {
  const mock = await startMockServer({ talk: { ok: true, delivered: "ef01" } });
  process.env.SHADOK_PORT = String(mock.port);
  process.env.SHADOK_SESSION_KEY = "sk-key-123";
  try {
    const r = await run(["talk", "handle-xyz", "please review PR 42"]);
    assert.deepEqual(r, { ok: true, delivered: "ef01" });
    const call = mock.http.find((h) => h.url === "/talk" && h.method === "POST");
    assert.ok(call, "pilotctl did not POST /talk");
    assert.equal(call.sessionKey, "sk-key-123", "the session key header must be sent");
    assert.equal(call.body.handle, "handle-xyz");
    assert.equal(call.body.message, "please review PR 42");
  } finally {
    await mock.close();
  }
});

test("talk-handle returns the caller's own handle", async () => {
  const mock = await startMockServer({ talkHandle: { handle: "my-handle" } });
  process.env.SHADOK_PORT = String(mock.port);
  process.env.SHADOK_SESSION_KEY = "sk-key-123";
  try {
    const r = await run(["talk-handle"]);
    assert.deepEqual(r, { handle: "my-handle" });
    const call = mock.http.find((h) => h.url.startsWith("/talk/handle"));
    assert.ok(call, "pilotctl did not GET /talk/handle");
    assert.equal(call.sessionKey, "sk-key-123");
  } finally {
    await mock.close();
  }
});
