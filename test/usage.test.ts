import assert from "node:assert/strict";
import test from "node:test";
import { parseWindow } from "../src/usage.js";

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
