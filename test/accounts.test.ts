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

import { signSession, readSession } from "../src/accounts.js";

const SECRET = Buffer.from("a".repeat(64), "hex");
const WEEK = 7 * 24 * 3600 * 1000;

test("session: a token round-trips to its user", () => {
  const t = signSession("alex", 1_000, SECRET);
  assert.equal(readSession(t, SECRET, 2_000, WEEK), "alex");
});

test("session: a tampered user is refused", () => {
  // Swapping the name must not survive: the signature covers it.
  const t = signSession("alex", 1_000, SECRET);
  const forged = signSession("root", 1_000, SECRET).split(".")[0] + "." + t.split(".").slice(1).join(".");
  assert.equal(readSession(forged, SECRET, 2_000, WEEK), null);
});

test("session: another instance's secret is refused", () => {
  // The secret is per instance, so a cookie never crosses instances.
  const other = Buffer.from("b".repeat(64), "hex");
  assert.equal(readSession(signSession("alex", 1_000, SECRET), other, 2_000, WEEK), null);
});

test("session: an expired token is refused", () => {
  const t = signSession("alex", 1_000, SECRET);
  assert.equal(readSession(t, SECRET, 1_000 + WEEK + 1, WEEK), null);
  assert.equal(readSession(t, SECRET, 1_000 + WEEK - 1, WEEK), "alex");
});

test("session: garbage in, null out — never a throw", () => {
  for (const bad of ["", "x", "a.b", "a.b.c.d", "..", "alex.notanumber.deadbeef"])
    assert.equal(readSession(bad, SECRET, 2_000, WEEK), null, bad);
});

test("session: a user name containing a dot still round-trips", () => {
  // The token is dot-separated; a name with a dot must not shift the fields.
  const t = signSession("first.last", 1_000, SECRET);
  assert.equal(readSession(t, SECRET, 2_000, WEEK), "first.last");
});

import { newInvite, inviteVerdict, INVITE_TTL_MS, promptAuthor, type Account } from "../src/accounts.js";

const withInvite = (over: Partial<Account> = {}): Account => ({
  name: "bob", role: "member", createdAt: 0,
  invite: { token: "tok", expiresAt: 1_000 }, ...over,
});

test("invite: a fresh one is valid until it expires", () => {
  assert.deepEqual(inviteVerdict(withInvite(), "tok", 999), { ok: true });
});

test("invite: a link matching no account covers BOTH cases", () => {
  // Redeeming deletes the token, so by then a used link and a made-up one look
  // the same. The message must not claim to know which.
  const v = inviteVerdict(undefined, "tok", 0);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /no longer valid/i);
  assert.match((v as { error: string }).error, /already have been used/i);
});

test("invite: a wrong token is refused", () => {
  const v = inviteVerdict(withInvite(), "nope", 0);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /invalid/i);
});

test("invite: an expired link says EXPIRED, not 'invalid'", () => {
  // "This link has expired" tells you to ask for another one; "invalid" sends
  // you looking for a bug.
  const v = inviteVerdict(withInvite(), "tok", 1_001);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /expired/i);
});

test("invite: an already redeemed link says so", () => {
  const used: Account = { name: "bob", role: "member", createdAt: 0, passwordHash: "scrypt$aa$bb" };
  const v = inviteVerdict(used, "tok", 0);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /already/i);
});

test("newInvite: a random token and a one-week life", () => {
  const a = newInvite(0), b = newInvite(0);
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 32);
  assert.equal(a.expiresAt, INVITE_TTL_MS);
});

// ── Who a prompt is attributed to ───────────────────────────────────────
test("author: a web prompt is the SESSION, never what the frame claims", () => {
  // The security property of the whole feature: without this, a member renames
  // themselves by editing one WebSocket frame.
  assert.equal(promptAuthor("web", "bob", "root"), "bob");
  assert.equal(promptAuthor("web", "bob", undefined), "bob");
});

test("author: the Telegram bridge keeps naming its own sender", () => {
  // It is a trusted bridge and it knows the sender; the server does not.
  assert.equal(promptAuthor("telegram", undefined, "Alexandre"), "Alexandre");
  assert.equal(promptAuthor("telegram", "admin", "Alexandre"), "Alexandre");
});

test("author: a web client with no session names nobody", () => {
  // An instance with no password: today's behaviour, no author at all.
  assert.equal(promptAuthor("web", undefined, "root"), undefined);
});

test("author: other origins keep whatever they supplied", () => {
  assert.equal(promptAuthor("cli", "admin", "script"), "script");
  assert.equal(promptAuthor("cron", "admin", undefined), undefined);
});
