import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brokerBase,
  brokerStartUrl,
  connectedGoogle,
  connectedMember,
  healthProviders,
  isConnectProvider,
  parseAreas,
  returnPathFor,
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
    share: { personal: true, groups: [], everyone: false, profiles: [] },
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
  // One page for every provider: the completion route is built from the path it was served at.
  assert.match(html, /fetch\("\/connect\/" \+ provider \+ "\/complete"/);
  assert.match(html, /\/\^\\\/connect\\\/\(\[a-z\]\+\)\\\/done\$\//);
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

// ---- Google (the second provider) ----------------------------------------

test("start URL per provider: Google's carries its own return path and the ticked areas; LinkedIn's is unchanged", () => {
  const li = new URL(brokerStartUrl("https://b.test", "https://cockpit.test", "PUB", "NONCE"));
  assert.equal(li.pathname, "/linkedin/start");
  assert.equal(li.searchParams.get("return"), "https://cockpit.test/connect/linkedin/done");
  assert.equal(li.searchParams.has("areas"), false);
  const g = new URL(brokerStartUrl("https://b.test", "https://cockpit.test", "PUB", "NONCE", "google", ["calendar", "gmail"]));
  assert.equal(g.pathname, "/google/start");
  assert.equal(g.searchParams.get("return"), "https://cockpit.test/connect/google/done");
  assert.equal(g.searchParams.get("areas"), "calendar,gmail");
  assert.equal(returnPathFor("google"), "/connect/google/done");
  assert.equal(isConnectProvider("google"), true);
  assert.equal(isConnectProvider("x"), false);
  assert.equal(isConnectProvider("__proto__"), false);
});

test("areas: a non-empty list of known names, in table order; anything else is refused, never silently dropped", () => {
  assert.deepEqual(parseAreas(["gmail", "calendar", "gmail"]), ["calendar", "gmail"]);
  assert.deepEqual(parseAreas(["drive"]), ["drive"]);
  assert.equal(parseAreas([]), null);
  assert.equal(parseAreas(["calendar", "youtube"]), null);
  assert.equal(parseAreas("calendar"), null);
  assert.equal(parseAreas(undefined), null);
  assert.equal(parseAreas([1]), null);
});

const BASE = ["calendar", "drive", "gmail"];

test("health: the areas a broker accepts — the first three for one that does not name them, its own list otherwise", () => {
  assert.deepEqual(healthProviders({ providers: ["google"] }).googleAreas, BASE, "a broker deployed before reading mail existed");
  assert.deepEqual(healthProviders({ providers: ["google"], googleAreas: ["calendar", "drive", "gmail", "gmail_read"] }).googleAreas, [...BASE, "gmail_read"]);
  assert.deepEqual(healthProviders({ providers: ["google"], googleAreas: ["gmail_read", "youtube"] }).googleAreas, ["gmail_read"], "an area this build does not know is not offered");
  assert.deepEqual(healthProviders({ providers: ["linkedin"], googleAreas: ["gmail_read"] }).googleAreas, [], "no Google, no area");
  assert.deepEqual(parseAreas(["gmail_read", "calendar"]), ["calendar", "gmail_read"]);
  // The whole Drive: offered only by a broker that names it — one deployed
  // before it existed keeps the dialog without the chip.
  assert.deepEqual(healthProviders({ providers: ["google"], googleAreas: ["calendar", "drive", "gmail", "gmail_read", "drive_all"] }).googleAreas, [...BASE, "gmail_read", "drive_all"]);
  assert.equal(healthProviders({ providers: ["google"], googleAreas: ["calendar", "drive", "gmail", "gmail_read"] }).googleAreas.includes("drive_all" as never), false);
  assert.deepEqual(parseAreas(["drive_all", "drive"]), ["drive", "drive_all"]);
});

test("health: a provider is offered only when the broker lists it; Testing only for a listed Google", () => {
  assert.deepEqual(healthProviders({ ok: true, providers: ["linkedin"] }), { linkedin: true, google: false, googleTesting: false, googleAreas: [] });
  assert.deepEqual(healthProviders({ ok: true, providers: ["linkedin", "google"], testing: ["google"] }), { linkedin: true, google: true, googleTesting: true, googleAreas: BASE });
  assert.deepEqual(healthProviders({ ok: true, providers: ["linkedin", "google"] }), { linkedin: true, google: true, googleTesting: false, googleAreas: BASE });
  assert.deepEqual(healthProviders({ providers: ["linkedin"], testing: ["google"] }), { linkedin: true, google: false, googleTesting: false, googleAreas: [] });
  assert.deepEqual(healthProviders(null), { linkedin: false, google: false, googleTesting: false, googleAreas: [] });
  assert.deepEqual(healthProviders({ providers: "google" }), { linkedin: false, google: false, googleTesting: false, googleAreas: [] });
});

test("a connected Google account: email as label, sub as identity, GRANTED scopes, both settings on approve", () => {
  const payload = { access_token: "AT", expires_in: 3599, scope: "openid email https://www.googleapis.com/auth/calendar.events", refresh_token: "RT" };
  const a = connectedGoogle("ana", { sub: "1098", email: "ana@example.org" }, payload, 1_000, true);
  assert.equal(a.provider, "google");
  assert.equal(a.label, "ana@example.org");
  assert.equal(a.externalId, "1098");
  assert.deepEqual(a.scopes, ["openid", "email", "https://www.googleapis.com/auth/calendar.events"], "what Google granted, not what was asked");
  assert.deepEqual(a.policies, { mail: "approve", calendar: "approve", drive: "approve" });
  assert.equal(a.refreshToken, "RT");
  assert.equal(a.expiresAt, 1_000 + 3_599_000, "the access token's expiry");
  assert.equal(a.refreshExpiresAt, 1_000 + 7 * 24 * 3600_000, "Testing: 7 days from connect");
});

test("the reconnect deadline: Google's own figure when it sends one, none when the app is not in Testing", () => {
  const base = { access_token: "AT", expires_in: 3600, scope: "openid", refresh_token: "RT" };
  assert.equal(connectedGoogle("ana", { sub: "1", email: "" }, { ...base, refresh_token_expires_in: 600 }, 1_000, true).refreshExpiresAt, 601_000);
  const live = connectedGoogle("ana", { sub: "1", email: "" }, base, 1_000, false);
  assert.equal(live.refreshExpiresAt, undefined);
  assert.equal(live.label, "1", "no email → the id, never an empty label");
});

test("outcomes name the provider; Google's access_denied names the test list", () => {
  assert.deepEqual(outcomeResponse("expired", "google"), { status: 410, body: { error: "This connection attempt expired — click Connect Google again." } });
  assert.deepEqual(outcomeResponse("expired"), { status: 410, body: { error: "This connection attempt expired — click Connect LinkedIn again." } });
  assert.deepEqual(outcomeResponse({ providerError: "server_error" }, "google"), { status: 502, body: { error: "Google connection failed (server_error)." } });
  const denied = outcomeResponse(errorOutcome("access_denied"), "google");
  assert.equal(denied.status, 403);
  assert.match(String(denied.body.error), /not on the test list of the shadok app — ask the instance operator/);
  assert.equal(outcomeResponse(errorOutcome("access_denied")).status, 502, "LinkedIn's is an ordinary provider error");
  assert.match(String(outcomeResponse("no-refresh", "google").body.error), /long-lived authorisation/);
});
