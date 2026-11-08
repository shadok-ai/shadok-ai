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
