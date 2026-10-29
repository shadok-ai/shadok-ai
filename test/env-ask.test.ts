import assert from "node:assert/strict";
import test from "node:test";
import { envVarAsks, isEnvAsk, MAX_ENV_ASKS_PER_MESSAGE } from "../public/env-ask.js";

test("the shape that prompted it: a missing token inside an inline code span", () => {
  const msg = "Le CLI `/workspace/hubspot/hubspot.mjs` est installé, mais il s'arrête sur `HUBSPOT_TOKEN missing from the environment`.";
  assert.deepEqual(envVarAsks(msg), ["HUBSPOT_TOKEN"]);
});

test("a bare inline name and a fenced export are both offered, in order", () => {
  const msg = "Ajoute `MATOMO_URL` puis :\n```\nexport MATOMO_TOKEN_AUTH=xxx\n```";
  assert.deepEqual(envVarAsks(msg), ["MATOMO_URL", "MATOMO_TOKEN_AUTH"]);
});

test("a capitalised word in prose is not an ask", () => {
  assert.deepEqual(envVarAsks("Il faut un HUBSPOT_TOKEN pour ça."), []);
});

test("settings the agent owns or the cockpit sets get no button", () => {
  assert.equal(isEnvAsk("NODE_ENV"), false);
  assert.equal(isEnvAsk("SHADOK_SESSION_KEY"), false);
  assert.equal(isEnvAsk("CLAUDE_CODE_OAUTH_TOKEN"), false);
  assert.equal(isEnvAsk("LOG_LEVEL"), false);
  assert.equal(isEnvAsk("PATH"), false);            // no underscore
  assert.equal(isEnvAsk("hubspot_token"), false);   // not an env name
});

test("credentials and connection settings do", () => {
  for (const n of ["GOOGLE_ADS_DEVELOPER_TOKEN", "BING_API_KEY", "GSC_CLIENT_SECRET", "DATABASE_URL", "GOOGLE_ADS_CUSTOMER_ID"]) {
    assert.equal(isEnvAsk(n), true, n);
  }
});

test("duplicates collapse and the list is bounded", () => {
  assert.deepEqual(envVarAsks("`A_TOKEN` et encore `A_TOKEN`"), ["A_TOKEN"]);
  const many = Array.from({ length: 10 }, (_, i) => `\`X${i}_TOKEN\``).join(" ");
  assert.equal(envVarAsks(many).length, MAX_ENV_ASKS_PER_MESSAGE);
});

test("nothing to offer yields nothing", () => {
  assert.deepEqual(envVarAsks(""), []);
  assert.deepEqual(envVarAsks(undefined), []);
});
