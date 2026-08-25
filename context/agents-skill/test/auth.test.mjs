import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

// When a GUI password is set, the server injects SHADOK_AUTH=sk_auth=<token>
// into every agent's env; pilotctl must present it as the cookie on its loopback
// HTTP + WS calls, or the password gate 401s it (like secret.py / schedule.py
// already do). These tests lock that in.
process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-auth-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
delete process.env.SHADOK_SESSION_ID;
delete process.env.SHADOK_AUTH;
const { authHeaders, run } = await import("../pilotctl.mjs");

test("authHeaders: SHADOK_AUTH present → cookie; absent → {}", () => {
  process.env.SHADOK_AUTH = "sk_auth=tok123";
  assert.deepEqual(authHeaders(), { cookie: "sk_auth=tok123" });
  delete process.env.SHADOK_AUTH;
  assert.deepEqual(authHeaders(), {});
});

test("spawn (WS) presents the SHADOK_AUTH cookie on the upgrade", async () => {
  process.env.SHADOK_AUTH = "sk_auth=tok123";
  const mock = await startMockServer({ start: [{ type: "ready", sessionId: "a-1", cwd: "/tmp/x" }] });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    await run(["spawn", "--cwd", "/tmp/x"]);
    assert.deepEqual(mock.cookies.ws, ["sk_auth=tok123"]);
  } finally {
    delete process.env.SHADOK_AUTH;
    await mock.close();
  }
});

test("list (HTTP) presents the SHADOK_AUTH cookie on /sessions", async () => {
  process.env.SHADOK_AUTH = "sk_auth=tok123";
  const mock = await startMockServer({ sessions: [] });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    await run(["list", "--cwd", "/tmp/x"]);
    assert.ok(mock.cookies.http.includes("sk_auth=tok123"), "no cookie on the HTTP calls");
  } finally {
    delete process.env.SHADOK_AUTH;
    await mock.close();
  }
});

test("with no password (no SHADOK_AUTH), no cookie is sent", async () => {
  delete process.env.SHADOK_AUTH;
  const mock = await startMockServer({ start: [{ type: "ready", sessionId: "b-1", cwd: "/tmp/x" }] });
  process.env.SHADOK_PORT = String(mock.port);
  try {
    await run(["spawn", "--cwd", "/tmp/x"]);
    assert.deepEqual(mock.cookies.ws, []);
    assert.deepEqual(mock.cookies.http, []);
  } finally {
    await mock.close();
  }
});
