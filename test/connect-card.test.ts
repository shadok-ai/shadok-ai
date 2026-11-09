import assert from "node:assert/strict";
import test from "node:test";
import { connectCardPlan } from "../public/connect-card.js";

const mtNo = { state: "no", multiTenant: true, agentAuth: "token", user: "main", expiresAt: null };
const monoNo = { ...mtNo, multiTenant: false, user: null };
const yes = { ...mtNo, state: "yes" };
const closed = { open: false, step: null, flow: null, user: null, dismissable: false };

test("custom backend never opens the card", () => {
  assert.deepEqual(connectCardPlan({ connect: mtNo, backend: "custom", isAdmin: true }), closed);
});

test("admin on a never-connected multi-tenant instance chooses a duration, not dismissable", () => {
  assert.deepEqual(connectCardPlan({ connect: mtNo, isAdmin: true }), {
    open: true, step: "choose", flow: null, user: "main", dismissable: false,
  });
});

test("admin on mono goes straight to the instance sign-in", () => {
  assert.deepEqual(connectCardPlan({ connect: monoNo, isAdmin: true }), {
    open: true, step: "authorise", flow: "instance", user: null, dismissable: false,
  });
});

test("a space refused at spawn: admin authorises THAT space in the current mode", () => {
  const p = connectCardPlan({
    connect: { ...yes, agentAuth: "login" }, isAdmin: true,
    refusal: { code: "space-not-connected", user: "sk-abc" },
  });
  assert.deepEqual(p, { open: true, step: "authorise", flow: "login", user: "sk-abc", dismissable: true });
  const t = connectCardPlan({ connect: yes, isAdmin: true, refusal: { code: "space-not-connected", user: "main" } });
  assert.equal(t.flow, "token");
});

test("member never gets choose or authorise", () => {
  for (const args of [
    { connect: mtNo },
    { connect: monoNo },
    { connect: yes, refusal: { code: "space-not-connected", user: "sk-abc" } },
    { connect: yes, force: true },
  ]) {
    const p = connectCardPlan({ ...args, isAdmin: false });
    assert.ok(p.step === "ask-admin" || p.step === null, JSON.stringify(p));
    if (p.step === "ask-admin") assert.equal(p.dismissable, true);
  }
});

test("connected or unknown stays closed, unless a re-login is forced", () => {
  assert.deepEqual(connectCardPlan({ connect: yes, isAdmin: true }), closed);
  assert.deepEqual(connectCardPlan({ connect: { ...mtNo, state: "unknown" }, isAdmin: true }), closed);
  assert.deepEqual(connectCardPlan({ connect: { ...yes, agentAuth: "login" }, isAdmin: true, force: true }), {
    open: true, step: "authorise", flow: "login", user: "main", dismissable: true,
  });
  assert.equal(connectCardPlan({ connect: { ...yes, multiTenant: false, user: null }, isAdmin: true, force: true }).flow, "instance");
});

test("a logged-out refusal on mono opens the instance sign-in", () => {
  const p = connectCardPlan({ connect: { ...monoNo, state: "unknown" }, isAdmin: true, refusal: { code: "logged-out", user: null } });
  assert.equal(p.step, "authorise");
  assert.equal(p.flow, "instance");
});

test("no connect field at all (old server) stays closed", () => {
  assert.deepEqual(connectCardPlan({ connect: undefined, isAdmin: true }), closed);
});

test("sameConnectTarget: a second refusal for the card already open changes nothing", async () => {
  const { sameConnectTarget } = await import("../public/connect-card.js");
  const a = { open: true, step: "authorise", flow: "login", user: "sk-abc", dismissable: true };
  assert.equal(sameConnectTarget(a, { ...a }), true);
  assert.equal(sameConnectTarget(a, { ...a, user: "sk-other" }), false);
  assert.equal(sameConnectTarget(a, { ...a, flow: "token" }), false);
  assert.equal(sameConnectTarget(null, a), false);
});

test("1 year is the recommended tile, first and preselected", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const tiles = [...html.matchAll(/class="cx-tile[^"]*" data-dur="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tiles, ["token", "login"]);
  assert.match(html, /class="cx-tile active" data-dur="token"/);
  assert.match(html, /if \(plan\.step === "choose"\) \{ cxPickDur\("token"\)/);
});
