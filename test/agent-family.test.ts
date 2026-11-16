import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore — plain ESM shared with the browser
import { familyParents, familyChildren, familyDescendants } from "../public/agent-family.js";

const it = (id: string | null, parent: string | null = null, slot: string | null = null) => ({ id, parent, slot });

test("a child is drawn under its parent when both sit in the same slot", () => {
  const items = [it("lead"), it("a", "lead"), it("b", "lead"), it("solo")];
  const shown = familyParents(items);
  assert.deepEqual([...shown], [["a", "lead"], ["b", "lead"]]);
  const kids = familyChildren(items, shown);
  assert.deepEqual(kids("lead"), ["a", "b"]);
  assert.deepEqual(kids("solo"), []);
});

test("a child filed in another folder stays where it was put", () => {
  const items = [it("lead"), it("a", "lead", "folder-1"), it("b", "lead")];
  assert.deepEqual([...familyParents(items)], [["b", "lead"]]);
});

test("a child whose parent is closed becomes a root, and keeps its own children", () => {
  const items = [it("mid", "gone"), it("leaf", "mid")];
  const shown = familyParents(items);
  assert.equal(shown.has("mid"), false);
  assert.equal(shown.get("leaf"), "mid");
});

test("grandchildren nest, and a folded parent speaks for every depth", () => {
  const items = [it("lead"), it("a", "lead"), it("a1", "a"), it("a2", "a"), it("b", "lead")];
  const kids = familyChildren(items, familyParents(items));
  assert.deepEqual(familyDescendants(kids, "lead"), ["a", "a1", "a2", "b"]);
  assert.deepEqual(familyDescendants(kids, "a1"), []);
});

test("children keep the column's order", () => {
  const items = [it("b", "lead"), it("lead"), it("a", "lead")];
  assert.deepEqual(familyChildren(items, familyParents(items))("lead"), ["b", "a"]);
});

test("a cycle is cut: its members are roots, never an invisible loop", () => {
  const items = [it("z", "x"), it("x", "y"), it("y", "x"), it("self", "self")];
  const shown = familyParents(items);
  assert.equal(shown.has("x"), false);
  assert.equal(shown.has("y"), false);
  assert.equal(shown.has("self"), false);
  // An agent hanging off the loop is still drawn under its parent.
  assert.equal(shown.get("z"), "x");
});

test("a tab with no session yet is a root and breaks nothing", () => {
  const items = [it(null), it("lead"), it(null, "lead"), it("a", "lead")];
  assert.deepEqual([...familyParents(items)], [["a", "lead"]]);
  assert.deepEqual([...familyParents(undefined as any)], []);
});
