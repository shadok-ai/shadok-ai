import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../broker/src/worker.js";
import { signState, type ConnectState } from "../broker/src/core.js";
import { APPS_KEY, appInputVerdict, applySave, applyDelete, openSecret, parseConfig, pickApp, sealSecret, type AppsConfig, type ConfigKV } from "../broker/src/apps.js";
import { resetAccessCache } from "../broker/src/access.js";

const BASE = "https://connect.shadok.ai";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => resetAccessCache());

/** An in-memory KV namespace, as much of it as the broker uses. */
function memKV(init?: AppsConfig): ConfigKV & { raw: () => string | undefined } {
  let v: string | undefined = init ? JSON.stringify(init) : undefined;
  return {
    async get() {
      return v === undefined ? null : JSON.parse(v);
    },
    async put(_k: string, val: string) {
      v = val;
    },
    raw: () => v,
  };
}

const base: Env = { LINKEDIN_CLIENT_ID: "cid", LINKEDIN_CLIENT_SECRET: "sekret", STATE_KEY: "state-key", GOOGLE_CLIENT_ID: "env-gcid", GOOGLE_CLIENT_SECRET: "env-gsekret" };
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
async function pubKey() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
}
const ret = (host: string) => `https://${host}/connect/google/done`;

async function stored(provider: "google" | "github" | "linkedin", host: string, clientId: string, secret: string, extra: { testing?: boolean; slug?: string } = {}) {
  return { clientId, secret: await sealSecret(KEY, provider, host, clientId, secret), ...extra, updatedAt: 1, updatedBy: "op@example.org" };
}

// ── apps.ts, pure ──

test("appInputVerdict refuses what is not a provider, a hostname or a client id", () => {
  assert.equal(appInputVerdict({ provider: "evil", clientId: "x" }).ok, false);
  assert.equal(appInputVerdict({ provider: "google", host: "https://demo.example.com", clientId: "x" }).ok, false);
  assert.equal(appInputVerdict({ provider: "google", host: "demo.example.com:3000", clientId: "x" }).ok, false);
  assert.equal(appInputVerdict({ provider: "google", clientId: "" }).ok, false);
  assert.equal(appInputVerdict({ provider: "google", clientId: "has space" }).ok, false);
  assert.equal(appInputVerdict({ provider: "google", clientId: "x", slug: "nope" }).ok, false, "a slug is GitHub only");
  const v = appInputVerdict({ provider: "google", host: " Demo.Example.COM ", clientId: "c", secret: "s", testing: "on" });
  assert.ok(v.ok);
  assert.deepEqual(v.ok && v.input, { provider: "google", host: "demo.example.com", clientId: "c", secret: "s", testing: true, slug: "" });
  const gh = appInputVerdict({ provider: "github", clientId: "c", testing: "on", slug: "my-app" });
  assert.ok(gh.ok && !gh.input.testing && gh.input.slug === "my-app", "Testing is a Google flag");
});

test("a sealed secret opens only for its own provider, host and client id", async () => {
  const s = await sealSecret(KEY, "google", "demo.example.com", "cid", "the-secret");
  assert.ok(!s.includes("the-secret"));
  assert.equal(await openSecret(KEY, "google", "demo.example.com", "cid", s), "the-secret");
  assert.equal(await openSecret(KEY, "google", "", "cid", s), null, "moved to the default entry");
  assert.equal(await openSecret(KEY, "google", "demo.example.com", "other", s), null, "paired with another client id");
  assert.equal(await openSecret(KEY, "github", "demo.example.com", "cid", s), null, "moved to another provider");
  const otherKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  assert.equal(await openSecret(otherKey, "google", "demo.example.com", "cid", s), null);
});

