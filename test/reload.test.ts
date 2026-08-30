import assert from "node:assert/strict";
import test from "node:test";
import { deliverWithRetry } from "../src/reload.js";

const instant = () => Promise.resolve();

test("deliverWithRetry: a delivery refused as busy, then accepted, lands", async () => {
  // The reload nudge's real failure: the resumed session is briefly BUSY, so the
  // first attempts are refused, then it goes idle and the nudge lands.
  let n = 0;
  const res = await deliverWithRetry(
    () => Promise.resolve(++n < 3 ? { ok: false, reason: "busy" } : { ok: true }),
    () => true,
    { delayMs: 1, sleep: instant },
  );
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3); // two busy refusals, delivered on the third
});

test("deliverWithRetry: succeeds on the FIRST try with no wasted attempts", async () => {
  let n = 0;
  const res = await deliverWithRetry(() => Promise.resolve((n++, { ok: true })), () => true, {
    delayMs: 1,
    sleep: instant,
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(n, 1);
});

test("deliverWithRetry: gives up after `attempts`, keeping the last reason", async () => {
  let n = 0;
  const res = await deliverWithRetry(
    () => Promise.resolve((n++, { ok: false, reason: "ws-error" })),
    () => true,
    { attempts: 4, delayMs: 1, sleep: instant },
  );
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 4);
  assert.equal(res.reason, "ws-error");
  assert.equal(n, 4);
});

test("deliverWithRetry: a session that ended stops the retries at once", async () => {
  let delivered = false;
  const res = await deliverWithRetry(
    () => { delivered = true; return Promise.resolve({ ok: true }); },
    () => false, // gone
    { delayMs: 1, sleep: instant },
  );
  assert.equal(res.ok, false);
  assert.equal(res.gone, true);
  assert.equal(res.attempts, 0);
  assert.equal(delivered, false); // never even tried to deliver into a dead session
});

test("deliverWithRetry: stops knocking once the session disappears mid-retry", async () => {
  let n = 0;
  const res = await deliverWithRetry(
    () => Promise.resolve((n++, { ok: false, reason: "busy" })),
    () => n < 1, // alive only before the first delivery; gone by the next check
    { attempts: 6, delayMs: 1, sleep: instant },
  );
  assert.equal(res.gone, true);
  assert.equal(n, 1); // one delivery attempt, then it noticed the session was gone
});

test("a non-transient refusal is NOT replayed — a timeout means the turn is still running", () => {
  // Invariant 15, applied here: `timeout` does not mean nothing was delivered,
  // it means the turn the delivery started has not finished. Sending again
  // stacks a second prompt on the first — the doubled-prompt shape #189 fixed
  // from the other end. Only refusals that delivered NOTHING may be replayed.
  return (async () => {
    let calls = 0;
    const res = await deliverWithRetry(
      async () => ({ ok: false, reason: (calls++, "timeout") }),
      () => true,
      { attempts: 5, delayMs: 0 },
    );
    assert.equal(calls, 1, "a timeout must be attempted exactly once");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "timeout");
  })();
});

test("a transient refusal still retries, then succeeds", () => {
  return (async () => {
    let calls = 0;
    const res = await deliverWithRetry(
      async () => (++calls < 3 ? { ok: false, reason: "busy" } : { ok: true }),
      () => true,
      { attempts: 5, delayMs: 0 },
    );
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 3);
  })();
});
