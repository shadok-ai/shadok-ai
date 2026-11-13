import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateReturnUrl,
  signState,
  verifyState,
  encryptForInstance,
  type ConnectState,
} from "../broker/src/core.js";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

test("validateReturnUrl accepts https anywhere and http on private hosts", () => {
  for (const u of [
    "https://cockpit.acme.com/connect/linkedin/done",
    "http://localhost:3789/connect/linkedin/done",
    "http://127.0.0.1:3789/connect/linkedin/done",
    "http://[::1]:3789/connect/linkedin/done",
    "http://10.1.2.3/connect/linkedin/done",
    "http://172.16.0.1/connect/linkedin/done",
    "http://172.31.255.1/connect/linkedin/done",
    "http://192.168.1.5:3789/connect/linkedin/done",
  ]) assert.equal(validateReturnUrl(u).ok, true, u);
});

test("validateReturnUrl refuses everything else", () => {
  for (const u of [
    "http://evil.com/connect/linkedin/done",
    "http://172.32.0.1/connect/linkedin/done",
    "http://11.0.0.1/connect/linkedin/done",
    "http://10.0.0.1.evil.com/connect/linkedin/done",
    "https://x.com/other",
    "https://x.com/connect/linkedin/done/",
    "https://u:p@x.com/connect/linkedin/done",
    "https://u@x.com/connect/linkedin/done",
    "javascript:alert(1)",
    "ftp://x.com/connect/linkedin/done",
    "not a url",
    "",
    // A query or a hash would ride along in front of the broker's own #n=… fragment.
    "https://x.com/connect/linkedin/done?next=evil",
    "https://x.com/connect/linkedin/done?",
    "https://x.com/connect/linkedin/done#n=forged",
  ]) assert.equal(validateReturnUrl(u).ok, false, u);
});

const key = "k".repeat(32);
const mk = (iat = Date.now()): ConnectState => ({
  v: 1,
  provider: "linkedin",
  returnUrl: "https://x.com/connect/linkedin/done",
  pub: "AAAA",
  nonce: b64u(crypto.getRandomValues(new Uint8Array(16))),
  iat,
});

test("state round-trips", async () => {
  const s = mk();
  assert.deepEqual(await verifyState(await signState(s, key), key), s);
});

test("state: tampering, wrong key, expiry, garbage all give null", async () => {
  const tok = await signState(mk(), key);
  const [p, m] = tok.split(".");
  const flipped = (x: string) => (x[0] === "A" ? "B" : "A") + x.slice(1);
  assert.equal(await verifyState(flipped(p) + "." + m, key), null);
  assert.equal(await verifyState(p + "." + flipped(m), key), null);
  assert.equal(await verifyState(tok, "other-key"), null);
  assert.equal(await verifyState(await signState(mk(Date.now() - 16 * 60_000), key), key), null);
  assert.equal(await verifyState("nodot", key), null);
  assert.equal(await verifyState("", key), null);
});

test("encryptForInstance output decrypts with WebCrypto (format contract for the instance)", async () => {
  const subtle = globalThis.crypto.subtle;
  const inst = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = b64u(new Uint8Array(await subtle.exportKey("raw", inst.publicKey)));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const payload = { access_token: "tok-123", expires_in: 5184000, scope: "w_member_social", refresh_token: "r" };
  const out = await encryptForInstance(pub, b64u(nonce), payload);
  const parts = out.split(".");
  assert.equal(parts.length, 3);
  const [bp, iv, ct] = parts.map(unb64u);
  assert.equal(iv.length, 12);
  const brokerPub = await subtle.importKey("raw", bp, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: brokerPub }, inst.privateKey, 256);
  const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("shadok-connect-v1") },
    hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const pt = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: nonce }, aes, ct);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(pt)), payload);
  // a different nonce as AAD must fail
  await assert.rejects(
    subtle.decrypt({ name: "AES-GCM", iv, additionalData: crypto.getRandomValues(new Uint8Array(16)) }, aes, ct),
  );
});

test("encryptForInstance refuses a bad public key", async () => {
  await assert.rejects(encryptForInstance("AAAA", b64u(new Uint8Array(16)), { access_token: "x", expires_in: 1, scope: "" }));
});

// ── Google (spec 2026-11-13-connected-accounts-google-design.md) ──

import { GOOGLE_AREAS, googleScope, parseGoogleAreas, returnPathFor } from "../broker/src/core.js";

test("parseGoogleAreas keeps known areas in table order and refuses anything else", () => {
  assert.deepEqual(parseGoogleAreas("gmail,calendar"), ["calendar", "gmail"]);
  assert.deepEqual(parseGoogleAreas(" drive , drive "), ["drive"]);
  assert.equal(parseGoogleAreas(""), null);
  assert.equal(parseGoogleAreas("calendar,contacts"), null, "one unknown name refuses the lot");
  assert.equal(parseGoogleAreas("https://www.googleapis.com/auth/drive"), null, "a raw scope is not an area");
});

test("googleScope always asks for identity, then only the ticked areas", () => {
  assert.equal(googleScope(["drive"]), `openid email profile ${GOOGLE_AREAS.drive[0]}`);
  const all = googleScope(["calendar", "drive", "gmail"]);
  assert.match(all, /calendar\.events/);
  assert.match(all, /drive\.file/);
  assert.match(all, /gmail\.compose/);
  assert.doesNotMatch(all, /auth\/drive( |$)/, "never the restricted full-Drive scope");
});

test("validateReturnUrl pins the path to the provider", () => {
  assert.equal(validateReturnUrl(`https://c.example.com${returnPathFor("google")}`, "google").ok, true);
  assert.equal(validateReturnUrl(`https://c.example.com${returnPathFor("linkedin")}`, "google").ok, false);
  assert.equal(validateReturnUrl(`https://c.example.com${returnPathFor("google")}`).ok, false, "the default stays LinkedIn's");
});

test("verifyState accepts a google state with its areas and refuses an unknown provider", async () => {
  const key = "k";
  const s: ConnectState = { v: 1, provider: "google", areas: ["calendar"], returnUrl: "https://c.example.com/connect/google/done", pub: "p", nonce: "n", iat: Date.now() };
  assert.deepEqual(await verifyState(await signState(s, key), key), s);
  const bogus = { ...s, provider: "myspace" } as unknown as ConnectState;
  assert.equal(await verifyState(await signState(bogus, key), key), null);
});
