import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../broker/src/worker.js";
import { signState, verifyState, RETURN_PATH, type ConnectState } from "../broker/src/core.js";

const env: Env = { LINKEDIN_CLIENT_ID: "cid", LINKEDIN_CLIENT_SECRET: "sekret", STATE_KEY: "state-key" };
const BASE = "https://connect.shadok.ai";
const RETURN = `https://cockpit.acme.com${RETURN_PATH}`;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return { kp, pub };
}
const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
const mkState = (pub: string, over: Partial<ConnectState> = {}): ConnectState => ({
  v: 1, provider: "linkedin", returnUrl: RETURN, pub, nonce, iat: Date.now(), ...over,
});
const get = (path: string) => worker.fetch(new Request(BASE + path), env);

// What /health says a Google-enabled broker accepts at /google/start.
const AREAS = ["calendar", "drive", "gmail", "gmail_read"];

test("/health lists the providers", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, providers: ["linkedin"] });
});

test("/linkedin/start redirects to LinkedIn with a verifiable state", async () => {
  const { pub } = await keypair();
  const r = await get(`/linkedin/start?return=${encodeURIComponent(RETURN)}&pub=${pub}&nonce=${nonce}`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(loc.searchParams.get("response_type"), "code");
  assert.equal(loc.searchParams.get("client_id"), "cid");
  assert.equal(loc.searchParams.get("redirect_uri"), `${BASE}/linkedin/callback`);
  assert.equal(loc.searchParams.get("scope"), "openid profile w_member_social");
  const st = await verifyState(loc.searchParams.get("state")!, env.STATE_KEY);
  assert.equal(st?.returnUrl, RETURN);
  assert.equal(st?.pub, pub);
  assert.equal(st?.nonce, nonce);
});

test("/linkedin/start refuses a public http return and missing params", async () => {
  const { pub } = await keypair();
  const bad = encodeURIComponent(`http://evil.example.com${RETURN_PATH}`);
  assert.equal((await get(`/linkedin/start?return=${bad}&pub=${pub}&nonce=${nonce}`)).status, 400);
  assert.equal((await get(`/linkedin/start?return=${encodeURIComponent(RETURN)}&nonce=${nonce}`)).status, 400);
  assert.equal((await get(`/linkedin/start?return=${encodeURIComponent(RETURN)}&pub=${pub}`)).status, 400);
});

test("callback exchanges the code and renders a continue link carrying the encrypted token", async () => {
  const { kp, pub } = await keypair();
  const state = await signState(mkState(pub), env.STATE_KEY);
  let sent: URLSearchParams | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), "https://www.linkedin.com/oauth/v2/accessToken");
    sent = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ access_token: "AT-123", expires_in: 5184000, scope: "openid" }), { status: 200 });
  }) as typeof fetch;
  const r = await get(`/linkedin/callback?code=thecode&state=${encodeURIComponent(state)}`);
  assert.equal(r.status, 200);
  assert.equal(sent!.get("grant_type"), "authorization_code");
  assert.equal(sent!.get("code"), "thecode");
  assert.equal(sent!.get("client_secret"), "sekret");
  assert.equal(sent!.get("redirect_uri"), `${BASE}/linkedin/callback`);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'");
  const html = await r.text();
  assert.match(html, /cockpit\.acme\.com/);
  assert.match(html, /Only continue if that is your cockpit/);
  assert.ok(!html.includes("AT-123") && !html.includes("sekret"));
  const m = /href="([^"]*#n=[^"]*&amp;c=([^"&]+))"/.exec(html);
  assert.ok(m, "continue link");
  assert.ok(m![1].startsWith(`${RETURN}#n=${nonce}&amp;c=`));
  const [bp, iv, ct] = m![2].split(".");
  const brokerPub = await crypto.subtle.importKey("raw", unb64u(bp), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: brokerPub }, kp.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("shadok-connect-v1") },
    hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv), additionalData: unb64u(nonce) }, aes, unb64u(ct));
  assert.equal(JSON.parse(new TextDecoder().decode(pt)).access_token, "AT-123");
  assert.match(html, new RegExp(`href="${RETURN.replace(/[/.]/g, "\\$&")}#n=${nonce}&amp;error=cancelled"`));
});

