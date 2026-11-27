import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// server.ts is un-importable, so the SHAPE of the wiring is locked by scan
// (the house pattern — see test/external-nature-wiring.test.ts) while every
// decision it calls is unit-tested for real in test/guest-vault.test.ts,
// test/secrets.test.ts and test/server-acl.test.ts.
const SRC = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

const fnBody = (sig: string): string => {
  const i = SRC.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return SRC.slice(i, SRC.indexOf("\n}\n", i));
};

test("the vault slice is resolved from the agent's UNIT, never from a bare group id", () => {
  // One builder for the env, one for the names, and both refuse rather than
  // fall back. The point of the scan: a new call site that passes a group where
  // a unit belongs is the shape of the bug this whole step is about.
  assert.match(fnBody("function agentSecretEnv("), /const u = vaultUnitOf\(group, conversation\);\n  if \(!u\.ok\) return \{\};/);
  assert.match(fnBody("function agentSecretNames("), /if \(!u\.ok\) return \[\];/);
  // No remaining `secretsForProfile(... ?? MAIN_GROUP_ID ...)`: that spelling is
  // exactly "resolve a conversation's secrets from its group" and it is what the
  // builders above replaced at every site.
  assert.equal(/secretsForProfile\([^)]*MAIN_GROUP_ID/.test(SRC), false);
  assert.equal(/secretNamesForProfile\(loadVault\(\), \w+ \?\? MAIN_GROUP_ID/.test(SRC), false);
});

test("vaultUnitOf refuses an unnameable conversation instead of answering with the group", () => {
  const body = fnBody("function vaultUnitOf(");
  assert.match(body, /return unitFor\(g, conversation\);/);
  // A group we cannot read keeps today's answer; an EXTERNAL group with no
  // conversation is `unitFor`'s refusal and must not be softened here.
  assert.equal(/\?\? MAIN_GROUP_ID/.test(body.replace("if (!group) return { ok: true, unit: MAIN_GROUP_ID };", "")), false);
  // The conversation is read off the CHANNEL's own binding, never from a body.
  assert.match(fnBody("function vaultUnitOfChannel("), /guestConversationKey\(chan\)/);
});

test("every vault mutation passes the guest-slice rule, with the operation it really is", () => {
  const ops = new Map<string, string>([
    ['op: verdict === "created" ? "create" : "overwrite"', "PUT /secrets"],
    ['op: "share"', "PUT /secrets/share"],
    ['op: "bind"', "PUT /secrets/profiles"],
    ['op: "delete"', "DELETE /secrets"],
  ]);
  for (const [needle, route] of ops)
    assert.ok(SRC.includes(`guestSliceWriteRefusal({ unit: `) && SRC.includes(needle), `${route} does not apply the guest-slice rule`);
  // The caller's own unit travels with the write TARGET. Re-deriving it per
  // route is how a refused caller comes back as "a person" and gets a person's
  // rights, so the scan pins the one source.
  assert.equal(/callerUnit: target\.callerUnit/.test(SRC), true);
  assert.equal(/callerUnit: callerUnit\(req\)/.test(SRC), false);
});

test("the quota is enforced before the write, and only on a guest's slice", () => {
  const put = SRC.slice(SRC.indexOf('app.put("/secrets", '), SRC.indexOf('app.put("/secrets/share"'));
  const quota = put.indexOf("guestSecretQuotaRefusal({");
  const write = put.indexOf("setSecret(key, value,");
  assert.ok(quota >= 0 && write > quota, "the quota must be decided before anything is stored");
  assert.match(put, /if \(isGuestSlice\(ownerGroup\)\) \{/);
  // 413, not 400: the request is well-formed and the ceiling is the answer.
  assert.match(put, /status\(413\)/);
});

test("the guest is TOLD on a creation, in guest words, and only then", () => {
  const put = SRC.slice(SRC.indexOf('app.put("/secrets", '), SRC.indexOf('app.put("/secrets/share"'));
  assert.match(put, /if \(verdict === "created" && isGuestSlice\(ownerGroup\)\) tellGuestSecretKept\(/);
  const tell = fnBody("function tellGuestSecretKept(");
  // The wording comes from the one guest-words door, and the delivery is the
  // session's own broadcast — the bridges are clients of it.
  assert.match(tell, /guestNotice\("secret-kept"\)/);
  assert.match(tell, /broadcast\(s, \{ type: "stream-text"/);
  // Best-effort: a missing session is nobody to tell, never a failed write.
  assert.match(tell, /if \(!s \|\| !line\) return;/);
});

test("the slice dies with the agent, and the USER does not", () => {
  const body = fnBody("async function endChannel(");
  assert.match(body, /dropGuestSliceOf\(ch\)/);
  // Nothing in endChannel removes the conversation's account: deleting an agent
  // "is not meant to erase someone", and a userdel under a surviving folder
  // would hand its files to the next uid (design decision 7).
  assert.equal(/runPrivileged\("userdel"/.test(body), false);
  const drop = fnBody("function dropGuestSliceOf(");
  assert.match(drop, /if \(!u\.ok \|\| !isGuestSlice\(u\.unit\)\) return;/);
  assert.match(drop, /action: "deleted"/);
});

test("deleting an external GROUP wipes its conversations' slices, before the accounts", () => {
  const body = fnBody("async function teardownGroupOrConversations(");
  const slices = body.indexOf("guestSlicesOf(loadVault(), g.id)");
  const userdel = body.indexOf('runPrivileged("userdel"');
  assert.ok(slices >= 0, "the group's guest slices are never wiped");
  assert.ok(userdel > slices, "a failing userdel must not be what leaves those values on disk");
});

test("an external GROUP is never itself a vault target", () => {
  const body = fnBody("function secretWriteTarget(");
  assert.match(body, /externalGroupSliceRefusal\(\{ unit: decision\.ownerGroup, external: nature === "external" \}\)/);
});

test("GET /secrets boxes a guest to its own slice and refuses an unplaceable one", () => {
  const get = SRC.slice(SRC.indexOf('app.get("/secrets", '), SRC.indexOf('mountFactory(app,'));
  assert.match(get, /if \(refused\) return res\.status\(403\)/);
  // The caller's own unit is the 4th argument — that is what stops one stranger
  // reading another's NAMES on the same door.
  assert.match(get, /agentGroupId \?\? null,\n  \);/);
});

test("the FACTORY resolves an agent's secrets from the unit too — the commons is not a fallback", () => {
  assert.match(fnBody("function factoryVaultUnit("), /return u\.ok \? u\.unit : null;/);
  assert.match(fnBody("function factorySecretEnv("), /if \(unit === null\) return \{\};/);
  assert.match(fnBody("function factoryVaultFor("), /if \(unit === null\) return \{\};/);
  // And no site left resolving a factory grant by bare group.
  assert.equal(/secretsFor\(factorySecretsFor\(sessionId\), group/.test(SRC), false);
  assert.equal(/secretsFor\(factory\.secrets, group/.test(SRC), false);
});
