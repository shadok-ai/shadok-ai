import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFolders, foldersForViewer, mergeFoldersPut, reparentGroups, visibleFolderIds, MAX_FOLDER_DEPTH } from "../src/group-folders.js";

test("sanitize: dangling parents, loops and over-deep chains are re-rooted", () => {
  const out = sanitizeFolders([
    { id: "a", name: " A ", parent: "nope" },
    { id: "x", name: "x", parent: "y" },
    { id: "y", name: "y", parent: "x" },
    { id: "bad id!", name: "z" },
    { id: "a", name: "dup" },
    { id: "s", name: "", parent: "s" },
  ]);
  assert.deepEqual(out.map((f) => [f.id, f.name, f.parent]), [["a", "A", null], ["x", "x", null], ["y", "y", "x"], ["s", "folder", null]]);
  const chain = Array.from({ length: MAX_FOLDER_DEPTH + 2 }, (_, i) => ({ id: "d" + i, name: "d", parent: i ? "d" + (i - 1) : null }));
  const deep = sanitizeFolders(chain);
  assert.equal(deep[MAX_FOLDER_DEPTH].parent, null);
  assert.equal(deep[MAX_FOLDER_DEPTH - 1].parent, "d" + (MAX_FOLDER_DEPTH - 2));
});

const stored = [
  { id: "pub", name: "Public stuff", parent: null, createdBy: "alice" },
  { id: "comex", name: "COMEX", parent: null, createdBy: "bob" },
  { id: "inner", name: "Inner", parent: "comex", createdBy: "bob" },
  { id: "mine", name: "Empty", parent: null, createdBy: "carol" },
];
const groups = [
  { id: "g-pub", folder: "pub" },
  { id: "g-comex", folder: "inner" }, // a restricted group carol cannot see
];

test("visibility: a folder shows where the viewer sees a group under it, or made it", () => {
  const carolSees = [groups[0]];
  assert.deepEqual([...visibleFolderIds(stored, carolSees, "carol")].sort(), ["mine", "pub"]);
  assert.deepEqual([...visibleFolderIds(stored, groups, "bob")].sort(), ["comex", "inner", "pub"]);
  // mono-tenant: nobody signs in, every folder is createdBy null like the viewer
  const mono = stored.map((f) => ({ ...f, createdBy: null }));
  assert.equal(visibleFolderIds(mono, [], null).size, 4);
});

test("visibility: a visible folder under a hidden one shows at the root", () => {
  const v = foldersForViewer(stored, [{ id: "g", folder: "inner" }], "zed");
  // inner is visible (a group under it), and so is comex, its ancestor
  assert.deepEqual(v.map((f) => [f.id, f.parent]), [["comex", null], ["inner", "comex"]]);
  const only = foldersForViewer([{ id: "h", name: "h", parent: null, createdBy: "x" }, { id: "k", name: "k", parent: "h", createdBy: "me" }], [], "me");
  assert.deepEqual(only.map((f) => [f.id, f.parent]), [["k", null]]);
});

test("merge: a hidden folder survives omission and renaming", () => {
  const visible = visibleFolderIds(stored, [groups[0]], "carol");
  const out = mergeFoldersPut(stored, [{ id: "pub", name: "Renamed", parent: null }, { id: "comex", name: "pwned", parent: null }], visible, "carol");
  const byId = new Map(out.map((f) => [f.id, f]));
  assert.equal(byId.get("pub")!.name, "Renamed");
  assert.equal(byId.get("comex")!.name, "COMEX");
  assert.ok(byId.has("inner"));
  assert.ok(!byId.has("mine"), "a visible folder omitted from the body is deleted");
});

test("merge: a new folder belongs to its maker, whatever the body claims", () => {
  const out = mergeFoldersPut([], [{ id: "n", name: "New", parent: null, createdBy: "someone-else" }], new Set(), "carol");
  assert.equal(out[0].createdBy, "carol");
});

test("merge: a visible folder can't be parked under a hidden one", () => {
  const visible = visibleFolderIds(stored, [groups[0]], "carol");
  const out = mergeFoldersPut(stored, [{ id: "pub", name: "Public stuff", parent: "comex" }, { id: "mine", name: "Empty", parent: null }], visible, "carol");
  assert.equal(out.find((f) => f.id === "pub")!.parent, null);
});

test("reparent: groups in a removed folder move to the nearest surviving ancestor", () => {
  const after = stored.filter((f) => f.id !== "inner");
  assert.deepEqual([...reparentGroups(groups, stored, after)], [["g-comex", "comex"]]);
  const none = stored.filter((f) => f.id !== "inner" && f.id !== "comex");
  assert.deepEqual([...reparentGroups(groups, stored, none)], [["g-comex", null]]);
  assert.equal(reparentGroups(groups, stored, stored).size, 0);
});

import { mergeGroupsPut } from "../src/groups.js";

test("PUT /groups carries a group's folder as a cosmetic field, nothing more", () => {
  const stored = [{ id: "g", name: "G", nature: "restricted" as const, members: ["bob"], osUser: "sk-g", createdAt: 1 }];
  // A non-member may file it (cosmetic), and its wall is untouched.
  const r = mergeGroupsPut(stored, [{ id: "g", name: "G", folder: "f-1" }], "carol");
  assert.ok(r.ok);
  const g = (r as any).groups[0];
  assert.equal(g.folder, "f-1");
  assert.equal(g.nature, "restricted");
  assert.deepEqual(g.members, ["bob"]);
  const back = mergeGroupsPut((r as any).groups, [{ id: "g", name: "G", folder: null }], "carol");
  assert.equal((back as any).groups[0].folder, null);
});
