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
  mergeGroupsPut,
  secretOwnGroupIds,
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
test("admin has NO reach over a restricted group it is not in; a member does", () => {
  const g: Group = { id: "rh", name: "RH", nature: "restricted", members: ["ada"], createdAt: 0 };
  const admin = { name: "root", role: "admin" as const };
  assert.equal(canAdministerGroup(g, admin), false);
  assert.equal(canSeeGroup(g, admin), false);
  assert.equal(canAdministerGroup(g, { name: "ada", role: "member" }), true);
  assert.equal(canAdministerGroup(g, { name: "ada", role: "admin" }), true);
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
test("membershipVerdict: any member invites, self leaves, only a member removes", () => {
  const g: Group = { id: "t", name: "T", nature: "restricted", members: ["ada", "leo"], createdAt: 0 };
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "invite", "zoe").ok, true);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "leave", "ada").ok, true);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "leave", "leo").ok, false);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, g, "remove", "leo").ok, true);
  assert.equal(membershipVerdict({ name: "zoe", role: "member" }, g, "remove", "ada").ok, false);
  assert.equal(membershipVerdict({ name: "ada", role: "member" }, { ...g, nature: "private" }, "remove", "leo").ok, false);
  assert.equal(membershipVerdict({ name: "root", role: "admin" }, g, "remove", "leo").ok, false);
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

test("delete→re-invite: removing the private-group ROW first means a re-invite mints a FRESH group, never reusing the old id/HOME", () => {
  // The delete handler now removes the row BEFORE the teardown await, so even if
  // the teardown crashed the row is gone. Re-inviting the SAME name must then mint
  // a fresh private group (new id → new sk-<id> → new HOME), never match+reuse a
  // lingering owner-matched row (the data-reuse leak this ordering closes).
  const before: Group[] = [
    { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
    newPrivateGroup("ada", "ada-priv-OLD", 1),
  ];
  // Step 1 — delete ada: the row is removed from the list that gets persisted.
  const afterDelete = accountDeleteGroups("ada", before).groups;
  assert.equal(privateGroupFor("ada", afterDelete), null, "the private row is gone before any teardown await");
  // Step 2 — re-invite ada: no existing private group → a fresh one, new id.
  const reinvited = privateGroupFor("ada", afterDelete) ?? newPrivateGroup("ada", "ada-priv-NEW", 2);
  assert.notEqual(reinvited.id, "ada-priv-OLD", "a re-invite never reuses the deleted person's group id (→ new sk-<id>/HOME)");

  // Contrast — the OLD buggy ordering (row still present at re-invite time) would
  // have matched the lingering row by owner and REUSED it (the leak).
  const stillPresent = privateGroupFor("ada", before);
  assert.equal(stillPresent?.id, "ada-priv-OLD", "owner match would reuse the old row if it were not removed first");
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

test("secretOwnGroupIds: member groups PLUS public non-Main groups (a public group's secrets are visible to all)", () => {
  const groups: Group[] = [
    { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
    { id: "pub", name: "Pub", nature: "public", members: [], createdAt: 0 },
    { id: "r", name: "R", nature: "restricted", members: ["ann"], createdAt: 0 },
    { id: "s", name: "S", nature: "restricted", members: ["zoe"], createdAt: 0 },
    { id: "p", name: "Ada", nature: "private", members: ["ada"], owner: "ada", createdAt: 0 },
  ];
  // A non-member, non-admin still sees the public group "pub" — the bug was a
  // secret added to a public group being invisible to everyone, author included.
  // Main is NOT in the set (it is surfaced as source "main", the commons).
  // A restricted group they are not in, and someone else's private group, stay out.
  assert.deepEqual([...secretOwnGroupIds(groups, { name: "ann", role: "member" })].sort(), ["pub", "r"]);
  // An admin is not special here either: membership + public only, never a
  // restricted group they do not belong to.
  assert.deepEqual([...secretOwnGroupIds(groups, { name: "root", role: "admin" })].sort(), ["pub"]);
  // A null viewer (no session) still sees public groups.
  assert.deepEqual([...secretOwnGroupIds(groups, null)].sort(), ["pub"]);
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

test("mergeGroupsPut: a private group is sealed even against an admin", () => {
  const p: Group = { id: "p", name: "Ada", nature: "private", members: ["ada"], owner: "ada", createdAt: 0 };
  for (const patch of [{ members: ["intruder"] }, { nature: "public" }, { owner: "intruder" }]) {
    const r = mergeGroupsPut([p], [{ id: "p", ...patch }], "ada");
    assert.equal(r.ok, false);
  }
});

test("mergeGroupsPut: a member may change a restricted group's members", () => {
  const g: Group = { id: "r", name: "R", nature: "restricted", members: ["a"], createdAt: 0 };
  const r = mergeGroupsPut([g], [{ id: "r", members: ["a", "b"] }], "a");
  assert.equal(r.ok, true);
  assert.equal(mergeGroupsPut([g], [{ id: "r", members: ["a", "b"] }], "root").ok, false);
});

// ── spawnGroupForRequest ──────────────────────────────────────────────────────
import { spawnGroupFor, spawnGroupForRequest } from "../src/groups.js";
import { readFileSync } from "node:fs";
{
  const mainG: Group = { id: MAIN_GROUP_ID, name: "Main", nature: "public", members: [], createdAt: 0 };
  const pub: Group = { id: "pub", name: "Pub", nature: "public", members: [], createdAt: 0 };
  const a: Group = { id: "a", name: "A", nature: "restricted", members: ["ada"], createdAt: 0 };
  const b: Group = { id: "b", name: "B", nature: "restricted", members: ["ada"], createdAt: 0 };
  const c: Group = { id: "c", name: "C", nature: "restricted", members: ["bob"], createdAt: 0 };
  const all = [mainG, pub, a, b, c];
  const ada = { name: "ada", role: "member" as const };
  const zoe = { name: "zoe", role: "member" as const };

  test("spawnGroupForRequest: a member of 2 groups requesting one gets THAT group, not commons", () => {
    assert.equal(spawnGroupFor(ada, all)?.id, MAIN_GROUP_ID);
    assert.equal(spawnGroupForRequest(ada, all, "b")?.id, "b");
  });
  test("spawnGroupForRequest: a requested public group is returned", () => {
    assert.equal(spawnGroupForRequest(zoe, all, "pub")?.id, "pub");
  });
  test("spawnGroupForRequest: a non-member's request for a foreign group falls back", () => {
    assert.equal(spawnGroupForRequest(ada, all, "c")?.id, spawnGroupFor(ada, all)?.id);
    assert.equal(spawnGroupForRequest(zoe, all, "a")?.id, MAIN_GROUP_ID);
    assert.equal(spawnGroupForRequest(zoe, all, "nope")?.id, MAIN_GROUP_ID);
  });
  test("spawnGroupForRequest: no request equals spawnGroupFor", () => {
    assert.equal(spawnGroupForRequest(ada, all, null)?.id, spawnGroupFor(ada, all)?.id);
  });
}

test("server start handler passes a !resumed-gated msg.group to resolveSpawnIsolation", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(src, /const requestedGroupId =\s*!resumed && typeof msg\.group === "string" && msg\.group\.trim\(\)/);
  assert.match(src, /resolveSpawnIsolation\(\{[^}]*storedGroupId,\s*requestedGroupId,/);
});
