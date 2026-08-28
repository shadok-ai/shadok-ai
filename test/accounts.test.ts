import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_ADMIN,
  hashPassword,
  verifyPassword,
  userWriteVerdict,
} from "../src/accounts.js";

test("password: a hash verifies its own plaintext and nothing else", () => {
  const h = hashPassword("correct horse");
  assert.equal(verifyPassword("correct horse", h), true);
  assert.equal(verifyPassword("Correct horse", h), false);
  assert.equal(verifyPassword("", h), false);
});

test("password: two hashes of the same word differ (salted)", () => {
  // An unsalted hash would let anyone spot two people sharing a password.
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("password: a malformed hash is refused, never crashes", () => {
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", ""), false);
});

test("write rules: only an admin may create, delete or re-role", () => {
  for (const action of ["create", "delete", "role"] as const) {
    const v = userWriteVerdict({ actorRole: "member", action, target: "bob", exists: true });
    assert.equal(v.ok, false, action);
    assert.match((v as { error: string }).error, /admin/i);
  }
});

test("write rules: an admin may do all three", () => {
  assert.deepEqual(userWriteVerdict({ actorRole: "admin", action: "create", target: "bob", exists: false }), { ok: true });
  assert.deepEqual(userWriteVerdict({ actorRole: "admin", action: "delete", target: "bob", exists: true }), { ok: true });
  assert.deepEqual(userWriteVerdict({ actorRole: "admin", action: "role", target: "bob", exists: true }), { ok: true });
});

test("write rules: nobody may create an account named like the bootstrap admin", () => {
  // It lives in the password, not in the file. A file account of the same name
  // would shadow it and could never be logged into.
  const v = userWriteVerdict({ actorRole: "admin", action: "create", target: BOOTSTRAP_ADMIN, exists: false });
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /reserved/i);
});

test("write rules: creating a name that exists, or touching one that does not", () => {
  const dup = userWriteVerdict({ actorRole: "admin", action: "create", target: "bob", exists: true });
  assert.equal(dup.ok, false);
  assert.match((dup as { error: string }).error, /already exists/i);
  const gone = userWriteVerdict({ actorRole: "admin", action: "delete", target: "bob", exists: false });
  assert.equal(gone.ok, false);
  assert.match((gone as { error: string }).error, /no such account/i);
});

test("write rules: an empty name is refused", () => {
  const v = userWriteVerdict({ actorRole: "admin", action: "create", target: "   ", exists: false });
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /name required/i);
});

test("write rules: not signed in is not an admin", () => {
  const v = userWriteVerdict({ actorRole: null, action: "create", target: "bob", exists: false });
  assert.equal(v.ok, false);
});
