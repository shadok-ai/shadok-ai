import assert from "node:assert/strict";
import test from "node:test";
import { encryptForInstance } from "../broker/src/core.js";
import { CONNECT_TTL_MS, PendingAttempts, decryptPayload, newAttempt } from "../src/connect-crypto.js";

const payload = { access_token: "tok-secret", expires_in: 5184000, scope: "w_member_social" };

test("broker encryption round-trips through decryptPayload", async () => {
  const { attempt, pub, nonce } = newAttempt("ada", 0);
  assert.equal(Buffer.from(pub, "base64url").length, 65);
  assert.equal(Buffer.from(nonce, "base64url").length, 16);
  const blob = await encryptForInstance(pub, nonce, payload);
  assert.deepEqual(decryptPayload(attempt, blob), payload);
});

test("a different nonce (AAD) or a different attempt key fails", async () => {
  const a = newAttempt("ada", 0);
  const b = newAttempt("ada", 0);
  const blob = await encryptForInstance(a.pub, b.nonce, payload);
  assert.throws(() => decryptPayload(a.attempt, blob));
  const blob2 = await encryptForInstance(a.pub, a.nonce, payload);
  assert.throws(() => decryptPayload(b.attempt, blob2));
});

test("tampered or malformed blobs throw without leaking the token", async () => {
  const { attempt, pub, nonce } = newAttempt("ada", 0);
  const blob = await encryptForInstance(pub, nonce, payload);
  const [p, iv, ct] = blob.split(".");
  const buf = Buffer.from(ct, "base64url");
  buf[0] ^= 1;
  for (const bad of [`${p}.${iv}.${buf.toString("base64url")}`, "garbage", `${p}.${iv}`]) {
    assert.throws(() => decryptPayload(attempt, bad), (e: Error) => !e.message.includes("tok-secret"));
  }
});

test("a decrypted payload with a bad shape is refused", async () => {
  const { attempt, pub, nonce } = newAttempt("ada", 0);
  for (const bad of [{ ...payload, access_token: "" }, { ...payload, expires_in: 0 }, { ...payload, expires_in: "1" }]) {
    const blob = await encryptForInstance(pub, nonce, bad as never);
    assert.throws(() => decryptPayload(attempt, blob));
  }
});

test("take is single-use, expires, and wrong-person does not consume", () => {
  const s = new PendingAttempts();
  const { attempt } = newAttempt("ada", 1000);
  s.add(attempt);
  assert.equal(s.take(attempt.nonce, "bob", 2000), "wrong-person");
  assert.equal(s.take(attempt.nonce, "ada", 2000), attempt);
  assert.equal(s.take(attempt.nonce, "ada", 2000), "unknown");
  const e = newAttempt("ada", 0).attempt;
  s.add(e);
  assert.equal(s.take(e.nonce, "ada", CONNECT_TTL_MS + 1), "expired");
  assert.equal(s.take(e.nonce, "ada", 1), "unknown");
});

test("sweep drops expired entries and the map is capped", () => {
  const s = new PendingAttempts();
  const old = newAttempt("ada", 0).attempt;
  s.add(old);
  s.sweep(CONNECT_TTL_MS + 1);
  assert.equal(s.size, 0);
  const first = newAttempt("ada", 0).attempt;
  s.add(first);
  for (let i = 0; i < 100; i++) s.add(newAttempt("ada", 0).attempt);
  assert.equal(s.size, 100);
  assert.equal(s.take(first.nonce, "ada", 1), "unknown");
});
