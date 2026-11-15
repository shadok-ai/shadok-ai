import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnEnv, forcedEnv, FORCED_CLAUDE_ENV } from "../src/session.js";

test("forced token wins over an inherited/profile value", () => {
  const env = spawnEnv(
    { user: "sk-x", home: "/home/sk-x", env: { CLAUDE_CODE_OAUTH_TOKEN: "PROFILE" }, oauthToken: "FORCED" },
    {},
  );
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "FORCED");
  assert.equal(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, "1");
});

test("no user => no injection, even if a token is available", () => {
  assert.equal(spawnEnv({ user: null, oauthToken: "FORCED" }, {}).CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("no token => key absent, not an empty string", () => {
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in spawnEnv({ user: "sk-x", home: "/home/sk-x" }, {})));
  assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in spawnEnv({ user: "sk-x", oauthToken: "" }, {})));
});

test("forcedEnv (tmux layer) emits the token after the static forced vars", () => {
  const keys = Object.keys(forcedEnv({ user: "sk-x", oauthToken: "T" }));
  assert.equal(keys[keys.length - 1], "CLAUDE_CODE_OAUTH_TOKEN");
  assert.deepEqual(forcedEnv({ user: null, oauthToken: "T" }), FORCED_CLAUDE_ENV);
});

test("forcedEnv injects GH_TOKEN for a dropped agent (so gh/git auth works)", () => {
  // A dropped agent cannot read the server's gh config (/root, 0700); it auths
  // via GH_TOKEN instead. Gated on a drop user, exactly like the oauth token.
  assert.equal(forcedEnv({ user: "sk-x", ghToken: "GHT" }).GH_TOKEN, "GHT");
});

test("no user => no GH_TOKEN; no ghToken => key absent", () => {
  assert.equal(forcedEnv({ user: null, ghToken: "GHT" }).GH_TOKEN, undefined);
  assert.ok(!("GH_TOKEN" in forcedEnv({ user: "sk-x", ghToken: "" })));
  assert.ok(!("GH_TOKEN" in forcedEnv({ user: "sk-x" })));
});

test("spawnEnv wires GH_TOKEN (forced) and GH_CONFIG_DIR (drop home) together", () => {
  const env = spawnEnv({ user: "sk-x", home: "/home/sk-x", ghToken: "GHT" }, { GH_CONFIG_DIR: "/root/.claude/gh" });
  assert.equal(env.GH_TOKEN, "GHT");
  assert.equal(env.GH_CONFIG_DIR, "/home/sk-x/.config/gh"); // the inherited /root value is overridden
});

test("PtyPilot builds its env through spawnEnv (the forced-token helper) — invariant 24", () => {
  const src = fs.readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
  assert.ok(src.includes("spawnEnv(this.opts"), "session.ts must call spawnEnv(this.opts, …)");
});
