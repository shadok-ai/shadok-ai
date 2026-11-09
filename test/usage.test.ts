import assert from "node:assert/strict";
import test from "node:test";
import { getUsage, parseWindow } from "../src/usage.js";

test("parseWindow reads `utilization` (the real endpoint shape) + ISO resets_at", () => {
  const w = parseWindow({ utilization: 42, resets_at: "2026-07-24T13:59:59.893779+00:00" });
  assert.ok(w);
  assert.equal(w!.usedPercentage, 42);
  assert.equal(w!.resetsAt, Math.floor(Date.parse("2026-07-24T13:59:59.893779+00:00") / 1000));
});

test("parseWindow falls back to `used_percentage` + epoch resets_at (statusline shape)", () => {
  const w = parseWindow({ used_percentage: 7, resets_at: 1784516400 });
  assert.deepEqual(w, { usedPercentage: 7, resetsAt: 1784516400 });
});

test("parseWindow: missing/invalid inputs → null", () => {
  assert.equal(parseWindow(null), null);
  assert.equal(parseWindow(undefined), null);
  assert.equal(parseWindow({}), null);
  assert.equal(parseWindow({ resets_at: "2026-07-24T00:00:00Z" }), null); // no percentage
});

test("parseWindow: percentage present but no reset → resetsAt null (no pace, but shown)", () => {
  assert.deepEqual(parseWindow({ utilization: 50 }), { usedPercentage: 50, resetsAt: null });
});

test("getUsage: a token-less read does not latch the in-flight guard", async () => {
  // Regression: the token-less path settled the async IIFE synchronously, so
  // its `finally { inflight = null }` ran BEFORE `inflight = (...)()` assigned
  // the already-resolved null promise — every later call returned it forever.
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(
      JSON.stringify({
        five_hour: { utilization: 3, resets_at: "2026-10-21T12:00:00Z" },
        seven_day: { utilization: 30, resets_at: "2026-10-25T00:00:00Z" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    assert.equal(await getUsage(() => null), null);
    const u = await getUsage(() => "tok");
    assert.equal(fetches, 1, "the second call must reach the network");
    assert.ok(u);
    assert.equal(u!.fiveHour?.usedPercentage, 3);
    assert.equal(u!.sevenDay?.usedPercentage, 30);
  } finally {
    globalThis.fetch = realFetch;
  }
});
