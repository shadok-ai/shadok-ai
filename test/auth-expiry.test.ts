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
  const auth = { state: "signed-in", longLived: true, longLivedExpiresAt: new Date(2027, 10, 15).getTime() };
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

// ── The optional usage-gauge login (`gauge` in the /auth payload) ───────────
import { gaugeWarning, gaugeLine, GAUGE_WARN_MS } from "../public/auth-expiry.js";

test("gaugeWarning: silent unless a gauge login is near or past its wall", () => {
  const now = 1_000_000_000_000;
  const g = (state: string, refreshExpiresAt: number | null, extra = {}) => ({ supported: true, state, refreshExpiresAt, ...extra });
  assert.equal(gaugeWarning(null, now), null);
  assert.equal(gaugeWarning(undefined, now), null);
  assert.equal(gaugeWarning(g("none", null), now), null, "never set up → never nagged");
  assert.equal(gaugeWarning(g("ok", now + 20 * 86400_000), now), null);
  assert.equal(gaugeWarning(g("expiring", now + 20 * 86400_000, { supported: false }), now), null, "unsupported platform");
  const near = gaugeWarning(g("expiring", now + GAUGE_WARN_MS - 1000), now);
  assert.equal(near?.expired, false);
  assert.match(near!.text, /usage gauge login expires in \d+ days/);
  const past = gaugeWarning(g("expired", now - 1000), now);
  assert.equal(past?.expired, true);
  assert.match(past!.text, /expired/);
});

test("gaugeLine: hidden when unsupported, honest about each state", () => {
  const now = 1_000_000_000_000;
  assert.equal(gaugeLine(null, now), null);
  assert.equal(gaugeLine({ supported: false, state: "ok" }, now), null);
  assert.equal(gaugeLine({ supported: true, state: "none" }, now), "not set up");
  assert.match(gaugeLine({ supported: true, state: "wrong-scope" }, now)!, /sign in again/);
  assert.equal(
    gaugeLine({ supported: true, state: "ok", email: "a@b.c", refreshExpiresAt: now + 20 * 86400_000 }, now),
    "a@b.c · sign-in lasts in 20 days",
  );
  assert.match(gaugeLine({ supported: true, state: "ok", email: "a@b.c", lastRefresh: { ok: false } }, now)!, /refresh failing/);
});