test("saving without a secret keeps the stored one, but never for a new client id", async () => {
  let cfg: AppsConfig = {};
  const first = await applySave(cfg, { provider: "google", host: "", clientId: "c1", secret: "", testing: false, slug: "" }, KEY, "op", 1);
  assert.equal(first.ok, false, "a new app needs its secret");
  const r = await applySave(cfg, { provider: "google", host: "", clientId: "c1", secret: "s1", testing: true, slug: "" }, KEY, "op", 1);
  assert.ok(r.ok);
  cfg = r.ok ? r.cfg : cfg;
  const keep = await applySave(cfg, { provider: "google", host: "", clientId: "c1", secret: "", testing: false, slug: "" }, KEY, "op2", 2);
  assert.ok(keep.ok);
  const d = keep.ok ? keep.cfg.google!.default! : null;
  assert.equal(await openSecret(KEY, "google", "", "c1", d!.secret), "s1");
  assert.equal(d!.testing, undefined, "the flag follows the form");
  assert.equal(d!.updatedBy, "op2");
  const swap = await applySave(cfg, { provider: "google", host: "", clientId: "c2", secret: "", testing: false, slug: "" }, KEY, "op", 3);
  assert.equal(swap.ok, false);
});

test("pickApp: the domain's app, then the legacy alternative, then the default, then the Worker secrets", async () => {
  const envApps = { default: { id: "env" , secret: "e" }, alt: { id: "alt", secret: "a", hosts: ["legacy.example.com"] } };
  const cfg = { default: await stored("google", "", "kv-default", "x"), hosts: { "demo.example.com": await stored("google", "demo.example.com", "kv-demo", "y") } };
  const id = (p: ReturnType<typeof pickApp>) => (p?.from === "kv" ? p.app.clientId : p?.app.id);
  assert.equal(id(pickApp(cfg, envApps, "Demo.Example.com")), "kv-demo");
  assert.equal(id(pickApp(cfg, envApps, "legacy.example.com")), "alt");
  assert.equal(id(pickApp(cfg, envApps, "other.example.com")), "kv-default");
  assert.equal(id(pickApp({}, envApps, "other.example.com")), "env");
  assert.equal(pickApp({}, { default: null, alt: null }, "x.example.com"), null);
});

test("parseConfig keeps only well-formed entries", () => {
  const cfg = parseConfig({ google: { default: { clientId: "c", secret: "s" }, hosts: { "Bad Host": { clientId: "c", secret: "s" }, "ok.example.com": { clientId: 1 } } }, evil: {} });
  assert.deepEqual(Object.keys(cfg), ["google"]);
  assert.equal(cfg.google!.default!.clientId, "c");
  assert.equal(cfg.google!.hosts, undefined);
  assert.deepEqual(applyDelete(cfg, "google", ""), { google: {} });
});

// ── the Worker reading the KV config ──

async function startClient(e: Env, host: string): Promise<string | null> {
  const r = await worker.fetch(new Request(`${BASE}/google/start?return=${encodeURIComponent(ret(host))}&pub=${await pubKey()}&nonce=${nonce}&areas=calendar`), e);
  return r.status === 302 ? new URL(r.headers.get("location")!).searchParams.get("client_id") : null;
}

test("the admin page's apps win over the Worker secrets, per domain", async () => {
  const kv = memKV({ google: { default: await stored("google", "", "kv-default", "s0"), hosts: { "demo.example.com": await stored("google", "demo.example.com", "kv-demo", "s1") } } });
  const e: Env = { ...base, CONFIG: kv, CONFIG_KEY: KEY };
  assert.equal(await startClient(e, "demo.example.com"), "kv-demo");
  assert.equal(await startClient(e, "cockpit.example.com"), "kv-default");
  assert.equal(await startClient({ ...base }, "demo.example.com"), "env-gcid", "no KV: the Worker secrets, as before");
});

test("a KV default alone offers the provider; a secret that cannot be opened is a clear error, not a crash", async () => {
  const kv = memKV({ github: { default: await stored("github", "", "Iv-kv", "ghs", { slug: "kv-app" }) } });
  const h = await (await worker.fetch(new Request(`${BASE}/health`), { ...base, CONFIG: kv, CONFIG_KEY: KEY })).json() as { providers: string[]; githubInstallUrl?: string };
  assert.ok(h.providers.includes("github"));
  assert.equal(h.githubInstallUrl, "https://github.com/apps/kv-app/installations/new");
  const kv2 = memKV({ google: { default: await stored("google", "", "kv-default", "s0") } });
  const r = await worker.fetch(new Request(`${BASE}/google/start?return=${encodeURIComponent(ret("x.example.com"))}&pub=${await pubKey()}&nonce=${nonce}&areas=calendar`), { ...base, CONFIG: kv2 });
  assert.equal(r.status, 500, "CONFIG_KEY missing");
  assert.match(await r.text(), /misconfigured/);
});