test("callback with a LinkedIn error links back with that error", async () => {
  const { pub } = await keypair();
  const state = await signState(mkState(pub), env.STATE_KEY);
  globalThis.fetch = (async () => { throw new Error("must not be called"); }) as typeof fetch;
  const r = await get(`/linkedin/callback?error=user_cancelled_authorize&state=${encodeURIComponent(state)}`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes(`#n=${nonce}&amp;error=user_cancelled_authorize"`));
});

test("a failed token exchange says only the status", async () => {
  const { pub } = await keypair();
  const state = await signState(mkState(pub), env.STATE_KEY);
  globalThis.fetch = (async () => new Response("secret-body-sekret", { status: 401 })) as typeof fetch;
  const r = await get(`/linkedin/callback?code=c&state=${encodeURIComponent(state)}`);
  const html = await r.text();
  assert.match(html, /LinkedIn refused the connection \(HTTP 401\)/);
  assert.ok(html.includes(`#n=${nonce}&amp;error=token_exchange_failed"`));
  assert.ok(!html.includes("secret-body"));
});

test("a tampered or bad state is a 400 with no link and no token call", async () => {
  const { pub } = await keypair();
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  const good = await signState(mkState(pub), env.STATE_KEY);
  const tampered = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
  // signed with the right key but carrying a hostile return url / empty fields
  const evil = await signState(mkState(pub, { returnUrl: "https://x.example/steal" }), env.STATE_KEY);
  const noPub = await signState(mkState("", {}), env.STATE_KEY);
  for (const s of [tampered, evil, noPub, ""]) {
    const r = await get(`/linkedin/callback?code=c&state=${encodeURIComponent(s)}`);
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes("href="));
  }
  assert.equal(called, false);
});

test("unknown routes are 404", async () => {
  assert.equal((await get("/nope")).status, 404);
});

test("with a SITE binding, paths the broker does not own go to the site, any method", async () => {
  const seen: string[] = [];
  const site = { fetch: async (req: Request) => (seen.push(`${req.method} ${new URL(req.url).pathname}`), new Response("site", { status: 200 })) };
  const withSite: Env = { ...env, SITE: site };
  assert.equal(await (await worker.fetch(new Request(BASE + "/"), withSite)).text(), "site");
  const post = await worker.fetch(new Request(BASE + "/waitlist", { method: "POST", body: "email=a@b.co" }), withSite);
  assert.equal(post.status, 200);
  assert.equal((await worker.fetch(new Request(BASE + "/x/start"), withSite)).status, 200, "an unknown provider is not the broker's");
  assert.deepEqual(seen, ["GET /", "POST /waitlist", "GET /x/start"]);
});

test("with a SITE binding, the broker's own routes never reach the site", async () => {
  const site = { fetch: async () => assert.fail("forwarded a broker route") };
  const withSite: Env = { ...env, SITE: site };
  assert.equal((await worker.fetch(new Request(BASE + "/health"), withSite)).status, 200);
  assert.equal((await worker.fetch(new Request(BASE + "/linkedin/start", { method: "POST" }), withSite)).status, 405);
  assert.equal((await worker.fetch(new Request(BASE + "/linkedin/callback"), withSite)).status, 400);
});

test("/linkedin/start refuses a nonce or pub of the wrong shape", async () => {
  const { pub } = await keypair();
  const ret = encodeURIComponent(RETURN);
  let called = 0;
  for (const [p, n] of [
    [pub, nonce.slice(0, 21)],
    [pub, nonce + "A"],
    [pub, nonce.slice(0, 21) + "="],
    [pub.slice(0, 86), nonce],
    [pub + "A", nonce],
    [pub.slice(0, 86) + "%2B", nonce],
    ["AAAA", nonce],
  ]) {
    const r = await get(`/linkedin/start?return=${ret}&pub=${p}&nonce=${n}`);
    assert.equal(r.status, 400, `${p} / ${n}`);
    called++;
  }
  assert.equal(called, 7);
  assert.equal((await get(`/linkedin/start?return=${ret}&pub=${pub}&nonce=${nonce}`)).status, 302);
});

