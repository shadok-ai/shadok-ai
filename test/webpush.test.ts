import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, verify } from "node:crypto";
import {
  encryptPayload,
  generateVapidKeys,
  vapidKeysValid,
  vapidAuthorization,
  parseSubscription,
  preview,
  topicFor,
  classifyPushStatus,
} from "../src/webpush.js";

const d = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

// RFC 8291, Section 5 and Appendix A.
const RFC = {
  plaintext: d("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
  asPrivate: d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: d("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  salt: d("DGv6ra1nlYgDCS1FRnbzlw"),
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: d(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
             mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`),
  ciphertext: d(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ`),
};

test("encryptPayload reproduces the RFC 8291 vector byte for byte", () => {
  const out = encryptPayload(
    RFC.plaintext,
    { endpoint: "https://push.example.net/x", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } },
    { salt: RFC.salt, senderPrivate: RFC.asPrivate },
  );
  assert.equal(out.length, 86 + RFC.ciphertext.length);
  assert.deepEqual(out.subarray(0, 86), RFC.header, "header (salt, rs=4096, keyid)");
  assert.deepEqual(out.subarray(86), RFC.ciphertext, "ciphertext + tag");
});

/** A receiver, written from the RFC independently of encryptPayload. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const rec = body.subarray(21 + idlen);
  const dc = createDecipheriv("aes-128-gcm", cek, nonce);
  dc.setAuthTag(rec.subarray(rec.length - 16));
  const plain = Buffer.concat([dc.update(rec.subarray(0, rec.length - 16)), dc.final()]);
  assert.equal(plain[plain.length - 1], 0x02, "last-record delimiter");
  return plain.subarray(0, -1);
}

test("a fresh message decrypts on the receiving side, with a new salt and key each time", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const sub = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  const msg = Buffer.from(JSON.stringify({ title: "général · dev", body: "Which branch? ✓" }));
  const a = encryptPayload(msg, sub);
  const b = encryptPayload(msg, sub);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "salt is random");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "sender key is ephemeral");
  assert.deepEqual(decrypt(a, ua.getPrivateKey(), ua.getPublicKey(), auth), msg);
});

test("VAPID: a valid ES256 JWT for the endpoint's origin, with a subject", () => {
  const keys = generateVapidKeys();
  assert.ok(vapidKeysValid(keys));
  assert.equal(Buffer.from(keys.publicKey, "base64url").length, 65);
  const h = vapidAuthorization("https://web.push.apple.com/QGz/abc?x=1", keys, "https://example.org", 1_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  const [, head, claims, sig, k] = m!;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    aud: "https://web.push.apple.com",
    exp: 1_000_000 + 12 * 3600,
    sub: "https://example.org",
  });
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: keys.privateJwk.x, y: keys.privateJwk.y }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("vapidKeysValid refuses junk read back from disk", () => {
  for (const bad of [null, {}, { publicKey: "x" }, { publicKey: "AAAA", privateJwk: { kty: "EC" } }]) {
    assert.equal(vapidKeysValid(bad), false);
  }
});

const goodKeys = { p256dh: RFC.uaPublic, auth: RFC.auth };

test("parseSubscription: only known push services, over https (no SSRF)", () => {
  for (const ep of [
    "https://web.push.apple.com/QGz",
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://db5p.notify.windows.com/w/?token=x",
  ]) {
    assert.equal(parseSubscription({ endpoint: ep, keys: goodKeys }).ok, true, ep);
  }
  for (const ep of [
    "http://web.push.apple.com/x",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost:3789/channels",
    "https://evilpush.apple.com.attacker.net/x",
    "https://notfcm.googleapis.com/x",
    "not a url",
  ]) {
    assert.equal(parseSubscription({ endpoint: ep, keys: goodKeys }).ok, false, ep);
  }
});

test("parseSubscription: checks the key shapes", () => {
  const ep = "https://web.push.apple.com/x";
  assert.equal(parseSubscription({ endpoint: ep, keys: { p256dh: "AAAA", auth: RFC.auth } }).ok, false);
  assert.equal(parseSubscription({ endpoint: ep, keys: { p256dh: RFC.uaPublic, auth: "AAAA" } }).ok, false);
  assert.equal(parseSubscription({ endpoint: ep }).ok, false);
  assert.equal(parseSubscription(null).ok, false);
});

test("preview, topic, status", () => {
  assert.equal(preview("  a\n\n b  "), "a b");
  const long = "word ".repeat(100);
  const p = preview(long, 50);
  assert.ok(p.length <= 50 && p.endsWith("…"), p);
  assert.equal(topicFor("agent:1234-abcd/x"), "agent1234-abcdx");
  assert.equal(topicFor("a".repeat(80)).length, 32);
  assert.equal(topicFor("::"), "shadok");
  assert.deepEqual(classifyPushStatus(201), { ok: true, gone: false });
  assert.deepEqual(classifyPushStatus(410), { ok: false, gone: true });
  assert.deepEqual(classifyPushStatus(404), { ok: false, gone: true });
  assert.deepEqual(classifyPushStatus(429), { ok: false, gone: false });
});