test("the callback stamps the 7-day deadline for a Testing app only, and /health reports the default app's flag", async () => {
  const kv = memKV({ google: { default: await stored("google", "", "kv-default", "s0", { testing: true }), hosts: { "demo.example.com": await stored("google", "demo.example.com", "kv-demo", "s1") } } });
  const e: Env = { ...base, CONFIG: kv, CONFIG_KEY: KEY };
  const h = await (await worker.fetch(new Request(`${BASE}/health`), e)).json() as { testing?: string[]; deadlineStamped?: boolean };
  assert.deepEqual(h.testing, ["google"]);
  assert.equal(h.deadlineStamped, true);

  async function exchange(host: string): Promise<{ client: string; stamped: unknown }> {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const st: ConnectState = { v: 1, provider: "google", returnUrl: ret(host), pub, nonce, iat: Date.now(), areas: ["calendar"] };
    let client = "";
    globalThis.fetch = (async (_u: unknown, init: { body: URLSearchParams }) => {
      const b = new URLSearchParams(init.body);
      client = `${b.get("client_id")}:${b.get("client_secret")}`;
      return new Response(JSON.stringify({ access_token: "AT", expires_in: 3599, scope: "s", refresh_token: "RT" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await worker.fetch(new Request(`${BASE}/google/callback?code=c&state=${encodeURIComponent(await signState(st, e.STATE_KEY))}`), e);
    const html = await r.text();
    const c = /#n=[^&]+&amp;c=([^"]+)"/.exec(html)![1];
    const [bp, iv, ct] = c.split(".");
    const brokerPub = await crypto.subtle.importKey("raw", Buffer.from(bp, "base64url"), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: brokerPub }, kp.privateKey, 256);
    const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("shadok-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url"), additionalData: Buffer.from(nonce, "base64url") }, aes, Buffer.from(ct, "base64url"));
    return { client, stamped: JSON.parse(new TextDecoder().decode(pt)).refresh_token_expires_in };
  }
  const t = await exchange("cockpit.example.com");
  assert.equal(t.client, "kv-default:s0");
  assert.equal(t.stamped, 7 * 24 * 3600);
  const d = await exchange("demo.example.com");
  assert.equal(d.client, "kv-demo:s1");
  assert.equal(d.stamped, undefined, "a verified app's tokens carry no invented deadline");
});

test("a refresh tries the KV apps too, each client id once", async () => {
  const kv = memKV({ google: { default: await stored("google", "", "kv-default", "s0"), hosts: { "demo.example.com": await stored("google", "demo.example.com", "kv-demo", "s1"), "b.example.com": await stored("google", "b.example.com", "kv-default", "s0") } } });
  const tried: string[] = [];
  globalThis.fetch = (async (_u: unknown, init: { body: URLSearchParams }) => {
    const id = new URLSearchParams(init.body).get("client_id")!;
    tried.push(id);
    return id === "kv-demo"
      ? new Response(JSON.stringify({ access_token: "new", expires_in: 3599, scope: "s" }), { status: 200 })
      : new Response(JSON.stringify({ error: "unauthorized_client" }), { status: 401 });
  }) as unknown as typeof fetch;
  const r = await worker.fetch(new Request(`${BASE}/google/refresh`, { method: "POST", body: JSON.stringify({ refresh_token: "rt" }), headers: { "content-type": "application/json" } }), { ...base, CONFIG: kv, CONFIG_KEY: KEY });
  assert.equal(r.status, 200);
  assert.deepEqual(tried, ["kv-default", "env-gcid", "kv-demo"]);
});

// ── the admin page, behind Cloudflare Access ──

const rsa = crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
async function jwt(claims: Record<string, unknown>, kid = "k1"): Promise<string> {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await rsa).privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString("base64url")}`;
}
async function stubCerts(): Promise<void> {
  const jwk = await crypto.subtle.exportKey("jwk", (await rsa).publicKey);
  globalThis.fetch = (async (u: unknown) => {
    assert.equal(String(u), `https://${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }), { status: 200 });
  }) as unknown as typeof fetch;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: now() + 600, email: "Op@Example.org" });
