import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFolders, foldersForViewer, mergeFoldersPut, refileItems, channelFolder, MAX_FOLDER_DEPTH } from "../src/agent-folders.js";
import { mergeChannels } from "../src/channels.js";
// @ts-ignore — plain ESM shared with the browser
import { canMoveFolder, folderChildren, effectiveFolder, removeFolder, folderDepth, newFolderId, levelOrder, anchorsFromOrder } from "../public/agent-folders.js";

test("sanitize: dangling parents, loops, cross-group parents and over-deep chains are re-rooted", () => {
  const out = sanitizeFolders([
    { id: "a", name: " A ", parent: "nope", group: "g1" },
    { id: "x", name: "x", parent: "y" },
    { id: "y", name: "y", parent: "x" },
    { id: "bad id!", name: "z" },
    { id: "a", name: "dup" },
    { id: "s", name: "", parent: "s", group: "main" },
    { id: "c", name: "c", parent: "a", group: "g2" },
  ]);
  assert.deepEqual(
    out.map((f) => [f.id, f.name, f.parent, f.group]),
    [["a", "A", null, "g1"], ["x", "x", null, null], ["y", "y", "x", null], ["s", "folder", null, null], ["c", "c", null, "g2"]],
  );
  const chain = Array.from({ length: MAX_FOLDER_DEPTH + 2 }, (_, i) => ({ id: "d" + i, name: "d", parent: i ? "d" + (i - 1) : null }));
  const deep = sanitizeFolders(chain);
  assert.equal(deep[MAX_FOLDER_DEPTH].parent, null);
  assert.equal(deep[MAX_FOLDER_DEPTH - 1].parent, "d" + (MAX_FOLDER_DEPTH - 2));
});

const stored = sanitizeFolders([
  { id: "m", name: "main stuff", group: null },
  { id: "p", name: "public", group: "pub" },
  { id: "s", name: "COMEX", group: "secret" },
  { id: "s2", name: "inner", parent: "s", group: "secret" },
]);

test("read: a folder shows exactly where its group does (Main is everyone's)", () => {
  assert.deepEqual(foldersForViewer(stored, new Set(["pub"])).map((f) => f.id), ["m", "p"]);
  assert.deepEqual(foldersForViewer(stored, new Set(["pub", "secret"])).map((f) => f.id), ["m", "p", "s", "s2"]);
});

test("write: hidden groups' folders survive, a visible omission deletes, no new folder in a hidden group", () => {
  const next = mergeFoldersPut(
    stored,
    [
      { id: "p", name: "renamed", group: "pub" },
      { id: "s", name: "pwned", group: "secret" }, // ignored: not visible
      { id: "n", name: "new", group: "pub", parent: "p" },
      { id: "h", name: "sneaky", group: "secret" }, // refused: hidden group
      { id: "q", name: "steal", group: "pub", parent: "s" }, // parent in another group → root
    ],
    new Set(["pub"]),
  );
  assert.deepEqual(
    next.map((f) => [f.id, f.name, f.parent, f.group]),
    [["p", "renamed", null, "pub"], ["s", "COMEX", null, "secret"], ["s2", "inner", "s", "secret"], ["n", "new", "p", "pub"], ["q", "steal", null, "pub"]],
  );
});

test("write: a folder never changes group", () => {
  const next = mergeFoldersPut(stored, [{ id: "p", name: "public", group: "other" }, { id: "m", name: "main stuff" }], new Set(["pub", "other"]));
  assert.equal(next.find((f) => f.id === "p")!.group, "pub");
});

test("refile: agents of a removed folder go to its nearest surviving ancestor", () => {
  const before = sanitizeFolders([
    { id: "a", name: "a" },
    { id: "b", name: "b", parent: "a" },
    { id: "c", name: "c", parent: "b" },
  ]);
  const after = before.filter((f) => f.id !== "b" && f.id !== "c");
  const moves = refileItems([{ id: "x", folder: "c" }, { id: "y", folder: "a" }, { id: "z", folder: null }], before, after);
  assert.deepEqual([...moves], [["x", "a"]]);
});

test("channelFolder: only a folder of the agent's own group", () => {
  assert.equal(channelFolder(stored, "p", "pub"), "p");
  assert.equal(channelFolder(stored, "m", "main"), "m");
  assert.equal(channelFolder(stored, "m", null), "m");
  assert.equal(channelFolder(stored, "p", "secret"), null);
  assert.equal(channelFolder(stored, "gone", "pub"), null);
});

test("mergeChannels: an omitted folder keeps the stored one", () => {
  const out = mergeChannels([{ sessionId: "a", cwd: "/x", folder: "f1" } as any], [{ sessionId: "a", name: "n" } as any], new Set());
  assert.equal(out[0].folder, "f1");
  const moved = mergeChannels([{ sessionId: "a", cwd: "/x", folder: "f1" } as any], [{ sessionId: "a", folder: null } as any], new Set());
  assert.equal(moved[0].folder, null);
});

// ── client half ──
const tree = [
  { id: "a", name: "Zeta", parent: null, group: "g" },
  { id: "b", name: "alpha", parent: null, group: "g" },
  { id: "c", name: "c", parent: "a", group: "g" },
  { id: "o", name: "other", parent: null, group: null },
];

test("client: children sorted by name, per group", () => {
  const kids = folderChildren(tree, "g");
  assert.deepEqual(kids(null).map((f: any) => f.id), ["b", "a"]);
  assert.deepEqual(kids("a").map((f: any) => f.id), ["c"]);
  assert.deepEqual(folderChildren(tree, null)(null).map((f: any) => f.id), ["o"]);
});

