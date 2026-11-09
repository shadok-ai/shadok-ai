import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mtCredentialMessage, mtTokenNeeded } from "../src/claude-bin.js";

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

test("mtTokenNeeded: only a user-dropping subscription spawn needs the token", () => {
  assert.equal(mtTokenNeeded(true, false), true);
  assert.equal(mtTokenNeeded(true, true), false, "custom backend never needs the MT token");
  assert.equal(mtTokenNeeded(false, false), false, "no drop user (mono-tenant / root commons) needs none");
  assert.equal(mtMsgFor(true, true, false), null, "custom-backend spawn is not refused without the token");
  assert.ok(mtMsgFor(true, false, false), "private-group subscription spawn is refused without the token");
});

function mtMsgFor(drops: boolean, custom: boolean, hasToken: boolean) {
  return mtCredentialMessage(mtTokenNeeded(drops, custom), hasToken);
}

test("server guard is keyed on dropUser (same as makePilot's injection), not groupsMigrated", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  // The guard is now the connect verdict (src/connect-gate.ts), fed the SAME
  // dropUser the spawn hands makePilot.
  assert.ok(src.includes("await connectRefusal(dropUser)"), "guard uses the spawn's dropUser");
  assert.ok(src.includes("dropUser: user,"), "the verdict is keyed on that user");
  assert.ok(!src.includes("DEPLOYMENT_MODE === \"multi-tenant\" && groupsMigrated,"), "old migration-keyed trigger is gone");
});
