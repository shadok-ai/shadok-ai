import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credPathForHome, agentLoginInfo } from "../src/agent-login.js";

// The login module drives `claude auth login` in tmux (impure, like
// setup-token's flow — not unit-tested); its OAuth-screen parsers are REUSED
// from setup-token.ts and covered there. What is worth locking here is the two
// pure, security-sensitive readers the cockpit status row depends on.

test("credPathForHome: the credential lives in the user's own ~/.claude", () => {
  assert.equal(credPathForHome("/home/main"), path.join("/home/main", ".claude", ".credentials.json"));
  assert.equal(credPathForHome("/home/sk-abc"), path.join("/home/sk-abc", ".claude", ".credentials.json"));
});

function withHome(cred: unknown | undefined, fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-login-"));
  try {
    if (cred !== undefined) {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(credPathForHome(home), typeof cred === "string" ? cred : JSON.stringify(cred));
    }
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("agentLoginInfo: a real login reports loggedIn + the refresh-token expiry", () => {
  withHome({ claudeAiOauth: { refreshToken: "secret-value", refreshTokenExpiresAt: 1_793_000_000_000 } }, (home) => {
    const info = agentLoginInfo(home);
    assert.equal(info.loggedIn, true);
    assert.equal(info.expiresAt, 1_793_000_000_000);
  });
});

test("agentLoginInfo: accepts the un-wrapped shape too, and never surfaces the token", () => {
  withHome({ refreshToken: "secret-value", refreshTokenExpiresAt: 42 }, (home) => {
    const info = agentLoginInfo(home);
    assert.equal(info.loggedIn, true);
    assert.equal(info.expiresAt, 42);
    // The result carries only the two facts — no field holds the credential.
    assert.deepEqual(Object.keys(info).sort(), ["expiresAt", "loggedIn"]);
    assert.ok(!JSON.stringify(info).includes("secret-value"));
  });
});

test("agentLoginInfo: a login with no readable expiry still reports loggedIn", () => {
  withHome({ claudeAiOauth: { refreshToken: "x" } }, (home) => {
    assert.deepEqual(agentLoginInfo(home), { loggedIn: true, expiresAt: null });
  });
});

test("agentLoginInfo: no credential, or a malformed one, reads as not-logged-in (never throws)", () => {
  withHome(undefined, (home) => {
    assert.deepEqual(agentLoginInfo(home), { loggedIn: false, expiresAt: null });
  });
  withHome("{ this is not json", (home) => {
    assert.deepEqual(agentLoginInfo(home), { loggedIn: false, expiresAt: null });
  });
});

// ── Route gating (scan-based, like mt-token-endpoints.test.ts) ──────────────
// server.ts is un-importable (side effects at import), so lock the wiring by
// reading the source. The bug this pins: `GET /agent-login` was gated by
// `mtTokenGate`, which requires `requestFromBrowser` (an Origin header). But a
// browser omits `Origin` on a SAME-ORIGIN GET — so the cockpit's status fetch
// 403'd and the per-user sign-in list never rendered, while the POST writes
// (which DO send Origin) worked. A read must not require a browser origin.
const SERVER = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "server.ts"),
  "utf8",
);

function handlerSlice(method: "get" | "post" | "delete", route: string): string {
  const needle = `app.${method}("${route}"`;
  const start = SERVER.indexOf(needle);
  assert.ok(start >= 0, `${method.toUpperCase()} ${route} must be wired`);
  const rest = SERVER.slice(start);
  return rest.slice(0, rest.indexOf("\n});"));
}

test("GET /agent-login does NOT require a browser Origin (same-origin GET sends none)", () => {
  const h = handlerSlice("get", "/agent-login");
  assert.ok(!/mtTokenGate\(req, res\)/.test(h), "GET must not use the browser-origin write gate");
  assert.ok(/mtReadGate\(req, res\)/.test(h), "GET uses the read gate (admin + multi-tenant, no Origin)");
});

test("the agent-login WRITE routes keep the browser-origin gate", () => {
  for (const [m, r] of [
    ["post", "/agent-login/mode"],
    ["post", "/agent-login/start"],
    ["post", "/agent-login/code"],
    ["delete", "/agent-login"],
  ] as const) {
    assert.ok(/mtTokenGate\(req, res\)/.test(handlerSlice(m, r)), `${m.toUpperCase()} ${r} keeps mtTokenGate`);
  }
});

test("mtReadGate requires multi-tenant + admin but NOT a browser origin", () => {
  const i = SERVER.indexOf("function mtReadGate");
  assert.ok(i >= 0, "mtReadGate must exist");
  const body = SERVER.slice(i, SERVER.indexOf("\n}\n", i));
  assert.ok(/DEPLOYMENT_MODE !== "multi-tenant"/.test(body), "refuses mono-tenant");
  assert.ok(/currentAccount\(req\)\?\.role !== "admin"/.test(body), "refuses non-admins");
  assert.ok(!/requestFromBrowser/.test(body), "does NOT require a browser origin (reads have no CSRF surface)");
});
