import assert from "node:assert/strict";
import test from "node:test";
import { MAXIMS, PUMP_LINES, PUMP_LINE_MS, pumpLine, gabuzomeu, pickMaxim, mascotSay } from "../public/shadok-soul.js";

test("gabuzomeu counts in base 4 with the Shadok digits", () => {
  assert.equal(gabuzomeu(0), "GA");
  assert.equal(gabuzomeu(1), "BU");
  assert.equal(gabuzomeu(3), "MEU");
  assert.equal(gabuzomeu(4), "BU GA");
  assert.equal(gabuzomeu(11), "ZO MEU");
  assert.equal(gabuzomeu(16), "BU GA GA");
});

test("gabuzomeu never throws on junk: negatives, fractions and NaN floor to a count", () => {
  assert.equal(gabuzomeu(-3), "GA");
  assert.equal(gabuzomeu(5.9), "BU BU");
  assert.equal(gabuzomeu(Number.NaN), "GA");
});

test("a turn opens on the classic line, then rotates and wraps", () => {
  assert.equal(pumpLine(0), "Shadok is pumping");
  assert.equal(pumpLine(PUMP_LINE_MS - 1), "Shadok is pumping");
  assert.equal(pumpLine(PUMP_LINE_MS), PUMP_LINES[1]);
  assert.equal(pumpLine(PUMP_LINE_MS * PUMP_LINES.length), PUMP_LINES[0]);
  assert.equal(pumpLine(-500), PUMP_LINES[0]);
});

test("pickMaxim never repeats the previous maxim, even at the edges of rand", () => {
  for (const r of [0, 0.5, 0.999999]) {
    for (const prev of MAXIMS) assert.notEqual(pickMaxim(() => r, prev), prev);
  }
});

test("mascotSay counts the agents only on its one-in-five draw, and only if there are any", () => {
  assert.match(mascotSay(11, () => 0.1), /^ZO MEU agents pumping\. That's 11/);
  assert.equal(mascotSay(1, () => 0.1).startsWith("BU agent pumping"), true);
  assert.ok(MAXIMS.includes(mascotSay(11, () => 0.5)));
  assert.ok(MAXIMS.includes(mascotSay(0, () => 0.1)));
});
