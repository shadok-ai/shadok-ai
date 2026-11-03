import assert from "node:assert/strict";
import test from "node:test";
import { fmtExpiry, expiryWarning, accountExpiryLine, EXPIRY_WARN_MS } from "../public/auth-expiry.js";

const NOW = 1_800_000_000_000; // a fixed "now" so the clock is deterministic
const h = (n: number) => n * 3600_000;
const d = (n: number) => n * 86_400_000;

test("fmtExpiry: days / hours / minutes / expired", () => {
  assert.equal(fmtExpiry(NOW + d(22), NOW), "in 22 days");
  assert.equal(fmtExpiry(NOW + h(6), NOW), "in 6 h");
  assert.equal(fmtExpiry(NOW + 40 * 60_000, NOW), "in 40 min");
  assert.equal(fmtExpiry(NOW - 1, NOW), "expired");
  assert.equal(fmtExpiry(NOW, NOW), "expired"); // exactly now counts as expired
});

test("expiryWarning: a healthy signed-in session well inside its window → no nag", () => {
  const auth = { state: "signed-in", loggedIn: true, tokenExpiresAt: NOW + d(22) };
  assert.equal(expiryWarning(auth, NOW), null);
});

test("expiryWarning: within the window → nags, carrying the countdown wording", () => {
  const auth = { state: "signed-in", loggedIn: true, tokenExpiresAt: NOW + h(18) };
  const w = expiryWarning(auth, NOW);
  assert.ok(w);
  assert.equal(w!.expired, false);
  assert.ok(w!.remainingMs > 0 && w!.remainingMs < EXPIRY_WARN_MS);
  assert.match(w!.text, /in 18 h/);
  assert.match(w!.text, /re-login/i);
});

test("expiryWarning: the window is 48h — 36h out nags, 50h out stays quiet", () => {
  assert.equal(EXPIRY_WARN_MS, d(2)); // the threshold IS two days
  const at = (hrs: number) => ({ state: "signed-in", loggedIn: true, tokenExpiresAt: NOW + h(hrs) });
  assert.ok(expiryWarning(at(36), NOW), "36h before the deadline must nag now");
  assert.equal(expiryWarning(at(50), NOW), null, "50h out is still outside the window");
});

test("expiryWarning: exactly at the 48h threshold does not nag yet (strictly inside)", () => {
  const auth = { state: "signed-in", loggedIn: true, tokenExpiresAt: NOW + EXPIRY_WARN_MS };
  assert.equal(expiryWarning(auth, NOW), null);
  // One millisecond closer and it does.
  assert.ok(expiryWarning({ ...auth, tokenExpiresAt: NOW + EXPIRY_WARN_MS - 1 }, NOW));
});

test("expiryWarning: already past the deadline still nags, flagged expired", () => {
  const auth = { state: "signed-in", loggedIn: true, tokenExpiresAt: NOW - h(1) };
  const w = expiryWarning(auth, NOW);
  assert.ok(w);
  assert.equal(w!.expired, true);
  assert.match(w!.text, /has expired/i);
});

test("expiryWarning: a failed probe (unknown) never nags — it is not 'signed out'", () => {
  assert.equal(expiryWarning({ state: "unknown", tokenExpiresAt: NOW + h(1) }, NOW), null);
});

test("expiryWarning: a signed-out account is the sign-in card's job, not the banner's", () => {
  assert.equal(expiryWarning({ state: "signed-out", tokenExpiresAt: NOW + h(1) }, NOW), null);
  assert.equal(expiryWarning({ loggedIn: false, tokenExpiresAt: NOW + h(1) }, NOW), null);
});

test("expiryWarning: no numeric deadline (env token, or missing) → nothing to warn about", () => {
  assert.equal(expiryWarning({ state: "signed-in", loggedIn: true }, NOW), null);
  assert.equal(expiryWarning({ state: "signed-in", tokenExpiresAt: "soon" as unknown as number }, NOW), null);
  assert.equal(expiryWarning(null, NOW), null);
});

test("longLived: never nags, even with an imminent tokenExpiresAt", () => {
  const auth = { state: "signed-in", loggedIn: true, tokenExpiresAt: NOW + h(1), longLived: true, longLivedExpiresAt: NOW + d(300) };
  assert.equal(expiryWarning(auth, NOW), null);
});

test("accountExpiryLine: longLived with a date → approximate wording", () => {
  const auth = { state: "signed-in", longLived: true, longLivedExpiresAt: Date.UTC(2027, 10, 3) };
  assert.equal(accountExpiryLine(auth, NOW), "Long-lived token — expires ≈ Nov 2027");
});

test("accountExpiryLine: longLived without a date → no fixed expiry", () => {
  const line = accountExpiryLine({ state: "signed-in", longLived: true, longLivedExpiresAt: null }, NOW);
  assert.match(line!, /^Long-lived token — no fixed expiry/);
  assert.match(line!, /claude setup-token/);
});

test("non-longLived: unchanged behaviour", () => {
  const auth = { state: "signed-in", loggedIn: true, tokenExpiresAt: NOW + h(10) };
  assert.equal(accountExpiryLine(auth, NOW), "in 10 h");
  assert.ok(expiryWarning(auth, NOW));
  assert.equal(accountExpiryLine({ state: "signed-in" }, NOW), null);
});
