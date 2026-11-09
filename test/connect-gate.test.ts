import { test } from "node:test";
import assert from "node:assert/strict";
import { connectVerdict, connectedState, type ConnectFacts } from "../src/connect-gate.js";

const base: ConnectFacts = {
  multiTenant: true,
  customBackend: false,
  dropUser: "main",
  agentAuth: "token",
  hasToken: false,
  rootAuth: "signed-out",
  userLoggedIn: null,
};
const mono: ConnectFacts = { ...base, multiTenant: false, dropUser: null };

test("mono signed-out refuses logged-out", () => {
  const v = connectVerdict({ ...mono, rootAuth: "signed-out" });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "logged-out");
});

test("mono unknown allows", () => {
  assert.deepEqual(connectVerdict({ ...mono, rootAuth: "unknown" }), { ok: true });
});

test("custom backend always allows", () => {
  assert.deepEqual(connectVerdict({ ...base, customBackend: true }), { ok: true });
  assert.deepEqual(connectVerdict({ ...mono, customBackend: true }), { ok: true });
});

test("unmigrated MT (dropUser null) signed-in allows", () => {
  assert.deepEqual(connectVerdict({ ...base, dropUser: null, rootAuth: "signed-in" }), { ok: true });
});

test("MT token mode without token refuses space-not-connected, user=main", () => {
  const v = connectVerdict({ ...base, hasToken: false, rootAuth: "signed-in" });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.code, "space-not-connected");
    assert.equal(v.user, "main");
  }
});

test("MT token mode with token allows even when root signed-out", () => {
  assert.deepEqual(connectVerdict({ ...base, hasToken: true, rootAuth: "signed-out" }), { ok: true });
});

test("MT login mode, user logged in, no token → allows", () => {
  assert.deepEqual(
    connectVerdict({ ...base, agentAuth: "login", hasToken: false, userLoggedIn: true }),
    { ok: true },
  );
});

test("MT login mode, user not logged in → space-not-connected", () => {
  const v = connectVerdict({ ...base, agentAuth: "login", hasToken: true, userLoggedIn: false, dropUser: "sk-abc" });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.code, "space-not-connected");
    assert.equal(v.user, "sk-abc");
  }
});

test("MT login mode, login state unread → allows (unknown never refuses)", () => {
  assert.deepEqual(connectVerdict({ ...base, agentAuth: "login", userLoggedIn: null }), { ok: true });
});

test("connectedState maps ok→yes, refusal→no, unknown root→unknown", () => {
  assert.equal(connectedState({ ...base, hasToken: true }), "yes");
  assert.equal(connectedState({ ...base, hasToken: false }), "no");
  assert.equal(connectedState({ ...mono, rootAuth: "unknown" }), "unknown");
  assert.equal(connectedState({ ...mono, rootAuth: "signed-in" }), "yes");
  assert.equal(connectedState({ ...base, agentAuth: "login", userLoggedIn: null }), "unknown");
});

test("messages never carry a token", () => {
  for (const f of [mono, base, { ...base, agentAuth: "login" as const, userLoggedIn: false }]) {
    const v = connectVerdict(f);
    if (!v.ok) assert.ok(!v.message.includes("sk-ant"));
  }
});
