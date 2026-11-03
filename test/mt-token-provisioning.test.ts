import test from "node:test";
import assert from "node:assert/strict";
import { mtCredentialMessage } from "../src/claude-bin.js";

test("capable without token: names the secret and the command", () => {
  const m = mtCredentialMessage(true, false);
  assert.ok(m);
  assert.match(m!, /MT_CLAUDE_OAUTH_TOKEN/);
  assert.match(m!, /claude setup-token/);
});
test("fine cases return null", () => {
  assert.equal(mtCredentialMessage(true, true), null);
  assert.equal(mtCredentialMessage(false, false), null);
  assert.equal(mtCredentialMessage(false, true), null);
});
