import assert from "node:assert/strict";
import test from "node:test";
import { AttemptLimiter, loginKeys } from "../src/login-limit.js";
import { burnPasswordCheck, hashPasswordAsync, verifyPassword, verifyPasswordAsync } from "../src/accounts.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("loginKeys: one per address, one per account (blank = admin)", () => {
  assert.deepEqual(loginKeys("1.2.3.4", ""), ["ip:1.2.3.4", "acct:admin"]);
  assert.deepEqual(loginKeys("1.2.3.4", "Ada"), ["ip:1.2.3.4", "acct:Ada"]);
});

test("an address is blocked after its failures, then released when the window rolls", () => {
  const c = clock();
  const l = new AttemptLimiter({ windowMs: 15 * 60_000, maxPerIp: 3, maxPerAccount: 100 }, c.now);
  for (let i = 0; i < 3; i++) {
    assert.equal(l.check(loginKeys("1.1.1.1", "u" + i)).ok, true);
    l.fail(loginKeys("1.1.1.1", "u" + i));
  }
  const v = l.check(loginKeys("1.1.1.1", "zz"));
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.retryAfterMs > 0 && v.retryAfterMs <= 15 * 60_000);
  // another address is unaffected
  assert.equal(l.check(loginKeys("2.2.2.2", "zz")).ok, true);
  c.advance(15 * 60_000 + 1);
  assert.equal(l.check(loginKeys("1.1.1.1", "zz")).ok, true);
});

// A distributed guesser rotates addresses; the account bucket still caps it.
test("an account is blocked after failures from many addresses", () => {
  const c = clock();
  const l = new AttemptLimiter({ windowMs: 60_000, maxPerIp: 100, maxPerAccount: 4 }, c.now);
  for (let i = 0; i < 4; i++) l.fail(loginKeys(`10.0.0.${i}`, "admin"));
  assert.equal(l.check(loginKeys("10.9.9.9", "")).ok, false);
  assert.equal(l.check(loginKeys("10.9.9.9", "bob")).ok, true);
});

test("a success clears the account's failures", () => {
  const l = new AttemptLimiter({ windowMs: 60_000, maxPerIp: 100, maxPerAccount: 2 }, clock().now);
  l.fail(loginKeys("a", "bob"));
  l.succeed(loginKeys("a", "bob"));
  l.fail(loginKeys("a", "bob"));
  assert.equal(l.check(loginKeys("a", "bob")).ok, true);
});

test("memory stays bounded however many names a guesser invents", () => {
  const l = new AttemptLimiter({ windowMs: 60_000, maxPerIp: 1e9, maxPerAccount: 5, maxKeys: 50 }, clock().now);
  for (let i = 0; i < 1000; i++) l.fail(loginKeys("a", "n" + i));
  assert.ok(l.size() <= 50);
});

// ── The hash itself: off the event loop, same cost for an unknown account ──

test("async scrypt verifies what the sync hash wrote, and the reverse", async () => {
  const h = await hashPasswordAsync("correct horse");
  assert.equal(await verifyPasswordAsync("correct horse", h), true);
  assert.equal(await verifyPasswordAsync("wrong", h), false);
  assert.equal(verifyPassword("correct horse", h), true);
  assert.equal(await verifyPasswordAsync("x", "garbage"), false);
});

test("an unknown account still pays a full scrypt (no timing oracle)", async () => {
  const h = await hashPasswordAsync("pw");
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) await verifyPasswordAsync("nope", h);
  const real = Number(process.hrtime.bigint() - t0);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) assert.equal(await burnPasswordCheck("nope"), false);
  const dummy = Number(process.hrtime.bigint() - t1);
  // Same derivation, same parameters: within a wide factor, never ~free.
  assert.ok(dummy > real / 4, `dummy ${dummy} vs real ${real}`);
});

test("verification does not block the event loop", async () => {
  const h = await hashPasswordAsync("pw");
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  await Promise.all(Array.from({ length: 8 }, () => verifyPasswordAsync("x", h)));
  clearInterval(iv);
  assert.ok(ticks > 0, "the timer never ran while 8 hashes were computed");
});
