import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSeeGroup,
  canAdministerGroup,
  membershipVerdict,
  visibleGroupIds,
  memberOf,
  MAIN_GROUP_ID,
  type Group,
} from "../src/groups.js";

test("public group is visible and drivable by everyone, incl. a non-member", () => {
  const g: Group = { id: "x", name: "X", nature: "public", members: [], createdAt: 0 };
  assert.equal(canSeeGroup(g, { name: "zoe", role: "member" }), true);
  assert.equal(canSeeGroup(g, null), true);
});
test("restricted group is visible only to its members", () => {
  const g: Group = { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 };
  assert.equal(canSeeGroup(g, { name: "ada", role: "member" }), true);
  assert.equal(canSeeGroup(g, { name: "zoe", role: "member" }), false);
  assert.equal(canSeeGroup(g, { name: "zoe", role: "admin" }), false);
  assert.equal(canSeeGroup(g, null), false);
});
test("private group is sealed even to an admin", () => {
  const g: Group = { id: "p", name: "Ada", nature: "private", members: ["ada"], owner: "ada", createdAt: 0 };
  assert.equal(canSeeGroup(g, { name: "root", role: "admin" }), false);
  assert.equal(canAdministerGroup(g, { name: "root", role: "admin" }), false);
  assert.equal(canAdministerGroup(g, { name: "ada", role: "member" }), false);
});
test("private owner counts as a member even if absent from members", () => {
  const g: Group = { id: "p", name: "Ada", nature: "private", members: [], owner: "ada", createdAt: 0 };
  assert.equal(memberOf(g, "ada"), true);
  assert.equal(canSeeGroup(g, { name: "ada", role: "member" }), true);
});
test("admin administers a restricted group it is not in, but cannot see/drive it", () => {
  const g: Group = { id: "rh", name: "RH", nature: "restricted", members: ["ada"], createdAt: 0 };
  const admin = { name: "root", role: "admin" as const };
  assert.equal(canAdministerGroup(g, admin), true);
  assert.equal(canSeeGroup(g, admin), false);
  assert.equal(canAdministerGroup(g, null), false);
});
test("visibleGroupIds filters by visibility", () => {
  const gs: Group[] = [
    { id: MAIN_GROUP_ID, name: "Main", nature: "public", members: [], createdAt: 0 },
    { id: "a", name: "A", nature: "restricted", members: ["ada"], createdAt: 0 },
    { id: "b", name: "B", nature: "restricted", members: ["leo"], createdAt: 0 },
  ];
  assert.deepEqual([...visibleGroupIds(gs, { name: "ada", role: "member" })].sort(), ["a", "main"]);
  assert.deepEqual([...visibleGroupIds(gs, null)], ["main"]);
});
test("membershipVerdict: any member invites, self leaves, only admin removes", () => {
  const g: Group = { id: "t", name: "T", nature: "restricted", members: ["ada", "leo"], createdAt: 0 };
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "invite", "zoe").ok, true);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "leave", "ada").ok, true);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "leave", "leo").ok, false);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "remove", "leo").ok, false);
  assert.equal(membershipVerdict({ name: "root", role: "admin" }, g, "remove", "leo").ok, true);
  assert.equal(membershipVerdict({ name: "zoe", role: "member" }, g, "invite", "x").ok, false);
  assert.equal(membershipVerdict(null, g, "invite", "x").ok, false);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, { ...g, nature: "private" }, "invite", "z").ok, false);
  assert.equal(membershipVerdict({ name: "root", role: "admin" }, { ...g, nature: "public" }, "remove", "leo").ok, false);
});
