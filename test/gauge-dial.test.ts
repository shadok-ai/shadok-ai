import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAL,
  SWEEP_DEG,
  arcSegments,
  dialAngle,
  dialColor,
  dialPoint,
  dialPos,
  dialTitle,
} from "../public/gauge-dial.js";

test("on the ideal pace puts the needle straight up", () => {
  assert.equal(dialAngle(30, 30), 0);
  assert.equal(dialAngle(70, 70), 0);
});

test("nothing consumed pins the needle hard left", () => {
  assert.equal(dialAngle(0, 40), -SWEEP_DEG);
});

test("quota exhausted pins the needle hard right", () => {
  assert.equal(dialAngle(100, 50), SWEEP_DEG);
});

test("halfway to the ideal pace is halfway up the left side", () => {
  assert.equal(dialAngle(20, 40), -SWEEP_DEG / 2);
});

test("halfway from the pace to exhaustion is halfway down the right side", () => {
  // pace 50 → the right half maps used 50…100, so 75 % is its midpoint.
  assert.equal(dialAngle(75, 50), SWEEP_DEG / 2);
});

test("a just-reset window keeps a usable left half", () => {
  // Without the clamp the ideal pace is ~0, the left half collapses to a point
  // and the first token of the window would slam the needle to the centre.
  assert.ok(dialAngle(1, 0) < -SWEEP_DEG / 4, "1 % consumed must still read as under pace");
  assert.equal(dialAngle(0, 0), -SWEEP_DEG);
});

test("a window about to reset keeps a usable right half", () => {
  // Symmetric case: pace ~100 would collapse the right half.
  assert.ok(dialAngle(99, 100) < SWEEP_DEG, "99 % consumed must not read as exhausted");
  assert.equal(dialAngle(100, 100), SWEEP_DEG);
});

test("no ideal pace falls back to a plain linear dial", () => {
  assert.equal(dialAngle(0, null), -SWEEP_DEG);
  assert.equal(dialAngle(50, null), 0);
  assert.equal(dialAngle(100, null), SWEEP_DEG);
});

test("the angle never goes backwards as consumption grows, across the seam", () => {
  // The seam at used == pace joins two different scales; a non-monotonic join
  // would make the needle jump backwards as the quota is spent.
  let prev = -Infinity;
  for (let used = 0; used <= 100; used += 0.5) {
    const a = dialAngle(used, 40);
    assert.ok(a >= prev, `angle dropped at used=${used}: ${a} < ${prev}`);
    prev = a;
  }
});

test("consumption outside 0…100 is clamped, not extrapolated", () => {
  assert.equal(dialAngle(-5, 40), -SWEEP_DEG);
  assert.equal(dialAngle(140, 40), SWEEP_DEG);
});

test("the colour runs green → amber → red across the sweep", () => {
  assert.match(dialColor(-1), /--ok\) 100%/);
  // Both branches of dialColor emit "var(--amber), var(--<x>) <n>%" — pin the
  // literal 0% mix, not just the presence of "--amber", or this passes no
  // matter what dialColor(0) actually returns.
  assert.match(dialColor(0), /var\(--amber\), var\(--ok\) 0%/);
  assert.match(dialColor(1), /--err\) 100%/);
});

test("dialPoint places the sweep ends low-left and low-right, symmetrically", () => {
  const left = dialPoint(-SWEEP_DEG);
  const right = dialPoint(SWEEP_DEG);
  assert.ok(left.x < DIAL.cx && right.x > DIAL.cx);
  assert.equal(left.y, right.y);
  assert.ok(left.y > DIAL.cy, "the sweep ends sit BELOW the hub — that is the 240° opening");
  assert.equal(dialPoint(0).y, DIAL.cy - DIAL.r);
});

