import assert from "node:assert/strict";
import test from "node:test";
import { getUsage, parseWindow, pickUsage, hasWindow, type Usage } from "../src/usage.js";

const win = (pct: number) => ({ usedPercentage: pct, resetsAt: null });
const snap = (five: number | null, seven: number | null): Usage => ({
  fiveHour: five === null ? null : win(five),
  sevenDay: seven === null ? null : win(seven),
  fetchedAt: 123,
});

test("hasWindow: a snapshot counts only if it carries a window", () => {
  assert.equal(hasWindow(null), false);
  assert.equal(hasWindow(snap(null, null)), false); // 200-but-empty (a setup-token) is NOT useful
  assert.equal(hasWindow(snap(null, 45)), true);
  assert.equal(hasWindow(snap(3, null)), true);
});

test("pickUsage: the first token that reports a window wins; the rest are not fetched", async () => {
  const fetched: string[] = [];
  const fetchOne = async (t: string) => {
    fetched.push(t);
    return t === "vault" ? snap(null, 45) : snap(10, 10);
  };
  const r = await pickUsage(["vault", "env"], fetchOne, null);
  assert.deepEqual(r, snap(null, 45));
  assert.deepEqual(fetched, ["vault"]); // short-circuits — the env token is never tried
});

test("pickUsage: a 200-but-empty primary (setup-token) falls through to the next candidate", async () => {
  const fetchOne = async (t: string) => (t === "vault" ? snap(null, null) : snap(null, 45));
  const r = await pickUsage(["vault", "env"], fetchOne, null);
  assert.deepEqual(r, snap(null, 45)); // the env token keeps a number on screen
});

test("pickUsage: all candidates empty → the empty answer (not the stale cache)", async () => {
  const stale = snap(99, 99);
  const r = await pickUsage(["a", "b"], async () => snap(null, null), stale);
  assert.deepEqual(r, snap(null, null));
});

test("pickUsage: every candidate errors → keep the last good snapshot", async () => {
  const stale = snap(99, 99);
  const r = await pickUsage(["a", "b"], async () => null, stale);
  assert.equal(r, stale);
});

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
    assert.equal(await getUsage(() => []), null);
    const u = await getUsage(() => ["tok"]);
    assert.equal(fetches, 1, "the second call must reach the network");
    assert.ok(u);
    assert.equal(u!.fiveHour?.usedPercentage, 3);
    assert.equal(u!.sevenDay?.usedPercentage, 30);
  } finally {
    globalThis.fetch = realFetch;
  }
});
