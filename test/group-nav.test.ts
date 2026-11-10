import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore — plain ESM shared with the browser
import { GROUP_ICONS, UNGROUPED, randomGroupIcon, resolveGroupView, groupMood, cleanGroupIcon, reconcileTabGroup, groupIsDirty, focusTarget } from "../public/group-nav.js";

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

// ── Folders ────────────────────────────────────────────────────────────────
// @ts-ignore — plain ESM shared with the browser
import { folderRows, groupsUnder, removeFolder, canMoveFolder, isSelfOrAncestor, folderDepth, newFolderId, MAX_FOLDER_DEPTH } from "../public/group-nav.js";

const F = [
  { id: "a", name: "Clients", parent: null },
  { id: "b", name: "Acme", parent: "a" },
  { id: "c", name: "Admin", parent: null },
];

test("folder rows: sub-folders alphabetical first, then groups in their own order", () => {
  const groups = [{ id: "g1", folder: null }, { id: "g2", folder: "b" }, { id: "g3", folder: "a" }, { id: "g4", folder: "zzz" }];
  assert.deepEqual(folderRows(F, groups, new Set()), [
    { kind: "folder", id: "c", depth: 0 },
    { kind: "folder", id: "a", depth: 0 },
    { kind: "folder", id: "b", depth: 1 },
    { kind: "group", id: "g2", depth: 2 },
    { kind: "group", id: "g3", depth: 1 },
    { kind: "group", id: "g1", depth: 0 },
    { kind: "group", id: "g4", depth: 0 }, // a dead folder id sits at the root
  ]);
});

test("folder rows: a folded folder hides its whole subtree", () => {
  const groups = [{ id: "g2", folder: "b" }, { id: "g3", folder: "a" }];
  assert.deepEqual(folderRows(F, groups, new Set(["a"])), [
    { kind: "folder", id: "c", depth: 0 },
    { kind: "folder", id: "a", depth: 0 },
  ]);
});

test("folder rows: a loop on disk never hangs the rail", () => {
  const loop = [{ id: "x", name: "x", parent: "y" }, { id: "y", name: "y", parent: "x" }];
  assert.deepEqual(folderRows(loop, [], new Set()), []);
});

test("groupsUnder: the whole subtree, for the folder's mood and count", () => {
  const groups = [{ id: "g1", folder: null }, { id: "g2", folder: "b" }, { id: "g3", folder: "a" }];
  assert.deepEqual(groupsUnder(F, groups, "a"), ["g2", "g3"]);
  assert.deepEqual(groupsUnder(F, groups, "c"), []);
});

test("removeFolder: contents move up a level, nothing is lost", () => {
  const groups = [{ id: "g2", folder: "b" }, { id: "g3", folder: "a" }];
  const r = removeFolder(F, groups, "a");
  assert.deepEqual(r.folders.map((f: any) => [f.id, f.parent]), [["b", null], ["c", null]]);
  assert.deepEqual([...r.refile], [["g3", null]]);
  const r2 = removeFolder(F, groups, "b");
  assert.deepEqual([...r2.refile], [["g2", "a"]]);
});

test("canMoveFolder: never into itself or below itself, never past the depth cap", () => {
  assert.equal(canMoveFolder(F, "a", "b"), false);
  assert.equal(canMoveFolder(F, "a", "a"), false);
  assert.equal(canMoveFolder(F, "c", "b"), true);
  assert.equal(canMoveFolder(F, "b", null), true);
  const chain = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => ({ id: "d" + i, name: "d" + i, parent: i ? "d" + (i - 1) : null }));
  assert.equal(folderDepth(chain, "d" + (MAX_FOLDER_DEPTH - 1)), MAX_FOLDER_DEPTH);
  assert.equal(canMoveFolder([...chain, { id: "n", name: "n", parent: null }], "n", "d" + (MAX_FOLDER_DEPTH - 1)), false);
  assert.equal(isSelfOrAncestor(F, "a", "b"), true);
});

test("newFolderId: matches what the server accepts", () => {
  assert.match(newFolderId(), /^[A-Za-z0-9_-]{1,64}$/);
});
