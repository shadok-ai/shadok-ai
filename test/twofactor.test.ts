import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_ADMIN, readSession, readSessionFull, signSession, type Account } from "../src/accounts.js";
import {
  ENROLL_TTL_MS,
  PENDING_TTL_MS,
  admins2fa,
  cleanLabel,
  enrollCodeVerdict,
  isInternalClient,
  keepsTwoAdminsVerdict,
  loginNext,
  newEnrollCode,
  normCode,
  putChallenge,
  readPending,
  resetVerdict,
  signPending,
  takeChallenge,
  twoFactorEnableVerdict,
} from "../src/twofactor.js";

const SECRET = Buffer.from("b".repeat(64), "hex");
const WEEK = 7 * 24 * 3600 * 1000;
const pk = { id: "k", publicKey: "x", counter: 0, label: "phone", createdAt: 1 };
const admin = (name: string, keys = 1): Account => ({
  name,
  role: "admin",
  createdAt: 1,
  passwordHash: "scrypt$aa$bb",
  passkeys: Array.from({ length: keys }, () => pk),
});
const member = (name: string, keys = 0): Account => ({ ...admin(name, keys), role: "member" });

// ── The cookie's second-factor flag ─────────────────────────────────────────

test("session: the mfa flag round-trips and defaults to off", () => {
  assert.deepEqual(readSessionFull(signSession("alex", 1_000, SECRET, true), SECRET, 2_000, WEEK), { user: "alex", mfa: true });
  assert.deepEqual(readSessionFull(signSession("alex", 1_000, SECRET), SECRET, 2_000, WEEK), { user: "alex", mfa: false });
});

