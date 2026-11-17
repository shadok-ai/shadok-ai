import assert from "node:assert/strict";
import test from "node:test";
import { shrinkToFit, nameReads, chanOverflowIds, chanOverflowItems } from "../public/bar-overflow.js";

/** A fake row: `room` px for the icons, each icon `w` px wide. */
function row(room: number, w: number, items: string[]) {
  const shown = new Set(items);
  return {
    shown,
    ops: {
      show: (id: string) => shown.add(id),
      hide: (id: string) => shown.delete(id),
      fits: () => shown.size * w <= room,
    },
  };
}

test("shrinkToFit: a row that fits keeps every icon", () => {
  const r = row(500, 40, ["a", "b", "c"]);
  assert.equal(shrinkToFit(["a", "b", "c"], r.ops), 0);
  assert.deepEqual([...r.shown].sort(), ["a", "b", "c"]);
});

test("shrinkToFit: icons leave in order until the row fits", () => {
  const r = row(80, 40, ["a", "b", "c"]);
  assert.equal(shrinkToFit(["a", "b", "c"], r.ops), 1);
  assert.deepEqual([...r.shown].sort(), ["b", "c"]);
});

test("shrinkToFit: starts from all shown, so more room brings icons back", () => {
  const r = row(0, 40, ["a", "b", "c"]);
  shrinkToFit(["a", "b", "c"], r.ops);
  assert.equal(r.shown.size, 0);
  r.ops.fits = () => r.shown.size * 40 <= 200;
  assert.equal(shrinkToFit(["a", "b", "c"], r.ops), 0);
  assert.equal(r.shown.size, 3);
});

test("nameReads: uncut, or cut but still wide enough", () => {
  assert.equal(nameReads({ clientWidth: 30, scrollWidth: 30 }, 64), true);
  assert.equal(nameReads({ clientWidth: 90, scrollWidth: 200 }, 64), true);
  assert.equal(nameReads({ clientWidth: 22, scrollWidth: 120 }, 64), false);
});

test("chanOverflowIds: the terminal switch is the last to leave the agent bar", () => {
  const ids = chanOverflowIds();
  assert.equal(ids[ids.length - 1], "chanTerm");
  assert.ok(ids.includes("chanGallery") && ids.includes("chanInfo"));
});

test("chanOverflowItems: only hidden icons with no existing menu entry, terminal label follows its state", () => {
  const all = new Set(chanOverflowIds());
  assert.deepEqual(chanOverflowItems(all).map((i) => i.id), ["chanGallery", "chanInfo", "chanTerm"]);
  assert.equal(chanOverflowItems(new Set(["chanTerm"]), new Set(["chanTerm"]))[0].label, "💬 Back to the chat");
  assert.deepEqual(chanOverflowItems(new Set()), []);
});

test("nameReads: one pixel short is already an ellipsis", () => {
  assert.equal(nameReads({ clientWidth: 102, scrollWidth: 103 }, 120), false);
});
