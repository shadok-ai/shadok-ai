import assert from "node:assert/strict";
import test from "node:test";
import {
  newPairing,
  normalizeCode,
  pairingRefusal,
  redeemPairing,
  PAIRING_DIGITS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
} from "../src/tg-pairing.js";

const T0 = 1_000_000;
const fixed = (code: string) => ({ code, expiresAt: T0 + PAIRING_TTL_MS, failures: 0 });

test("newPairing: 8 digits, expiring after the TTL, no failures yet", () => {
  const p = newPairing(T0);
  assert.match(p.code, new RegExp(`^\\d{${PAIRING_DIGITS}}$`));
  assert.equal(PAIRING_DIGITS, 8);
  assert.equal(p.expiresAt, T0 + PAIRING_TTL_MS);
  assert.equal(p.failures, 0);
});

test("newPairing: leading zeros survive (a code is a string, not a number)", () => {
  assert.equal(newPairing(T0, () => 0).code, "00000000");
});

test("redeemPairing: the right code pairs once, and is then spent", () => {
  const first = redeemPairing(fixed("12345678"), "12345678", T0);
  assert.equal(first.verdict, "ok");
  assert.equal(first.next, null);
  // Replaying the same code against what is left gets nothing.
  assert.equal(redeemPairing(first.next, "12345678", T0).verdict, "none");
});

test("redeemPairing: spaces and dashes are tolerated, as people copy codes", () => {
  assert.equal(redeemPairing(fixed("12345678"), "1234 5678", T0).verdict, "ok");
  assert.equal(redeemPairing(fixed("12345678"), "1234-5678", T0).verdict, "ok");
  assert.equal(normalizeCode(" 12 34-56 78 "), "12345678");
});

test("redeemPairing: no code issued → nothing pairs", () => {
  assert.equal(redeemPairing(null, "12345678", T0).verdict, "none");
});

test("redeemPairing: an expired code is refused and dropped, even if right", () => {
  const r = redeemPairing(fixed("12345678"), "12345678", T0 + PAIRING_TTL_MS);
  assert.equal(r.verdict, "expired");
  assert.equal(r.next, null);
});

test("redeemPairing: a wrong code counts a failure and keeps the code live", () => {
  const r = redeemPairing(fixed("12345678"), "87654321", T0);
  assert.equal(r.verdict, "invalid");
  assert.equal(r.next?.failures, 1);
  assert.equal(redeemPairing(r.next, "12345678", T0).verdict, "ok");
});

test("redeemPairing: too many wrong guesses cancel the code — the right one then fails too", () => {
  let state: ReturnType<typeof fixed> | null = fixed("12345678");
  let verdict = "";
  for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
    const r = redeemPairing(state, "00000000", T0);
    verdict = r.verdict;
    state = r.next;
  }
  assert.equal(verdict, "locked");
  assert.equal(state, null);
  assert.equal(redeemPairing(state, "12345678", T0).verdict, "none");
});

test("redeemPairing: a code of a different length is simply wrong, never a throw", () => {
  assert.equal(redeemPairing(fixed("12345678"), "123", T0).verdict, "invalid");
  assert.equal(redeemPairing(fixed("12345678"), "", T0).verdict, "invalid");
});

test("pairingRefusal: points to the cockpit, and never says how many tries are left", () => {
  for (const v of ["none", "expired", "locked", "invalid"] as const) {
    const msg = pairingRefusal(v);
    assert.ok(msg.length > 0);
    assert.doesNotMatch(msg, /\d+ (tries|attempts)/i);
  }
  assert.match(pairingRefusal("none"), /Pair Telegram/);
});
