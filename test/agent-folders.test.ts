import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFolders, foldersForViewer, mergeFoldersPut, refileItems, channelFolder, MAX_FOLDER_DEPTH } from "../src/agent-folders.js";
import { mergeChannels } from "../src/channels.js";
// @ts-ignore — plain ESM shared with the browser
import { canMoveFolder, folderChildren, effectiveFolder, removeFolder, folderDepth, newFolderId } from "../public/agent-folders.js";

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
