import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore — plain ESM shared with the browser
import { GROUP_ICONS, UNGROUPED, randomGroupIcon, resolveGroupView, groupMood, cleanGroupIcon, reconcileTabGroup, groupIsDirty, focusTarget , memberDiff, memberDiffLabel, memberDiffPending } from "../public/group-nav.js";

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

test("focus target: the remembered agent is restored when still in the group", () => {
  // Switching groups used to snap to the top agent; now we return to the one
  // you last had focused in that group.
  assert.equal(focusTarget(["a", "b", "c"], "b"), "b");
  assert.equal(focusTarget(["a", "b", "c"], "c"), "c");
});

test("focus target: falls back to the first agent when nothing is remembered", () => {
  assert.equal(focusTarget(["a", "b"], null), "a");
  assert.equal(focusTarget(["a", "b"], undefined), "a");
});

test("focus target: a remembered agent that has since gone falls back to the first", () => {
  // Closed, or dragged to another group — the memory is stale, so take the top.
  assert.equal(focusTarget(["a", "b"], "z"), "a");
});

test("focus target: an empty group yields nothing to focus", () => {
  assert.equal(focusTarget([], "a"), null);
  assert.equal(focusTarget([], null), null);
});

// ── The member grid's pending diff (the group panel's Save) ──────────────
// The Save button has always existed; what was missing is any sign that a tick
// is NOT yet saved. On a long roster the button scrolls out of the panel's
// body, so ticking tiles looked like the whole act — and closing the panel
// threw the change away in silence.

test("memberDiff: what the ticks would change, against the roster the server holds", () => {
  assert.deepEqual(memberDiff(["ada", "bob"], ["bob", "cy"]), { add: ["cy"], remove: ["ada"] });
  assert.deepEqual(memberDiff(["ada"], ["ada"]), { add: [], remove: [] });
  // Order follows the grid for additions and the roster for removals, so the
  // footer's counts are stable while someone keeps clicking.
  assert.deepEqual(memberDiff([], ["z", "a"]), { add: ["z", "a"], remove: [] });
});

test("memberDiff: a missing or malformed side is empty, never a throw", () => {
  // The panel calls this on every click, including before /groups has answered.
  assert.deepEqual(memberDiff(undefined as unknown as string[], ["a"]), { add: ["a"], remove: [] });
  assert.deepEqual(memberDiff(["a"], undefined as unknown as string[]), { add: [], remove: ["a"] });
  assert.deepEqual(memberDiff(null as unknown as string[], null as unknown as string[]), { add: [], remove: [] });
});

test("memberDiffPending: only a real difference counts as unsaved", () => {
  assert.equal(memberDiffPending(memberDiff(["a"], ["a"])), false);
  assert.equal(memberDiffPending(memberDiff(["a"], [])), true);
  assert.equal(memberDiffPending(null as unknown as { add: string[]; remove: string[] }), false);
});

test("memberDiffLabel: says WHAT is waiting, and says nothing when nothing is", () => {
  assert.equal(memberDiffLabel(memberDiff(["a"], ["a"])), "");
  assert.equal(memberDiffLabel(memberDiff([], ["z"])), "1 person to add — not saved yet");
  assert.equal(memberDiffLabel(memberDiff(["a", "b"], [])), "2 people to remove — not saved yet");
  assert.equal(
    memberDiffLabel(memberDiff(["a"], ["b", "c"])),
    "2 people to add · 1 person to remove — not saved yet",
  );
});
