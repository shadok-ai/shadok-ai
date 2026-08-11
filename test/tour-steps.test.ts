import assert from "node:assert/strict";
import test from "node:test";
import { TOUR_STEPS, bubblePlacement, unionRect, visibleSteps } from "../public/tour-steps.js";

const VIEW = { width: 1280, height: 900 };
const BUBBLE = { width: 340, height: 160 };

test("the welcome step has no target, every other step has one", () => {
  // The welcome step is the centred card; it must never be filtered out, which
  // is what a null target buys.
  assert.equal(TOUR_STEPS[0].target, null);
  assert.ok(TOUR_STEPS.slice(1).every((s) => s.target !== null));
  assert.ok(TOUR_STEPS.every((s) => s.id && s.title && s.body));
});

test("a step whose target is absent is dropped, never faked", () => {
  // THE rule of the feature: on a phone there is no agents column, on an empty
  // cockpit there is no active tab. A spotlight on empty space is worse than
  // no tour at all.
  const steps = [
    { id: "a", title: "A", body: "…", target: null },
    { id: "b", title: "B", body: "…", target: "#gone" },
    { id: "c", title: "C", body: "…", target: "#here" },
  ];
  const kept = visibleSteps(steps, (t) => t === "#here");
  assert.deepEqual(
    kept.map((s) => s.id),
    ["a", "c"],
  );
});

test("visibleSteps asks about an array target as a whole", () => {
  // The two dials are separate siblings; the step is kept when the group is.
  const steps = [{ id: "d", title: "D", body: "…", target: ["#x", "#y"] }];
  assert.equal(visibleSteps(steps, (t) => Array.isArray(t)).length, 1);
  assert.equal(visibleSteps(steps, () => false).length, 0);
});

test("unionRect encloses adjacent rects", () => {
  const a = { top: 10, left: 100, width: 40, height: 30 };
  const b = { top: 14, left: 150, width: 40, height: 30 };
  assert.deepEqual(unionRect([a, b]), { top: 10, left: 100, width: 90, height: 34 });
});

test("unionRect: one rect passes through, none yields null", () => {
  const a = { top: 1, left: 2, width: 3, height: 4 };
  assert.deepEqual(unionRect([a]), a);
  // null, not {0,0,0,0}: the caller must skip the step rather than frame the
  // top-left corner of the page.
  assert.equal(unionRect([]), null);
});

test("the bubble sits below the target and is centred on it", () => {
  const target = { top: 100, left: 500, width: 100, height: 40 };
  const p = bubblePlacement({ target, bubble: BUBBLE, viewport: VIEW, gap: 12 });
  assert.equal(p.side, "below");
  assert.equal(p.top, 152); // 100 + 40 + 12
  assert.equal(p.left, 380); // 500 + 50 - 170
});

test("a target near the bottom flips the bubble above it", () => {
  const target = { top: 820, left: 500, width: 100, height: 40 };
  const p = bubblePlacement({ target, bubble: BUBBLE, viewport: VIEW, gap: 12 });
  assert.equal(p.side, "above");
  assert.equal(p.top, 648); // 820 - 160 - 12
});

test("the bubble is clamped inside the viewport on both edges", () => {
  const left = bubblePlacement({
    target: { top: 100, left: 0, width: 40, height: 40 },
    bubble: BUBBLE,
    viewport: VIEW,
    gap: 12,
  });
  assert.equal(left.left, 12);
  const right = bubblePlacement({
    target: { top: 100, left: 1240, width: 40, height: 40 },
    bubble: BUBBLE,
    viewport: VIEW,
    gap: 12,
  });
  assert.equal(right.left, 928); // 1280 - 340 - 12
});

test("a bubble taller than the viewport still lands on screen", () => {
  // A phone in landscape with a big step: clamping must not produce a negative
  // top, which would put the text above the fold with no way to scroll to it.
  const p = bubblePlacement({
    target: { top: 10, left: 10, width: 40, height: 40 },
    bubble: { width: 340, height: 2000 },
    viewport: { width: 390, height: 400 },
    gap: 12,
  });
  assert.equal(p.top, 12);
  assert.equal(p.left, 12);
});
