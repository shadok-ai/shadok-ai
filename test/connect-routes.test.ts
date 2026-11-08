import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brokerBase,
  brokerStartUrl,
  connectedMember,
  connectReadAllowed,
  errorOutcome,
  healthOffersLinkedIn,
  outcomeResponse,
  parseConnectHash,
  startOriginOk,
} from "../src/connect-routes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DONE = path.join(HERE, "..", "context", "connect-done.html");

test("hash: success carries nonce and blob", () => {
  assert.deepEqual(parseConnectHash("#n=abc_-1&c=AAA.BBB.CCC"), { kind: "payload", nonce: "abc_-1", blob: "AAA.BBB.CCC" });
  assert.deepEqual(parseConnectHash("n=abc&c=x"), { kind: "payload", nonce: "abc", blob: "x" });
});

test("hash: an error carries its code, with or without a nonce", () => {
  assert.deepEqual(parseConnectHash("#n=abc&error=cancelled"), { kind: "error", nonce: "abc", error: "cancelled" });
  assert.deepEqual(parseConnectHash("#error=user_cancelled_authorize"), { kind: "error", nonce: null, error: "user_cancelled_authorize" });
});

test("hash: garbage is malformed", () => {
  for (const h of ["", "#", "#n=abc", "#c=xyz", "#hello", undefined, 42, null])
    assert.deepEqual(parseConnectHash(h), { kind: "malformed" }, String(h));
});

test("origin: must be a bare http(s) origin equal to the Origin header", () => {
  assert.equal(startOriginOk("https://cockpit.example.com", "https://cockpit.example.com"), true);
  assert.equal(startOriginOk("http://localhost:3899", "http://localhost:3899"), true);
  assert.equal(startOriginOk("https://evil.example", "https://cockpit.example.com"), false);
  assert.equal(startOriginOk("https://cockpit.example.com", undefined), false);
  assert.equal(startOriginOk(undefined, "https://cockpit.example.com"), false);
  assert.equal(startOriginOk("https://cockpit.example.com/", "https://cockpit.example.com/"), false);
  assert.equal(startOriginOk("https://a.example/x", "https://a.example/x"), false);
  assert.equal(startOriginOk("javascript:alert(1)", "javascript:alert(1)"), false);
  assert.equal(startOriginOk("ftp://a.example", "ftp://a.example"), false);
  assert.equal(startOriginOk("null", "null"), false);
});

test("outcome: unknown and expired nonces read 'expired, click again' with 410", () => {
  for (const o of ["unknown", "expired"] as const) {
    const r = outcomeResponse(o);
    assert.equal(r.status, 410);
    assert.deepEqual(r.body, { error: "This connection attempt expired — click Connect LinkedIn again." });
  }
});

test("outcome: the rest of the mapping", () => {
  assert.deepEqual(outcomeResponse("wrong-person"), { status: 403, body: { error: "This connection was started by someone else." } });
  assert.deepEqual(outcomeResponse(errorOutcome("user_cancelled_authorize")), { status: 200, body: { cancelled: true, message: "Connection cancelled." } });
  assert.deepEqual(outcomeResponse(errorOutcome("cancelled")), { status: 200, body: { cancelled: true, message: "Connection cancelled." } });
  assert.deepEqual(outcomeResponse(errorOutcome("token_exchange_failed")), { status: 502, body: { error: "LinkedIn connection failed (token_exchange_failed)." } });
  assert.deepEqual(outcomeResponse(errorOutcome("<b>x</b>")), { status: 502, body: { error: "LinkedIn connection failed (bxb)." } });
  assert.deepEqual(outcomeResponse("damaged"), { status: 400, body: { error: "The connection data was damaged — click Connect LinkedIn again." } });
  assert.deepEqual(outcomeResponse("profile-failed"), { status: 502, body: { error: "Connected, but LinkedIn did not return your profile — try again." } });
});

test("broker: env override, default, trailing slash stripped", () => {
  assert.equal(brokerBase(undefined), "https://connect.shadok.ai");
  assert.equal(brokerBase(""), "https://connect.shadok.ai");
  assert.equal(brokerBase("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  const u = new URL(brokerStartUrl("https://connect.shadok.ai", "https://c.example", "PUB", "NONCE"));
  assert.equal(u.origin + u.pathname, "https://connect.shadok.ai/linkedin/start");
  assert.equal(u.searchParams.get("return"), "https://c.example/connect/linkedin/done");
  assert.equal(u.searchParams.get("pub"), "PUB");
  assert.equal(u.searchParams.get("nonce"), "NONCE");
});

test("health: available only when the broker lists linkedin", () => {
  assert.equal(healthOffersLinkedIn({ ok: true, providers: ["linkedin"] }), true);
  assert.equal(healthOffersLinkedIn({ ok: true, providers: [] }), false);
  assert.equal(healthOffersLinkedIn(null), false);
  assert.equal(healthOffersLinkedIn("linkedin"), false);
});

test("new account: owner = connectedVia = person, private/approve, urn, expiry", () => {
  const a = connectedMember("ada", { sub: "XyZ", name: "Ada L" }, { access_token: "T", expires_in: 3600, scope: "s" }, 1000);
  assert.deepEqual(a, {
    provider: "linkedin",
    kind: "member",
    label: "Ada L",
    externalId: "urn:li:person:XyZ",
    owner: "ada",
    connectedVia: "ada",
    share: { scope: "private" },
    policy: "approve",
    token: "T",
    expiresAt: 1000 + 3600_000,
  });
  const r = connectedMember("ada", { sub: "s", name: "" }, { access_token: "T", expires_in: 1, scope: "s", refresh_token: "R", refresh_token_expires_in: 10 }, 0);
  assert.equal(r.refreshToken, "R");
  assert.equal(r.refreshExpiresAt, 10_000);
  assert.equal(r.label, "s");
});

test("connect-done.html: every inline script carries the nonce, no inline handler, relative URLs", () => {
  const html = fs.readFileSync(DONE, "utf8");
  const opens = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(opens.length > 0);
  for (const o of opens) assert.match(o, /nonce="__CSP_NONCE__"/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /(ws|http)s?:\/\//);
  assert.match(html, /fetch\("connect\/linkedin\/complete"|fetch\("\/connect\/linkedin\/complete"/);
});

test("read gate: a person's GET passes with no Origin at all", () => {
  const person = { hasAgentKey: false, hasPeerToken: false, internalClient: false };
  assert.equal(connectReadAllowed({ ...person, account: { name: "admin" } }), true);
  assert.equal(connectReadAllowed({ ...person, account: null }), false, "nobody signed in");
});

test("read gate: an agent key, a peer token, the bridge cookie or an agent account is refused", () => {
  const acct = { name: "admin" };
  assert.equal(connectReadAllowed({ hasAgentKey: true, hasPeerToken: false, internalClient: false, account: acct }), false);
  assert.equal(connectReadAllowed({ hasAgentKey: false, hasPeerToken: true, internalClient: false, account: acct }), false);
  assert.equal(connectReadAllowed({ hasAgentKey: false, hasPeerToken: false, internalClient: true, account: acct }), false);
  assert.equal(
    connectReadAllowed({ hasAgentKey: false, hasPeerToken: false, internalClient: false, account: { agent: { session: "x" } } }),
    false,
  );
});

test("connect-done.html lives outside public/, so express.static cannot serve it raw", () => {
  assert.equal(fs.existsSync(path.join(HERE, "..", "public", "connect-done.html")), false);
  assert.ok(fs.existsSync(DONE));
});