test("client: a folder can't move into itself, a descendant, another group, or past the cap", () => {
  assert.equal(canMoveFolder(tree, "a", "c"), false);
  assert.equal(canMoveFolder(tree, "a", "a"), false);
  assert.equal(canMoveFolder(tree, "a", "o"), false);
  assert.equal(canMoveFolder(tree, "b", "c"), true);
  assert.equal(canMoveFolder(tree, "c", null), true);
  const chain = Array.from({ length: 8 }, (_, i) => ({ id: "d" + i, name: "d", parent: i ? "d" + (i - 1) : null, group: "g" }));
  assert.equal(folderDepth(chain, "d7"), 8);
  assert.equal(canMoveFolder([...chain, { id: "x", name: "x", parent: null, group: "g" }], "x", "d7"), false);
  assert.equal(canMoveFolder([...chain, { id: "x", name: "x", parent: null, group: "g" }], "x", "d6"), true);
});

test("client: a stale folder never hides an agent", () => {
  assert.equal(effectiveFolder(tree, "c", "g"), "c");
  assert.equal(effectiveFolder(tree, "c", null), null);
  assert.equal(effectiveFolder(tree, "gone", "g"), null);
});

test("client: removing a folder moves its sub-folders and agents up a level", () => {
  const r = removeFolder(tree, [{ id: "s1", folder: "a" }, { id: "s2", folder: "b" }], "a");
  assert.deepEqual(r.folders.map((f: any) => [f.id, f.parent]), [["b", null], ["c", null], ["o", null]]);
  assert.deepEqual([...r.refile], [["s1", null]]);
  assert.match(newFolderId(() => 0.5, () => 1000), /^[A-Za-z0-9_-]{1,64}$/);
});

// ── A folder's place among the agents of its level ──
const lay = (items: (string | null)[], kids: any[]) =>
  levelOrder(items, kids).map((e: any) => (e.folder ? "F" + e.folder.id : items[e.item] ?? "?"));

test("order: a folder with no anchor leads its level, as every folder used to", () => {
  assert.deepEqual(lay(["a:1", "a:2"], [{ id: "x" }, { id: "y" }]), ["Fx", "Fy", "a:1", "a:2"]);
});

test("order: a folder sits right after the agent or chat it was dropped below", () => {
  assert.deepEqual(lay(["a:1", "r:9", "a:2"], [{ id: "x", after: "a:1" }, { id: "y", after: "a:2" }]), ["a:1", "Fx", "r:9", "a:2", "Fy"]);
  assert.deepEqual(lay(["a:1", "r:9"], [{ id: "x", after: "r:9" }]), ["a:1", "r:9", "Fx"]);
});

test("order: folders chain after each other, in the order they were left", () => {
  assert.deepEqual(lay(["a:1", "a:2"], [{ id: "x", after: "f:y" }, { id: "y", after: "a:1" }]), ["a:1", "Fy", "Fx", "a:2"]);
});

test("order: a gone anchor, a self-anchor or a loop never hides a folder — it leads", () => {
  assert.deepEqual(lay(["a:1"], [{ id: "x", after: "a:closed" }]), ["Fx", "a:1"]);
  assert.deepEqual(lay(["a:1"], [{ id: "x", after: "f:x" }]), ["Fx", "a:1"]);
  const out = lay(["a:1"], [{ id: "x", after: "f:y" }, { id: "y", after: "f:x" }]);
  assert.deepEqual([...out].sort(), ["Fx", "Fy", "a:1"]);
  assert.equal(out[out.length - 1], "a:1");
});

test("order: a tab not keyed yet keeps its place and anchors nothing", () => {
  assert.deepEqual(lay(["a:1", null, "a:2"], [{ id: "x", after: "a:2" }]), ["a:1", "?", "a:2", "Fx"]);
});

test("anchors read off the screen: the nearest keyed entry above, nothing when leading", () => {
  const m = anchorsFromOrder([{ folder: "x" }, { item: "a:1" }, { item: null }, { folder: "y" }, { folder: "z" }]);
  assert.deepEqual([...m], [["x", null], ["y", "a:1"], ["z", "f:y"]]);
});

test("anchors round-trip: what the screen shows is what the next layout draws", () => {
  const screen = [{ item: "a:1" }, { folder: "x" }, { item: "r:2" }, { folder: "y" }, { item: "a:3" }];
  const anchors = anchorsFromOrder(screen);
  const kids = ["x", "y"].map((id) => ({ id, after: anchors.get(id) ?? undefined }));
  assert.deepEqual(lay(["a:1", "r:2", "a:3"], kids), ["a:1", "Fx", "r:2", "Fy", "a:3"]);
});

test("server: a folder's anchor is kept, validated, and cleared by a write that drops it", () => {
  const rows = sanitizeFolders([
    { id: "a", name: "a", after: "a:3f2c-11" },
    { id: "b", name: "b", after: "f:b" },
    { id: "c", name: "c", after: "<script>" },
    { id: "d", name: "d", after: "r:room_1" },
  ]);
  assert.deepEqual(rows.map((f) => f.after), ["a:3f2c-11", undefined, undefined, "r:room_1"]);
  const next = mergeFoldersPut(rows, [{ id: "a", name: "a" }, { id: "d", name: "d", after: "f:a" }], new Set());
  assert.deepEqual(next.map((f) => [f.id, f.after]), [["a", undefined], ["d", "f:a"]]);
});
