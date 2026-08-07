import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WINDOW,
  LONG_WINDOW,
  contextPct,
  contextTokens,
  effectiveWindow,
  pctFromUsage,
  windowForModel,
} from "../src/context.js";

/** The usage record of a real assistant message, copied from a live transcript. */
const REAL = { input: 1, output: 588, cacheCreation: 4_672, cacheRead: 404_568 };

test("the formula matches what the CLI itself reports", () => {
  // Ground truth: this exact message showed as "ctx:41%" in the TUI footer, on a
  // session running the 1M window. If this ever drifts, the gauge is lying.
  assert.equal(contextTokens(REAL), 409_241);
  assert.equal(contextPct(contextTokens(REAL), LONG_WINDOW), 41);
});

test("cache reads count, output does not", () => {
  // Cache is a billing/latency optimisation, not a smaller prompt: those tokens
  // occupy the window. Output does not — the next request does not start from it.
  assert.equal(contextTokens({ input: 10, output: 999, cacheCreation: 20, cacheRead: 30 }), 60);
});

test("the window comes from the [1m] SETTING, never from the model name", () => {
  // The suffix is a per-session setting ("opus[1m]"); the transcript records the
  // resolved name with it stripped, so matching on names would be wrong — the
  // same model runs at either size.
  assert.equal(windowForModel("opus[1m]"), LONG_WINDOW);
  assert.equal(windowForModel("claude-opus-4-8[1M]"), LONG_WINDOW);
  assert.equal(windowForModel("opus"), DEFAULT_WINDOW);
  assert.equal(windowForModel("claude-opus-4-8"), DEFAULT_WINDOW);
  assert.equal(windowForModel(null), DEFAULT_WINDOW);
  assert.equal(windowForModel(""), DEFAULT_WINDOW);
});

test("an over-run PROVES the assumed window wrong and promotes it", () => {
  // 409k tokens cannot fit in 200k. This is what rescues an unconfigured
  // container: no model setting, yet no nonsensical 205%.
  assert.equal(effectiveWindow(DEFAULT_WINDOW, 409_241), LONG_WINDOW);
  assert.equal(pctFromUsage(REAL, DEFAULT_WINDOW), 41);
});

test("a window that already fits is left alone", () => {
  assert.equal(effectiveWindow(DEFAULT_WINDOW, 50_000), DEFAULT_WINDOW);
  assert.equal(pctFromUsage({ input: 50_000, output: 0, cacheCreation: 0, cacheRead: 0 }, DEFAULT_WINDOW), 25);
});

test("beyond even the largest known window, the truth is shown", () => {
  // Not clamped to 100: promotion has already had its chance, so anything above
  // means the transcript exceeds every size we know. Flattening it would hide a
  // real anomaly behind a reassuring full bar.
  assert.equal(contextPct(2_000_000, LONG_WINDOW), 200);
  assert.equal(effectiveWindow(LONG_WINDOW, 2_000_000), 2_000_000);
});

test("no usage yet means no figure — not a zero", () => {
  // A session that has never answered must show no bar, not an empty one: "0%"
  // would claim a measurement nobody made.
  assert.equal(pctFromUsage(undefined, DEFAULT_WINDOW), null);
});

test("percentages are rounded and never negative", () => {
  assert.equal(contextPct(1, DEFAULT_WINDOW), 0);
  assert.equal(contextPct(1_999, DEFAULT_WINDOW), 1);
  assert.equal(contextPct(-5, DEFAULT_WINDOW), 0);
  assert.equal(contextPct(100, 0), 0); // a nonsense window yields 0, never NaN/∞
});
