import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore — plain ESM shared with the browser
import { GROUP_ICONS, UNGROUPED, randomGroupIcon, resolveGroupView, groupMood, cleanGroupIcon, reconcileTabGroup, groupIsDirty } from "../public/group-nav.js";

test("group icon: drawn from the list, bounds included", () => {
  assert.equal(randomGroupIcon(() => 0), GROUP_ICONS[0]);
  assert.equal(randomGroupIcon(() => 0.9999999), GROUP_ICONS[GROUP_ICONS.length - 1]);
  assert.equal(randomGroupIcon(() => 1), GROUP_ICONS[GROUP_ICONS.length - 1]);
  assert.ok(GROUP_ICONS.includes(randomGroupIcon()));
});

test("group view: a saved group that still exists is kept, as a string", () => {
  assert.equal(resolveGroupView("3", [1, 3]), "3");
  assert.equal(resolveGroupView(3, ["3"]), "3");
});

test("group view: a dissolved or missing group falls back to ungrouped", () => {
  assert.equal(resolveGroupView("7", [1, 3]), UNGROUPED);
  assert.equal(resolveGroupView(null, [1]), UNGROUPED);
  assert.equal(resolveGroupView(UNGROUPED, []), UNGROUPED);
});

test("group mood: what needs you first", () => {
  assert.equal(groupMood(["working", "unread", null]), "unread");
  assert.equal(groupMood(["working", "needs-answer"]), "needs-answer");
  assert.equal(groupMood(["working"]), "working");
  assert.equal(groupMood([null, null]), null);
  assert.equal(groupMood([]), null);
});

test("group icon: typed text is trimmed and kept short, empty keeps the old one", () => {
  assert.equal(cleanGroupIcon("  🚀 "), "🚀");
  assert.equal(cleanGroupIcon("👨‍👩‍👧"), "👨‍👩‍👧");          // one grapheme, several code points
  assert.equal(cleanGroupIcon("abcdef"), "ab");
  assert.equal(cleanGroupIcon("   "), null);
  assert.equal(cleanGroupIcon(undefined), null);
});

test("tab group sync: a move made elsewhere is followed", () => {
  // This tab saw group 1, the server now says 2 → follow it.
  assert.deepEqual(reconcileTabGroup(1, 1, 2), { move: true, synced: 2 });
  assert.deepEqual(reconcileTabGroup(1, 1, null), { move: true, synced: null });
  assert.deepEqual(reconcileTabGroup(null, null, 3), { move: true, synced: 3 });
});

test("tab group sync: this tab's own unconfirmed move is kept", () => {
  // Dragged 1 → 2 here, the push has not landed: the stale server value must
  // not drag it back.
  assert.deepEqual(reconcileTabGroup(2, 1, 1), { move: false, synced: 1 });
  // A brand-new tab has never agreed on anything.
  assert.deepEqual(reconcileTabGroup(2, undefined, null), { move: false, synced: undefined });
});

test("tab group sync: agreement is recorded, null and undefined are one", () => {
  assert.deepEqual(reconcileTabGroup(2, 1, 2), { move: false, synced: 2 });
  assert.deepEqual(reconcileTabGroup(null, 4, undefined), { move: false, synced: null });
});

test("tab group push: only a tab that moved the agent sends its group", () => {
  assert.equal(groupIsDirty(1, 1), false);
  assert.equal(groupIsDirty(null, null), false);
  assert.equal(groupIsDirty(2, 1), true);
  assert.equal(groupIsDirty(null, undefined), true);
});
