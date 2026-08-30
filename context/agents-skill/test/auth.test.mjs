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
// These tests run INSIDE an agent, whose env carries a real session key — so
// clear it, or every exact-equality assertion below silently gains a header.
delete process.env.SHADOK_SESSION_KEY;
const { authHeaders, run } = await import("../pilotctl.mjs");

test("authHeaders: SHADOK_AUTH present → cookie; absent → {}", () => {
  process.env.SHADOK_AUTH = "sk_auth=tok123";
  assert.deepEqual(authHeaders(), { cookie: "sk_auth=tok123" });
  delete process.env.SHADOK_AUTH;
  assert.deepEqual(authHeaders(), {});
});

test("authHeaders sends the session key too, and it alone is enough", () => {
  // The cookie is a DATED token frozen into this process's environment at
  // spawn, and an environment cannot be refreshed: past a week every call an
  // agent made to its own server answered 401 — schedules, sibling agents, the
  // vault — and the self-reload that would have fixed it sits behind the same
  // gate. The key is derived from the session id and does not age, so it must
  // go out even when the cookie is missing or long dead.
  process.env.SHADOK_SESSION_KEY = "sid.deadbeef";
  assert.deepEqual(authHeaders(), { "x-shadok-session-key": "sid.deadbeef" });
  process.env.SHADOK_AUTH = "sk_auth=tok123";
  assert.deepEqual(authHeaders(), {
    cookie: "sk_auth=tok123",
    "x-shadok-session-key": "sid.deadbeef",
  });
  delete process.env.SHADOK_AUTH;
  delete process.env.SHADOK_SESSION_KEY;
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