const aenv = (kv = memKV()): Env => ({ ...base, CONFIG: kv, CONFIG_KEY: KEY, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
const adminReq = (path: string, token: string | null, init: RequestInit = {}) =>
  new Request(BASE + path, { ...init, headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...((init.headers as Record<string, string>) ?? {}) } });

test("without Access configured, /admin is not a broker route", async () => {
  const r = await worker.fetch(adminReq("/admin", null), { ...base });
  assert.equal(r.status, 404);
});

test("/admin is a bare 404 without a valid Access token", async () => {
  await stubCerts();
  const e = aenv();
  const bad = [null, "garbage", await jwt({ ...good(), aud: ["other"] }), await jwt({ ...good(), iss: "https://evil.cloudflareaccess.com" }), await jwt({ ...good(), exp: now() - 1 }), await jwt(good(), "unknown-kid")];
  for (const t of bad) assert.equal((await worker.fetch(adminReq("/admin", t), e)).status, 404, String(t).slice(0, 20));
  // A token signed by another key under the right kid.
  const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
  const t = await jwt(good());
  const [h, c] = t.split(".");
  const forged = `${h}.${c}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, new TextEncoder().encode(`${h}.${c}`))).toString("base64url")}`;
  assert.equal((await worker.fetch(adminReq("/admin", forged), e)).status, 404);
  assert.equal((await worker.fetch(adminReq("/admin", t), { ...e, ADMIN_EMAILS: "someone@else.org" })).status, 404, "not on the allowlist");
});

test("an admin saves an app for a domain: stored sealed, never shown back, served at once", async () => {
  await stubCerts();
  const kv = memKV();
  const e = aenv(kv);
  const t = await jwt(good());
  const page = await worker.fetch(adminReq("/admin", t), e);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.match(await page.text(), /op@example\.org/);

  const form = new URLSearchParams({ provider: "google", host: "Demo.Example.com", clientId: "demo-cid", secret: "demo-secret-value" });
  const noOrigin = await worker.fetch(adminReq("/admin/save", t, { method: "POST", body: form }), e);
  assert.equal(noOrigin.status, 403, "a write needs a same-origin Origin");
  const crossSite = await worker.fetch(adminReq("/admin/save", t, { method: "POST", body: form, headers: { origin: "https://evil.example" } }), e);
  assert.equal(crossSite.status, 403);

  const r = await worker.fetch(adminReq("/admin/save", t, { method: "POST", body: form, headers: { origin: BASE } }), e);
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location")!, /ok=/);
  assert.ok(!kv.raw()!.includes("demo-secret-value"), "KV holds the ciphertext only");
  const cfg = parseConfig(JSON.parse(kv.raw()!));
  assert.equal(cfg.google!.hosts!["demo.example.com"].updatedBy, "op@example.org");

  const after = await (await worker.fetch(adminReq("/admin", t), e)).text();
  assert.match(after, /demo\.example\.com/);
  assert.match(after, /demo-cid/);
  assert.ok(!after.includes("demo-secret-value"));
  assert.equal(await startClient(e, "demo.example.com"), "demo-cid");
  assert.equal(await startClient(e, "cockpit.example.com"), "env-gcid");

  const del = await worker.fetch(adminReq("/admin/delete", t, { method: "POST", body: new URLSearchParams({ provider: "google", host: "demo.example.com" }), headers: { origin: BASE } }), e);
  assert.equal(del.status, 303);
  assert.equal(await startClient(e, "demo.example.com"), "env-gcid");
});

test("a refused save says why and writes nothing", async () => {
  await stubCerts();
  const kv = memKV();
  const t = await jwt(good());
  const r = await worker.fetch(adminReq("/admin/save", t, { method: "POST", body: new URLSearchParams({ provider: "google", host: "", clientId: "c" }), headers: { origin: BASE } }), aenv(kv));
  assert.equal(r.status, 303);
  assert.match(new URL(r.headers.get("location")!).searchParams.get("err")!, /client secret/);
  assert.equal(kv.raw(), undefined);
  assert.equal(APPS_KEY, "apps:v1");
});
