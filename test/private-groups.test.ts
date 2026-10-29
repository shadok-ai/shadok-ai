import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "../src/channels.js";
import {
  canSeeChannel,
  canSeeSession,
  visibleChannels,
  groupsView,
  mergeClientGroups,
  guardClientChannels,
  moveVerdict,
  spawnGroup,
  setPrivate,
  setMembers,
  dropMember,
  type Group,
  type Viewer,
} from "../src/private-groups.js";
import { mergeChannels } from "../src/channels.js";

const alice: Viewer = { kind: "person", name: "alice" };
const bob: Viewer = { kind: "person", name: "bob" };
const admin: Viewer = { kind: "person", name: "admin" };
const server: Viewer = { kind: "all" };

const groups: Group[] = [
  { id: 1, name: "open" },
  { id: 2, name: "rh", private: true, owner: "alice", members: ["alice", "carol"], icon: "🔒", order: 1 },
];
const ch = (sessionId: string, group: number | null, extra: Partial<Channel> = {}): Channel => ({
  sessionId,
  cwd: "/x",
  name: sessionId,
  group,
  ...extra,
});
const channels: Channel[] = [ch("pub", 1), ch("loose", null), ch("secret", 2), ch("secret2", 2)];
const agentIn: Viewer = { kind: "agent", sessionId: "secret" };
const agentOut: Viewer = { kind: "agent", sessionId: "pub" };

test("a member sees a private group's agents, a non-member — even an admin — does not", () => {
  assert.deepEqual(visibleChannels(alice, channels, groups).map((c) => c.sessionId), ["pub", "loose", "secret", "secret2"]);
  assert.deepEqual(visibleChannels(bob, channels, groups).map((c) => c.sessionId), ["pub", "loose"]);
  assert.deepEqual(visibleChannels(admin, channels, groups).map((c) => c.sessionId), ["pub", "loose"]);
  assert.equal(visibleChannels(server, channels, groups).length, 4);
});

test("an agent sees its own private group, and an agent outside does not reach in", () => {
  assert.ok(canSeeSession(agentIn, "secret2", groups, channels));
  assert.ok(canSeeSession(agentIn, "pub", groups, channels));
  assert.ok(!canSeeSession(agentOut, "secret", groups, channels));
  // An id the registry never heard of is not private.
  assert.ok(canSeeSession(bob, "unknown", groups, channels));
});

test("a non-member reads a locked stub: existence, members, count — never agent names", () => {
  const view = groupsView(bob, groups, channels);
  assert.deepEqual(view[0], groups[0]);
  assert.deepEqual(view[1], {
    id: 2,
    name: "rh",
    icon: "🔒",
    order: 1,
    private: true,
    locked: true,
    members: ["alice", "carol"],
    owner: "alice",
    agentCount: 2,
  });
  assert.deepEqual(groupsView(alice, groups, channels)[1], groups[1]);
});

test("PUT /groups: a client never writes access fields, nor touches a private group it is not in", () => {
  // bob renames both, tries to make the open one private, and omits nothing.
  const fromBob = [
    { id: 1, name: "renamed", private: true, members: ["bob"] },
    { id: 2, name: "hacked", locked: true, agentCount: 9, members: ["bob"] },
  ];
  const out = mergeClientGroups(bob, groups, fromBob, channels);
  assert.deepEqual(out[0], { id: 1, name: "renamed" });
  assert.deepEqual(out[1], groups[1]);
  // bob omits the private group: it survives.
  assert.deepEqual(mergeClientGroups(bob, groups, [{ id: 1, name: "open" }], channels).map((g) => g.id), [1, 2]);
  // alice (member) renames it and keeps its access fields; she can delete it.
  const byAlice = mergeClientGroups(alice, groups, [groups[0], { id: 2, name: "hr" }], channels);
  assert.deepEqual(byAlice[1], { id: 2, name: "hr", private: true, members: ["alice", "carol"], owner: "alice" });
  assert.deepEqual(mergeClientGroups(alice, groups, [groups[0]], channels).map((g) => g.id), [1]);
});