test("session: a cookie issued before 2FA existed still reads — as NOT second-factor", () => {
  const body = `${Buffer.from("alex").toString("base64url")}.1000`;
  const old = `${body}.${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  assert.deepEqual(readSessionFull(old, SECRET, 2_000, WEEK), { user: "alex", mfa: false });
  assert.equal(readSession(old, SECRET, 2_000, WEEK), "alex");
});

test("session: the mfa flag cannot be flipped or dropped without the key", () => {
  const t = signSession("alex", 1_000, SECRET, false);
  const [u, at, , mac] = t.split(".");
  assert.equal(readSessionFull(`${u}.${at}.1.${mac}`, SECRET, 2_000, WEEK), null);
  const yes = signSession("alex", 1_000, SECRET, true).split(".");
  // Dropping the field turns a 4-part token into the old shape — with the wrong MAC.
  assert.equal(readSessionFull(`${yes[0]}.${yes[1]}.${yes[3]}`, SECRET, 2_000, WEEK), null);
  assert.equal(readSessionFull(`${u}.${at}.2.${mac}`, SECRET, 2_000, WEEK), null);
});

// ── The pending sign-in ──────────────────────────────────────────────────────

test("pending: round-trips for 5 minutes, then dies", () => {
  const t = signPending("alex", 1_000, SECRET);
  assert.equal(readPending(t, SECRET, 1_000 + PENDING_TTL_MS - 1), "alex");
  assert.equal(readPending(t, SECRET, 1_000 + PENDING_TTL_MS + 1), null);
});

test("pending: a pending token is NOT a session, and a session is not a pending token", () => {
  // The whole point of the derived key: copying sk_pending into sk_auth gets nothing.
  assert.equal(readSessionFull(signPending("alex", 1_000, SECRET), SECRET, 2_000, WEEK), null);
  assert.equal(readPending(signSession("alex", 1_000, SECRET, true), SECRET, 2_000), null);
});

// ── Switching it on ──────────────────────────────────────────────────────────

const ready = [admin("ada"), admin("bob"), member("cy")];

test("enable: two named admins with a passkey each → allowed", () => {
  assert.deepEqual(twoFactorEnableVerdict({ passwordSet: true, actor: { name: "ada", role: "admin" }, accounts: ready }), { ok: true });
});

test("enable: every refusal says why", () => {
  const v = (o: Partial<Parameters<typeof twoFactorEnableVerdict>[0]>) =>
    twoFactorEnableVerdict({ passwordSet: true, actor: { name: "ada", role: "admin" }, accounts: ready, ...o });
  const err = (r: ReturnType<typeof v>) => (r.ok ? "" : r.error);
  assert.match(err(v({ passwordSet: false })), /no password/);
  assert.match(err(v({ actor: { name: "cy", role: "member" } })), /only an admin/);
  assert.match(err(v({ actor: null })), /only an admin/);
  assert.match(err(v({ actor: { name: BOOTSTRAP_ADMIN, role: "admin" } })), /named admin account/);
  assert.match(err(v({ accounts: [admin("ada"), member("cy", 1)] })), /at least 2 admins/);
  assert.match(err(v({ accounts: [admin("ada"), admin("bob", 0)] })), /missing: bob/);
});

test("enable: the bootstrap admin and pending invitations do not count as admins", () => {
  const boot = { ...admin(BOOTSTRAP_ADMIN) };
  const pendingAdmin: Account = { name: "dee", role: "admin", createdAt: 1, invite: { token: "t", expiresAt: 9 } };
  const r = twoFactorEnableVerdict({ passwordSet: true, actor: { name: "ada", role: "admin" }, accounts: [admin("ada"), boot, pendingAdmin] });
  assert.equal(r.ok, false);
  assert.equal(admins2fa([admin("ada"), boot, pendingAdmin]).length, 1);
});

test("keeps two admins: only enforced while 2FA is on", () => {
  assert.equal(keepsTwoAdminsVerdict(false, [admin("ada")]).ok, true);
  assert.equal(keepsTwoAdminsVerdict(true, [admin("ada")]).ok, false);
  assert.equal(keepsTwoAdminsVerdict(true, [admin("ada"), admin("bob", 0)]).ok, false);
  assert.equal(keepsTwoAdminsVerdict(true, [admin("ada"), admin("bob")]).ok, true);
});

// ── Recovery ─────────────────────────────────────────────────────────────────

test("reset: another admin only — never yourself, never the instance password", () => {
  const ok = (actor: any, target: string) => resetVerdict({ actor, target, accounts: ready }).ok;
  assert.equal(ok({ name: "ada", role: "admin" }, "bob"), true);
  assert.equal(ok({ name: "ada", role: "admin" }, "cy"), true);
  assert.equal(ok({ name: "ada", role: "admin" }, "ada"), false);
  assert.equal(ok({ name: "cy", role: "member" }, "bob"), false);
  assert.equal(ok({ name: "ada", role: "admin" }, BOOTSTRAP_ADMIN), false);
  assert.equal(ok({ name: "ada", role: "admin" }, "nobody"), false);
});

test("login: what a correct password leads to", () => {
  assert.equal(loginNext(admin("ada"), false), "session");
  assert.equal(loginNext(admin("ada"), true), "passkey");
  assert.equal(loginNext(member("cy"), true), "enroll");
  assert.equal(loginNext(undefined, true), "enroll");
});

// ── Enrollment codes ─────────────────────────────────────────────────────────

test("enroll code: 8 unambiguous characters, typed loosely", () => {
  const c = newEnrollCode(0, "ada");
  assert.match(c.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(c.expiresAt, ENROLL_TTL_MS);
  assert.equal(normCode(" abcd-efgh "), "ABCDEFGH");
});

test("enroll code: right code accepted; wrong, expired, absent refused the same way", () => {
  const acct = { ...member("cy"), enroll: { code: "ABCDEFGH", expiresAt: 1_000, by: "ada" } };
  assert.equal(enrollCodeVerdict(acct, "abcd-efgh", 999).ok, true);
  const bad = [
    enrollCodeVerdict(acct, "ABCDEFGX", 999),
    enrollCodeVerdict(acct, "ABCDEFGH", 1_001),
    enrollCodeVerdict(member("cy"), "ABCDEFGH", 0),
    enrollCodeVerdict(acct, "", 0),
    enrollCodeVerdict(undefined, "ABCDEFGH", 0),
  ];
  for (const r of bad) assert.equal(r.ok, false);
  assert.equal(new Set(bad.map((r) => (r.ok ? "" : r.error))).size, 1);
});

// ── Challenges ───────────────────────────────────────────────────────────────

test("challenge: single use, bound to its user and purpose, expires", () => {
  const id = putChallenge("c1", "ada", "login", 0);
  assert.equal(takeChallenge(id, "bob", "login", 0), null);
  // A failed take burns it too: no retrying a stolen id against other users.
  assert.equal(takeChallenge(id, "ada", "login", 0), null);
  const id2 = putChallenge("c2", "ada", "login", 0);
  assert.equal(takeChallenge(id2, "ada", "stepup", 0), null);
  const id3 = putChallenge("c3", "ada", "login", 0);
  assert.equal(takeChallenge(id3, "ada", "login", 0), "c3");
  assert.equal(takeChallenge(id3, "ada", "login", 0), null);
  const id4 = putChallenge("c4", "ada", "login", 0);
  assert.equal(takeChallenge(id4, "ada", "login", 10 * 60 * 1000), null);
});

test("label: control characters and markup stripped, length capped, never empty", () => {
  assert.equal(cleanLabel("<b>Mac</b>\n"), "bMac/b");
  assert.equal(cleanLabel(""), "passkey");
  assert.equal(cleanLabel("x".repeat(99)).length, 40);
});

// ── The server's own client (the Telegram bridge) ─────────────────────────────

test("internal client: the bridge's cookie is the server, an agent's is not", () => {
  const secret = createHmac("sha256", "k").update("s").digest();
  const now = Date.now();
  // `adminCookie(true)` — minted in-process, the only way to get this shape.
  const bridge = readSessionFull(signSession(BOOTSTRAP_ADMIN, now, secret, true), secret, now, 60_000);
  assert.equal(isInternalClient(bridge), true);
  // `adminCookie()` — what an agent carries in SHADOK_AUTH, and what a
  // pre-2FA cookie reads as: password-grade, never a second factor.
  const agent = readSessionFull(signSession(BOOTSTRAP_ADMIN, now, secret), secret, now, 60_000);
  assert.equal(isInternalClient(agent), false);
  // A PERSON who passed their passkey is not the server, whatever the flag.
  const person = readSessionFull(signSession("ada", now, secret, true), secret, now, 60_000);
  assert.equal(isInternalClient(person), false);
  assert.equal(isInternalClient(null), false);
  // An expired or forged cookie never gets this far: it reads as null.
  assert.equal(isInternalClient(readSessionFull(signSession(BOOTSTRAP_ADMIN, now - 120_000, secret, true), secret, now, 60_000)), false);
});

/**
 * A scan test, like `test/ws-url.test.ts`: the wiring it locks lives in
 * `server.ts`, which cannot be imported without starting a server.
 *
 * Why it earns one: `const tgCookie = adminCookie` is the obvious spelling, it
 * is what the bridge had for as long as there was a bridge, and it is correct
 * until the day 2FA exists — then it silently takes Telegram off the air, with
 * the bot still receiving messages and nothing in the log. That is a line a
 * later cleanup would happily restore.
 */
test("the Telegram bridge's cookie is minted as the server's own (mfa)", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"), "utf8");
  assert.match(src, /const tgCookie = \(\): string \| undefined => adminCookie\(true\);/);
  // And it must be recognised BEFORE `cookieAccount`, which keeps refusing the
  // bootstrap admin — that ordering is what keeps `/2fa*` for persons only.
  const internal = src.indexOf("isInternalClient(cookieSession(req))");
  const cookieAcct = src.indexOf("return cookieAccount(req);");
  assert.ok(internal > 0 && cookieAcct > internal, "currentAccount must consult isInternalClient first");
  // An agent's env token stays password-grade: no flag.
  assert.match(src, /env\.SHADOK_AUTH = adminCookie\(\)!/);
});
