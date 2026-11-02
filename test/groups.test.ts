import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSeeGroup,
  canAdministerGroup,
  membershipVerdict,
  visibleGroupIds,
  memberOf,
  MAIN_GROUP_ID,
  visibleChannels,
  viewerFor,
  canResumeAs,
  canRestartInto,
  privateGroupFor,
  newPrivateGroup,
  membersWithout,
  accountDeleteGroups,
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

// ── Task 16: account lifecycle (invite → provision, delete → cascade) ──────────

test("newPrivateGroup: one sealed group, owner is sole member (the brief's shape)", () => {
  const g = newPrivateGroup("ada", "g1", 42);
  assert.equal(g.nature, "private");
  assert.equal(g.owner, "ada");
  assert.deepEqual(g.members, ["ada"]);
  assert.equal(g.id, "g1");
  assert.equal(g.createdAt, 42);
  assert.equal(g.osUser, null); // the server sets it via osUserFor before persist
});

test("privateGroupFor: finds the account's private group by owner, idempotency guard", () => {
  const groups: Group[] = [
    { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
    { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
    newPrivateGroup("ada", "ada-priv", 1),
  ];
  assert.equal(privateGroupFor("ada", groups)?.id, "ada-priv");
  // A new person has no private group yet → redeeming provisions exactly one.
  assert.equal(privateGroupFor("zoe", groups), null);
  // Owner, not membership: a private row listing the owner only in `members`
  // (not as owner) is NOT theirs — owner is the durable identity.
  const quirky: Group = { id: "q", name: "Q", nature: "private", members: ["leo"], owner: "x", createdAt: 0 };
  assert.equal(privateGroupFor("leo", [quirky]), null);
});

test("membersWithout: drops the account, preserves order, leaves others untouched", () => {
  assert.deepEqual(membersWithout(["ada", "leo", "zoe"], "leo"), ["ada", "zoe"]);
  assert.deepEqual(membersWithout(["ada"], "zoe"), ["ada"]);
});

test("accountDeleteGroups: tears down ONLY the private group, drops restricted memberships", () => {
  const groups: Group[] = [
    { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
    { id: "comex", name: "COMEX", nature: "restricted", members: ["ada", "leo"], createdAt: 0 },
    { id: "rh", name: "RH", nature: "restricted", members: ["leo"], createdAt: 0 },
    newPrivateGroup("ada", "ada-priv", 1),
  ];
  const r = accountDeleteGroups("ada", groups);
  // The private group is the one torn down…
  assert.equal(r.torndown?.id, "ada-priv");
  // …and its row is gone from the remaining list.
  assert.equal(r.groups.some((g) => g.id === "ada-priv"), false);
  // COMEX SURVIVES — ada is merely dropped from its members (leo stays).
  const comex = r.groups.find((g) => g.id === "comex")!;
  assert.deepEqual(comex.members, ["leo"]);
  // RH never had ada → untouched; main untouched.
  assert.deepEqual(r.groups.find((g) => g.id === "rh")!.members, ["leo"]);
  assert.ok(r.groups.some((g) => g.id === "main"));
  // No group is torn down just because a member left (only the private one).
  assert.equal(r.groups.filter((g) => g.nature === "restricted").length, 2);
});

test("accountDeleteGroups: a person with no private group tears nothing down", () => {
  const groups: Group[] = [
    { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
    { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
  ];
  const r = accountDeleteGroups("ada", groups);
  assert.equal(r.torndown, null);
  assert.deepEqual(r.groups.find((g) => g.id === "comex")!.members, []); // still dropped
  assert.equal(r.groups.length, 2); // nothing removed
});

const ch = (sessionId: string, group?: string | null) =>
  ({ sessionId, cwd: "/x", group }) as unknown as import("../src/channels.js").Channel;
const gs: Group[] = [
  { id: "pub", name: "Pub", nature: "public", members: [], createdAt: 0 },
  { id: "r", name: "R", nature: "restricted", members: ["ann"], createdAt: 0 },
];

test("visibleChannels keeps public, own-group and group-less channels, and drops an unresolved group (fail closed)", () => {
  const v = { name: "ann", role: "member" as const };
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: unknown) => void warned.push(String(m));
  try {
    const out = visibleChannels([ch("a", "pub"), ch("b", "r"), ch("c"), ch("d", null), ch("e", "ghost")], gs, v);
    assert.deepEqual(out.map((c) => c.sessionId), ["a", "b", "c", "d"]);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /ghost/);
  assert.match(warned[0], /\be\b/);
});

test("visibleChannels drops a restricted channel for a null viewer", () => {
  assert.deepEqual(visibleChannels([ch("b", "r")], gs, null).map((c) => c.sessionId), []);
});

test("visibleChannels drops a restricted channel for a non-member admin", () => {
  assert.deepEqual(visibleChannels([ch("b", "r")], gs, { name: "root", role: "admin" }).map((c) => c.sessionId), []);
});

test("visibleChannels drops a restricted channel for a non-member", () => {
  const out = visibleChannels([ch("a", "pub"), ch("b", "r")], gs, { name: "zoe", role: "member" });
  assert.deepEqual(out.map((c) => c.sessionId), ["a"]);
});

test("viewerFor passes null through and round-trips an account", () => {
  assert.equal(viewerFor(null), null);
  assert.deepEqual(viewerFor({ name: "ann", role: "admin" }), { name: "ann", role: "admin" });
});

const resumeGroups: Group[] = [
  { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
  { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
];

test("canResumeAs: a group-less / null channel is always resumable (commons, no drop)", () => {
  assert.equal(canResumeAs(null, resumeGroups, { name: "zoe", role: "member" }), true);
  assert.equal(canResumeAs(undefined, resumeGroups, null), true);
});

test("canResumeAs: a public group is resumable by anyone", () => {
  assert.equal(canResumeAs("main", resumeGroups, { name: "zoe", role: "member" }), true);
  assert.equal(canResumeAs("main", resumeGroups, null), true);
});

test("canResumeAs: the privilege-escalation vector — a non-member cannot resume into a restricted group", () => {
  // zoe plants {sessionId, group:"comex"} and resumes it; without this gate she
  // would come up under comex's OS user driving comex's transcript.
  assert.equal(canResumeAs("comex", resumeGroups, { name: "zoe", role: "member" }), false);
  // An admin is NOT exempt (canSeeGroup rule).
  assert.equal(canResumeAs("comex", resumeGroups, { name: "root", role: "admin" }), false);
  // A real member resumes fine.
  assert.equal(canResumeAs("comex", resumeGroups, { name: "ada", role: "member" }), true);
});

test("canResumeAs: a dangling group id is refused (fail closed, never falls back to commons)", () => {
  assert.equal(canResumeAs("ghost", resumeGroups, { name: "ada", role: "member" }), false);
  assert.equal(canResumeAs("ghost", resumeGroups, { name: "root", role: "admin" }), false);
});

test("canRestartInto: resolution-only (no membership) — a restart re-derives the session's own user", () => {
  // No human principal drives a restart; the people-boundary was enforced at
  // spawn. So an admin's /restart-all and a member's self-restart both succeed
  // for a resolvable group, regardless of who triggered it.
  assert.equal(canRestartInto("comex", resumeGroups), true);
  assert.equal(canRestartInto("main", resumeGroups), true);
  assert.equal(canRestartInto(null, resumeGroups), true);
  // But a dangling group is refused: respawning would drop to the commons/root
  // user and keep the private transcript running — a silent downgrade.
  assert.equal(canRestartInto("ghost", resumeGroups), false);
});