test("PUT /channels: a non-member's list neither erases, rewrites nor drags in a private agent", () => {
  // bob sees pub + loose only; his PUT omits the private ones and forges one.
  const body = [ch("pub", 2), ch("loose", null), ch("secret", null, { name: "stolen" })];
  const { body: safe, keep } = guardClientChannels(bob, channels, groups, body);
  assert.deepEqual([...keep].sort(), ["secret", "secret2"]);
  assert.deepEqual(safe.map((c) => [c.sessionId, c.group]), [["pub", 1], ["loose", null]]);
  const merged = mergeChannels(channels, safe, keep);
  assert.deepEqual(merged.map((c) => c.sessionId).sort(), ["loose", "pub", "secret", "secret2"]);
  assert.equal(merged.find((c) => c.sessionId === "secret")!.name, "secret");
  // alice may move a public agent in, and an agent out (making it public).
  const byAlice = guardClientChannels(alice, channels, groups, [ch("pub", 2), ch("secret", null), ch("secret2", 2), ch("loose", null)]);
  assert.equal(byAlice.keep.size, 0);
  assert.deepEqual(byAlice.body.map((c) => c.group), [2, null, 2, null]);
});

test("a Telegram-mirrored agent cannot go private", () => {
  assert.match(moveVerdict(alice, { telegram: { chatId: -1, threadId: 3 } }, 2, groups, channels)!, /Telegram/);
  assert.equal(moveVerdict(alice, {}, 2, groups, channels), null);
  assert.equal(moveVerdict(bob, {}, 1, groups, channels), null);
  assert.match(moveVerdict(bob, {}, 2, groups, channels)!, /not a member/);
});

test("a new agent lands where asked if allowed, else in its parent's private group", () => {
  assert.equal(spawnGroup(alice, 2, null, groups, channels), 2);
  assert.equal(spawnGroup(bob, 2, null, groups, channels), undefined);
  assert.equal(spawnGroup(bob, 1, null, groups, channels), 1);
  // pilotctl names no group: the child follows a private parent.
  assert.equal(spawnGroup(agentIn, undefined, "secret", groups, channels), 2);
  assert.equal(spawnGroup(agentOut, undefined, "pub", groups, channels), undefined);
  // A client-side group not yet persisted is not private.
  assert.equal(spawnGroup(bob, 99, null, groups, channels), 99);
});

test("making private / public: a person who is a member, with accounts on", () => {
  const on = setPrivate(bob, groups, channels, 1, true, true);
  assert.ok(on.ok);
  assert.deepEqual(on.groups[0], { id: 1, name: "open", private: true, owner: "bob", members: ["bob"] });
  assert.equal(setPrivate(bob, groups, channels, 1, true, false).ok, false);
  assert.equal(setPrivate(agentIn, groups, channels, 1, true, true).ok, false);
  assert.equal(setPrivate(server, groups, channels, 1, true, true).ok, false);
  // An admin who is not a member cannot unlock it.
  assert.equal(setPrivate(admin, groups, channels, 2, false, true).ok, false);
  const off = setPrivate(alice, groups, channels, 2, false, true);
  assert.ok(off.ok);
  assert.deepEqual(off.groups[1], { id: 2, name: "rh", icon: "🔒", order: 1 });
  const bound = [...channels, ch("tg", 1, { telegram: { chatId: -5, threadId: 7 } })];
  assert.match((setPrivate(bob, groups, bound, 1, true, true) as { error: string }).error, /Telegram/);
});

test("members: only members edit, only real accounts, never empty", () => {
  const accounts = ["admin", "alice", "bob", "carol"];
  const r = setMembers(alice, groups, channels, 2, ["alice", "bob", " bob "], accounts);
  assert.ok(r.ok);
  assert.deepEqual(r.groups[1].members, ["alice", "bob"]);
  assert.equal(setMembers(admin, groups, channels, 2, ["admin"], accounts).ok, false);
  assert.match((setMembers(alice, groups, channels, 2, ["mallory"], accounts) as { error: string }).error, /mallory/);
  assert.equal(setMembers(alice, groups, channels, 2, [], accounts).ok, false);
  assert.equal(setMembers(alice, groups, channels, 1, ["alice"], accounts).ok, false);
});

test("a deleted account leaves every private group, so re-inviting the name does not walk back in", () => {
  const out = dropMember(groups, "carol");
  assert.deepEqual(out[1].members, ["alice"]);
  assert.deepEqual(out[0], groups[0]);
  assert.ok(!canSeeChannel({ kind: "person", name: "carol" }, channels[2], out, channels));
});

test("the instance password's account never holds a private group — every agent carries it", () => {
  const withAdmin: Group[] = [{ id: 3, name: "x", private: true, members: ["admin", "alice"] }];
  const c = [ch("a", 3)];
  // Even listed by hand in the file, it does not grant sight.
  assert.ok(!canSeeChannel(admin, c[0], withAdmin, c));
  assert.match((setPrivate(admin, groups, channels, 1, true, true) as { error: string }).error, /own account/);
  assert.match((setMembers(alice, groups, channels, 2, ["alice", "admin"], ["admin", "alice"]) as { error: string }).error, /instance password/);
});
