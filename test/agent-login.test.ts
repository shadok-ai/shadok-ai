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
