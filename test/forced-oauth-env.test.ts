import { test } from "node:test";
import assert from "node:assert/strict";
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