test("a token exchange that throws links back with token_exchange_failed", async () => {
  const { pub } = await keypair();
  const state = await signState(mkState(pub), env.STATE_KEY);
  globalThis.fetch = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  const r = await get(`/linkedin/callback?code=c&state=${encodeURIComponent(state)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /could not reach LinkedIn/i);
  assert.ok(html.includes(`#n=${nonce}&amp;error=token_exchange_failed"`));
  assert.ok(!html.includes("network down"));
});

test("a 200 with a malformed body says LinkedIn answered unexpectedly, not 'refused'", async () => {
  const { pub } = await keypair();
  const state = await signState(mkState(pub), env.STATE_KEY);
  globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
  const r = await get(`/linkedin/callback?code=c&state=${encodeURIComponent(state)}`);
  const html = await r.text();
  assert.match(html, /LinkedIn returned an unexpected answer\./);
  assert.ok(!html.includes("refused"));
  assert.ok(html.includes(`#n=${nonce}&amp;error=token_exchange_failed"`));
});

// ── Google ──

const genv: Env = { ...env, GOOGLE_CLIENT_ID: "gcid", GOOGLE_CLIENT_SECRET: "gsekret" };
const GRETURN = `https://cockpit.acme.com/connect/google/done`;
const gget = (path: string, e: Env = genv) => worker.fetch(new Request(BASE + path), e);
const refreshReq = (body: unknown, e: Env = genv, method = "POST") =>
  worker.fetch(new Request(BASE + "/google/refresh", { method, ...(method === "POST" ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), e);

test("/health lists google only once its secrets exist, and says when it is in Testing", async () => {
  assert.deepEqual((await (await get("/health")).json()).providers, ["linkedin"]);
  assert.deepEqual(await (await gget("/health")).json(), { ok: true, providers: ["linkedin", "google"], googleAreas: AREAS });
  assert.deepEqual(await (await gget("/health", { ...genv, GOOGLE_TESTING: "1" })).json(), { ok: true, providers: ["linkedin", "google"], testing: ["google"], googleAreas: AREAS });
});

test("without Google secrets, /google/* is not a broker route", async () => {
  assert.equal((await gget(`/google/start?return=${encodeURIComponent(GRETURN)}`, env)).status, 404);
  assert.equal((await refreshReq({ refresh_token: "x" }, env)).status, 404);
});

test("/google/start asks for offline access with the ticked areas only, carried in the signed state", async () => {
  const { pub } = await keypair();
  const r = await gget(`/google/start?return=${encodeURIComponent(GRETURN)}&pub=${pub}&nonce=${nonce}&areas=gmail,calendar`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), "gcid");
  assert.equal(loc.searchParams.get("redirect_uri"), `${BASE}/google/callback`);
  assert.equal(loc.searchParams.get("access_type"), "offline");
  assert.equal(loc.searchParams.get("prompt"), "consent");
  assert.equal(loc.searchParams.get("include_granted_scopes"), "true");
  const scope = loc.searchParams.get("scope")!;
  assert.match(scope, /^openid email profile /);
  assert.match(scope, /calendar\.events/);
  assert.match(scope, /gmail\.compose/);
  assert.doesNotMatch(scope, /drive/);
  const st = await verifyState(loc.searchParams.get("state")!, genv.STATE_KEY);
  assert.equal(st?.provider, "google");
  assert.deepEqual(st?.areas, ["calendar", "gmail"]);
});

test("/google/start refuses no area, an unknown area, and LinkedIn's return path", async () => {
  const { pub } = await keypair();
  const base = `return=${encodeURIComponent(GRETURN)}&pub=${pub}&nonce=${nonce}`;
  assert.equal((await gget(`/google/start?${base}`)).status, 400);
  assert.equal((await gget(`/google/start?${base}&areas=calendar,contacts`)).status, 400);
  assert.equal((await gget(`/google/start?return=${encodeURIComponent(RETURN)}&pub=${pub}&nonce=${nonce}&areas=drive`)).status, 400);
});

test("a LinkedIn state is never redeemed at the Google callback, nor the reverse", async () => {
  const { pub } = await keypair();
  globalThis.fetch = (async () => assert.fail("no token call for a cross-provider state")) as typeof fetch;
  const li = await signState(mkState(pub), env.STATE_KEY);
  assert.equal((await gget(`/google/callback?code=c&state=${encodeURIComponent(li)}`)).status, 400);
  const g = await signState(mkState(pub, { provider: "google", areas: ["drive"], returnUrl: GRETURN }), env.STATE_KEY);
  assert.equal((await gget(`/linkedin/callback?code=c&state=${encodeURIComponent(g)}`)).status, 400);
});

test("the Google callback exchanges the code with Google's secret and hands back the refresh token", async () => {
  const { kp, pub } = await keypair();
  const state = await signState(mkState(pub, { provider: "google", areas: ["drive"], returnUrl: GRETURN }), env.STATE_KEY);
  let sent: URLSearchParams | undefined;
  let to = "";
  globalThis.fetch = (async (u: string, init: RequestInit) => {
    to = u;
    sent = new URLSearchParams(String(init.body));
    return Response.json({ access_token: "ga", expires_in: 3599, scope: "openid drive.file", refresh_token: "gr", id_token: "never-forwarded" });
  }) as typeof fetch;
  const r = await gget(`/google/callback?code=thecode&state=${encodeURIComponent(state)}`);
  assert.equal(r.status, 200);
  assert.equal(to, "https://oauth2.googleapis.com/token");
  assert.equal(sent?.get("client_secret"), "gsekret");
  assert.equal(sent?.get("redirect_uri"), `${BASE}/google/callback`);
  const html = await r.text();
  assert.match(html, /Connect Google/);
  const href = /href="([^"]+#n=[^"]+&amp;c=[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
  assert.ok(href.startsWith(GRETURN + "#"));
  const c = new URLSearchParams(href.split("#")[1]).get("c")!;
  const [bp, iv, ct] = c.split(".").map(unb64u);
  const brokerPub = await crypto.subtle.importKey("raw", bp, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: brokerPub }, kp.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("shadok-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: unb64u(nonce) }, aes, ct)));
  assert.equal(pt.refresh_token, "gr");
  assert.equal(pt.access_token, "ga");
  assert.equal(pt.id_token, undefined);
});

test("/google/refresh adds the client secret and returns only the new access token", async () => {
  let sent: URLSearchParams | undefined;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    sent = new URLSearchParams(String(init.body));
    return Response.json({ access_token: "new", expires_in: 3599, scope: "s", token_type: "Bearer" });
  }) as typeof fetch;
  const r = await refreshReq({ refresh_token: "rt" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { access_token: "new", expires_in: 3599, scope: "s" });
  assert.equal(sent?.get("grant_type"), "refresh_token");
  assert.equal(sent?.get("refresh_token"), "rt");
  assert.equal(sent?.get("client_secret"), "gsekret");
});

test("/google/refresh passes invalid_grant through as a 400 and never echoes the token", async () => {
  globalThis.fetch = (async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 })) as typeof fetch;
  const r = await refreshReq({ refresh_token: "secret-rt" });
  assert.equal(r.status, 400);
  const body = await r.text();
  assert.deepEqual(JSON.parse(body), { error: "invalid_grant", status: 400 });
  assert.doesNotMatch(body, /secret-rt/);
});

test("/google/refresh: provider trouble is a 502 with a sanitised code", async () => {
  globalThis.fetch = (async () => new Response("<html>oops</html>", { status: 503 })) as typeof fetch;
  assert.deepEqual(await (await refreshReq({ refresh_token: "rt" })).json(), { error: "refresh_failed", status: 503 });
  globalThis.fetch = (async () => Response.json({ error: "Weird <b>code</b>" }, { status: 401 })) as typeof fetch;
  assert.deepEqual(await (await refreshReq({ refresh_token: "rt" })).json(), { error: "refresh_failed", status: 401 });
  globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
  assert.equal((await refreshReq({ refresh_token: "rt" })).status, 502);
});

test("/google/refresh refuses a bad body and a non-POST, and LinkedIn has no refresh route", async () => {
  globalThis.fetch = (async () => assert.fail("no Google call")) as typeof fetch;
  assert.equal((await refreshReq({})).status, 400);
  assert.equal((await refreshReq({ refresh_token: "x".repeat(3000) })).status, 400);
  assert.equal((await refreshReq(null, genv, "GET")).status, 405);
  assert.equal((await worker.fetch(new Request(BASE + "/linkedin/refresh", { method: "POST", body: "{}" }), genv)).status, 404);
});
