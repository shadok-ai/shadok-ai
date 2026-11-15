import assert from "node:assert/strict";
import test from "node:test";
import {
  newRequest, askVerdict, approveVerdict, cancelVerdict, dueRequests, expire, upsertRequest, requestsFor,
  REQUEST_TTL_MS, FULL_RESET_DELAY_MS, CLOSED_KEEP_MS,
} from "../src/admin-requests.js";

const ada = { name: "ada", role: "admin" }, bea = { name: "bea", role: "admin" }, bob = { name: "bob", role: "member" };
const accounts = [ada, bea, bob];

test("ask: an admin, not for themself, on an account that exists, a role change that changes something", () => {
  assert.equal(askVerdict({ actor: ada, kind: "passkey-reset", target: "bob", accounts }).ok, true);
  assert.equal(askVerdict({ actor: bob, kind: "passkey-reset", target: "ada", accounts }).ok, false);
  assert.equal(askVerdict({ actor: ada, kind: "full-reset", target: "ada", accounts }).ok, false);
  assert.equal(askVerdict({ actor: ada, kind: "full-reset", target: "zed", accounts }).ok, false);
  assert.equal(askVerdict({ actor: ada, kind: "promote", target: "bea", accounts }).ok, false);
  assert.equal(askVerdict({ actor: ada, kind: "demote", target: "bob", accounts }).ok, false);
  assert.equal(askVerdict({ actor: ada, kind: "promote", target: "bob", accounts }).ok, true);
});

test("approve: a SECOND admin, never the asker nor the target, once, before it expires", () => {
  const r = newRequest("promote", "bob", "ada", 0);
  assert.equal(approveVerdict(r, bea, 1).ok, true);
  assert.equal(approveVerdict(r, ada, 1).ok, false);
  assert.equal(approveVerdict(r, bob, 1).ok, false);
  assert.equal(approveVerdict(newRequest("demote", "bea", "ada", 0), bea, 1).ok, false);
  assert.equal(approveVerdict({ ...r, approvedBy: "bea" }, { name: "cy", role: "admin" }, 1).ok, false);
  assert.equal(approveVerdict(r, bea, REQUEST_TTL_MS + 1).ok, false);
  assert.equal(approveVerdict({ ...r, doneAt: 1 }, bea, 1).ok, false);
  // A full reset does not expire: its own clock makes it happen.
  assert.equal(approveVerdict(newRequest("full-reset", "bob", "ada", 0), bea, REQUEST_TTL_MS + 1).ok, true);
});

test("cancel: the asker, the target, or any admin — not an unrelated member", () => {
  const r = newRequest("full-reset", "bob", "ada", 0);
  assert.equal(cancelVerdict(r, ada).ok, true);
  assert.equal(cancelVerdict(r, bob).ok, true);
  assert.equal(cancelVerdict(r, bea).ok, true);
  assert.equal(cancelVerdict(r, { name: "carl", role: "member" }).ok, false);
  assert.equal(cancelVerdict({ ...r, doneAt: 5 }, ada).ok, false);
});

test("level 3: due 24 h after the ask, not before", () => {
  const r = newRequest("full-reset", "bob", "ada", 1000);
  assert.equal(r.effectiveAt, 1000 + FULL_RESET_DELAY_MS);
  assert.deepEqual(dueRequests([r], 1000 + FULL_RESET_DELAY_MS - 1), []);
  assert.deepEqual(dueRequests([r], 1000 + FULL_RESET_DELAY_MS).map((x) => x.id), [r.id]);
  assert.deepEqual(dueRequests([{ ...r, doneAt: 5 }], 1e15), []);
});

test("expiry: unapproved requests close after 48 h; a full reset is not expired, it becomes due", () => {
  const p = newRequest("promote", "bob", "ada", 0), f = newRequest("full-reset", "bob", "ada", 0);
  const out = expire([p, f], REQUEST_TTL_MS + 1);
  assert.equal(out[0].outcome, "expired");
  assert.equal(out[1].doneAt, undefined);
});

test("upsert: a new ask replaces the open one of the same kind on the same person; old closed rows go", () => {
  const a = newRequest("passkey-reset", "bob", "ada", 0);
  const b = newRequest("passkey-reset", "bob", "bea", 1);
  assert.deepEqual(upsertRequest([a], b, 1).map((r) => r.id), [b.id]);
  const old = { ...newRequest("promote", "bob", "ada", 0), doneAt: 0 };
  assert.deepEqual(upsertRequest([old], a, CLOSED_KEEP_MS + 1).map((r) => r.id), [a.id]);
});

test("panel: what I may approve, and what I asked", () => {
  const mine = newRequest("promote", "bob", "ada", 0), theirs = newRequest("passkey-reset", "bob", "bea", 0);
  const v = requestsFor(ada, [mine, theirs], 1);
  assert.deepEqual(v.waiting.map((r) => r.id), [theirs.id]);
  assert.deepEqual(v.mine.map((r) => r.id), [mine.id]);
  assert.deepEqual(requestsFor(bob, [mine, theirs], 1).waiting, []);
});