test("every arc segment stays inside the viewBox", () => {
  // A segment escaping the box is clipped and the dial loses a chunk in silence.
  // The path is "M x1 y1 A r r 0 0 1 x2 y2": pull out just the two endpoints
  // (not the arc's radius/flags, which are not coordinates at all) and bound x
  // by DIAL.w and y by DIAL.h separately — the sweep ends are the lowest
  // points of the arc, so the *bottom* (DIAL.h) is the direction a segment
  // would actually escape, not the wider DIAL.w.
  const endpoint = /^M (-?[\d.]+) (-?[\d.]+) A [\d.]+ [\d.]+ 0 0 1 (-?[\d.]+) (-?[\d.]+)$/;
  for (const { d } of arcSegments()) {
    const m = endpoint.exec(d);
    assert.ok(m, `unexpected path shape: ${d}`);
    const [x1, y1, x2, y2] = m!.slice(1).map(Number);
    for (const x of [x1, x2]) {
      assert.ok(x >= -1 && x <= DIAL.w, `x out of the viewBox: ${x} in ${d}`);
    }
    for (const y of [y1, y2]) {
      assert.ok(y >= -1 && y <= DIAL.h, `y out of the viewBox: ${y} in ${d}`);
    }
  }
});

test("the arc is built from n coloured segments, first green and last red", () => {
  const segs = arcSegments(24);
  assert.equal(segs.length, 24);
  assert.match(segs[0].d, /^M /);
  assert.match(segs[0].color, /--ok/);
  assert.match(segs[23].color, /--err/);
});

test("the tooltip states whether consumption is ahead of, behind, or on pace", () => {
  const over = dialTitle("5h", { usedPercentage: 60, idealPacePct: 30, ratioPct: 188 }, "resets in 2h");
  assert.match(over, /^5h rolling limit\n/);
  assert.match(over, /60% consumed/);
  assert.match(over, /ideal pace 30%/);
  assert.match(over, /188% of pace/);
  assert.match(over, /faster than the clock/);
  assert.match(over, /resets in 2h$/);

  const under = dialTitle("7d", { usedPercentage: 10, idealPacePct: 40, ratioPct: 24 }, "");
  assert.match(under, /slower than the clock/);
  assert.ok(!under.endsWith("\n"), "an empty reset must not leave a dangling line");
});

test("on pace near the end of a window says so, not 'burning faster'", () => {
  // pace 99, used 99: last minutes of a window, exactly on pace. `dialPos`
  // clamps the pace down to 98, so the NEEDLE reads +0.5 (right of centre) —
  // correct for the needle, but `side` used to be derived from that same
  // clamped position and printed "burning faster than the clock", which is
  // false: consumption (99) equals the real pace (99) exactly.
  const t = dialTitle("5h", { usedPercentage: 99, idealPacePct: 99, ratioPct: 100 }, "");
  assert.match(t, /Exactly on the ideal pace/);
  assert.doesNotMatch(t, /faster than the clock/);
});

test("burning at 3x the clock early in a window says so, not 'consuming slower'", () => {
  // pace 0.5, used 1.5: first minutes of a window, burning at 3x the clock.
  // `dialPos` clamps the pace up to 2, so the NEEDLE reads -0.25 (left of
  // centre) — correct for the needle, but `side` used to be derived from that
  // same clamped position and printed "consuming slower than the clock",
  // which is false: consumption (1.5) is 3x the real pace (0.5).
  const t = dialTitle("5h", { usedPercentage: 1.5, idealPacePct: 0.5, ratioPct: 60 }, "");
  assert.match(t, /Burning faster than the clock/);
  assert.doesNotMatch(t, /slower than the clock/);
});

test("the tooltip says so when there is no pace to compare against", () => {
  const t = dialTitle("5h", { usedPercentage: 12, idealPacePct: null, ratioPct: null }, "");
  assert.match(t, /12% consumed/);
  assert.match(t, /no reset time/i);
  assert.ok(!/of pace/.test(t), "without a pace we must not quote a ratio");
});

test("the tooltip degrades to 'no data' on an absent window", () => {
  assert.equal(dialTitle("7d", null, ""), "7d rolling limit\nno data");
});
