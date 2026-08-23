import assert from "node:assert/strict";
import test from "node:test";
import { computePace, paceBlock, PACE_EPSILON, WINDOW_SEC } from "../src/pace.js";
import type { Usage, Window } from "../src/usage.js";

/** Frozen clock: tests must never depend on the real time. */
const NOW = 1_700_000_000_000;

/** A window whose reset falls in `remainingSec` seconds. */
const win = (usedPercentage: number, remainingSec: number): Window => ({
  usedPercentage,
  resetsAt: NOW / 1000 + remainingSec,
});

const usage = (fiveHour: Window | null, sevenDay: Window | null): Usage => ({
  fiveHour,
  sevenDay,
  fetchedAt: NOW,
});

const round = (n: number | null) => (n === null ? null : Math.round(n));

/** Expected ideal pace / ratio from first principles — derived from the same
 *  inputs AND from PACE_EPSILON, so these tests stay correct if epsilon is
 *  retuned. They still pin the clamps and the block boundary independently. */
const idealOf = (remainingSec: number, windowSec: number) =>
  Math.min(100, Math.max(0, ((windowSec - remainingSec) / windowSec) * 100));
const ratioOf = (used: number, remainingSec: number, windowSec: number) =>
  (used / (idealOf(remainingSec, windowSec) + PACE_EPSILON)) * 100;

test("5h: 90% used with 10 min left keeps the pace", () => {
  const p = computePace(win(90, 600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 97);
  assert.equal(round(p.ratioPct), round(ratioOf(90, 600, WINDOW_SEC.fiveHour)));
});

test("5h: 3% used 5 min after the reset does not trip the epsilon", () => {
  const p = computePace(win(3, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.equal(round(p.idealPacePct), 2);
  assert.equal(round(p.ratioPct), round(ratioOf(3, 17_700, WINDOW_SEC.fiveHour)));
});

test("5h: 15% used 5 min after the reset crosses the threshold", () => {
  const p = computePace(win(15, 17_700), WINDOW_SEC.fiveHour, NOW);
  assert.ok(p.ratioPct! > 100);
  assert.equal(round(p.ratioPct), round(ratioOf(15, 17_700, WINDOW_SEC.fiveHour)));
});

test("7d: 55% used with 6 days left overshoots by a lot", () => {
  const p = computePace(win(55, 6 * 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 14);
  assert.ok(p.ratioPct! > 100);
  assert.equal(round(p.ratioPct), round(ratioOf(55, 6 * 86_400, WINDOW_SEC.sevenDay)));
});

test("7d: 80% used with 1 day left keeps the pace", () => {
  const p = computePace(win(80, 86_400), WINDOW_SEC.sevenDay, NOW);
  assert.equal(round(p.idealPacePct), 86);
  assert.equal(round(p.ratioPct), round(ratioOf(80, 86_400, WINDOW_SEC.sevenDay)));
});

test("resetsAt absent : pas de rythme calculable", () => {
  const p = computePace({ usedPercentage: 99, resetsAt: null }, WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, null);
  assert.equal(p.ratioPct, null);
});

test("expired window: the ideal pace is clamped at 100%", () => {
  const p = computePace(win(50, -3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 100);
  assert.equal(round(p.ratioPct), round(ratioOf(50, -3_600, WINDOW_SEC.fiveHour)));
});

// Lower bound: a resetsAt further out than the window's length (clock drift)
// gives a negative elapsed time, clamped to 0. Without the clamp the
// denominator (0 + epsilon) would stay sane but idealPacePct would go negative.
test("resetsAt beyond the window's length: the ideal pace is clamped at 0%", () => {
  const p = computePace(win(50, WINDOW_SEC.fiveHour + 3_600), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 0);
  assert.equal(round(p.ratioPct), round((50 / PACE_EPSILON) * 100)); // ideal=0
});

// Exact boundary of the single threshold (BLOCK_RATIO = 100), set by
// arithmetic. Mid-window idealPacePct = 50 (exact in binary). ratio = 100 ⟺
// used = 50 + PACE_EPSILON. Right on the limit does not block; one notch above
// bloque.
const MID = WINDOW_SEC.fiveHour / 2;
const BOUNDARY_USED = 50 + PACE_EPSILON; // ratio exactement 100

test("computePace: used = ideal + epsilon mid-window gives a ratio of exactly 100", () => {
  const p = computePace(win(BOUNDARY_USED, MID), WINDOW_SEC.fiveHour, NOW);
  assert.equal(p.idealPacePct, 50);
  assert.equal(p.ratioPct, 100); // strict equality, no rounding
});

test("paceBlock : un ratio de 100 pile ne bloque pas", () => {
  const v = paceBlock(usage(win(BOUNDARY_USED, MID), null), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock: just above 100 blocks", () => {
  const w = win(BOUNDARY_USED + 1, MID);
  assert.ok(computePace(w, WINDOW_SEC.fiveHour, NOW).ratioPct! > 100);
  const v = paceBlock(usage(w, null), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^5h:/);
});

test("paceBlock: a single window above the threshold is enough", () => {
  const v = paceBlock(usage(win(90, 600), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  assert.match(v.reason ?? "", /^7d:/);
});

test("paceBlock: both within bounds does not block", () => {
  const v = paceBlock(usage(win(90, 600), win(80, 86_400)), NOW);
  assert.equal(v.blocked, false);
  assert.equal(v.reason, null);
});

test("paceBlock: the reason names the window with the highest ratio", () => {
  // 7d at 55%/6d stays well above 5h at 15%/5min whatever epsilon is.
  const v = paceBlock(usage(win(15, 17_700), win(55, 6 * 86_400)), NOW);
  assert.equal(v.blocked, true);
  const r5 = ratioOf(15, 17_700, WINDOW_SEC.fiveHour);
  const r7 = ratioOf(55, 6 * 86_400, WINDOW_SEC.sevenDay);
  assert.match(v.reason ?? "", r7 > r5 ? /^7d:/ : /^5h:/);
});

test("paceBlock: the reason carries all three figures (used, ideal, ratio)", () => {
  const v = paceBlock(usage(null, win(55, 6 * 86_400)), NOW);
  const ideal = round(idealOf(6 * 86_400, WINDOW_SEC.sevenDay));
  const ratio = round(ratioOf(55, 6 * 86_400, WINDOW_SEC.sevenDay));
  assert.equal(v.reason, `7d: 55% used vs ${ideal}% ideal pace (${ratio}% of pace)`);
});

test("paceBlock: missing usage never blocks", () => {
  assert.deepEqual(paceBlock(null, NOW), { blocked: false, reason: null });
});

test("paceBlock: a missing resetsAt never blocks", () => {
  const v = paceBlock(usage(null, { usedPercentage: 99, resetsAt: null }), NOW);
  assert.equal(v.blocked, false);
});
