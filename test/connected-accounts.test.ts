import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accountEditVerdict,
  accountVisible,
  commonsGroupIds,
  loadAccountsStore,
  publicView,
  resolveAccountId,
  saveAccountsStore,
  upsertAccount,
  type ConnectedAccount,
  type ShareScope,
} from "../src/connected-accounts.js";
import type { Group, Viewer } from "../src/groups.js";

const g = (id: string, nature: Group["nature"], members: string[], owner?: string): Group => ({
  id, name: id, nature, members, owner, createdAt: 0,
});
const groups: Group[] = [
  g("main", "public", []),
  g("g1", "restricted", ["ann", "bob"]),
  g("g2", "restricted", ["cat"]),
  g("p-ann", "private", ["ann"], "ann"),
  g("p-cat", "private", ["cat"], "cat"),
];
const acct = (share: ShareScope): ConnectedAccount => ({
  id: "abcd1234", provider: "linkedin", kind: "member", label: "Ann", externalId: "urn:li:person:1",
  owner: "ann", connectedVia: "ann", share, policy: "approve", token: "secret", expiresAt: 9, createdAt: 1, updatedAt: 1,
});
const person = (name: string, role: Viewer["role"] = "member"): Viewer => ({ name, role });
const agent = (agentGroup: string | null): Viewer => ({ name: "ann", role: "admin", agentGroup });
const noPeer = { peerBox: null };

const viewers: Record<string, Viewer> = {
  owner: person("ann"),
  memberG1: person("bob"),
  nonMember: person("dan"),
  admin: person("root", "admin"),
  agentOwnerPrivate: agent("p-ann"),
  agentG1: agent("g1"),
  agentMain: agent("main"),
  agentCommons: agent(null),
  agentOtherPrivate: agent("p-cat"),
  agentG2: agent("g2"),
};
const matrix: Record<string, Record<string, boolean>> = {
  private: {
    owner: true, memberG1: false, nonMember: false, admin: false,
    agentOwnerPrivate: true, agentG1: false, agentMain: false, agentCommons: false, agentOtherPrivate: false, agentG2: false,
  },
  g1: {
    owner: true, memberG1: true, nonMember: false, admin: false,
    agentOwnerPrivate: false, agentG1: true, agentMain: false, agentCommons: false, agentOtherPrivate: false, agentG2: false,
  },
  main: {
    owner: true, memberG1: true, nonMember: true, admin: true,
    agentOwnerPrivate: false, agentG1: false, agentMain: true, agentCommons: true, agentOtherPrivate: false, agentG2: false,
  },
  instance: {
    owner: true, memberG1: true, nonMember: true, admin: true,
    agentOwnerPrivate: true, agentG1: false, agentMain: true, agentCommons: true, agentOtherPrivate: false, agentG2: false,
  },
};
const shares: Record<string, ShareScope> = {
  private: { scope: "private" },
  g1: { scope: "groups", groups: ["g1"] },
  main: { scope: "groups", groups: ["main"] },
  instance: { scope: "instance" },
};

for (const [sk, row] of Object.entries(matrix)) {
  for (const [vk, expected] of Object.entries(row)) {
    test(`visible: scope ${sk} x ${vk} = ${expected}`, () => {
      assert.equal(accountVisible(acct(shares[sk]), viewers[vk], groups, noPeer), expected);
    });
  }
}

test("peerBox and null viewer never see", () => {
  for (const s of Object.values(shares)) {
    for (const v of Object.values(viewers)) assert.equal(accountVisible(acct(s), v, groups, { peerBox: "box" }), false);
    assert.equal(accountVisible(acct(s), null, groups, noPeer), false);
  }
});

test("commonsGroupIds is Main plus public groups", () => {
  assert.deepEqual([...commonsGroupIds([...groups, g("pub", "public", [])])].sort(), ["main", "pub"]);
});

test("edit verdicts", () => {
  const a = acct({ scope: "private" });
  assert.equal(accountEditVerdict(a, viewers.owner, "reconnect").ok, true);
  assert.equal(accountEditVerdict(a, viewers.owner, "policy", { policy: "autonomous" }).ok, true);
  assert.equal(accountEditVerdict(a, viewers.admin, "disconnect").ok, true);
  const p = accountEditVerdict(a, viewers.admin, "policy", { policy: "autonomous" });
  assert.equal(p.ok, false);
  assert.equal(accountEditVerdict(a, viewers.admin, "share", { share: { scope: "instance" } }).ok, false);
  assert.equal(accountEditVerdict(a, viewers.memberG1, "disconnect").ok, false);
  assert.equal(accountEditVerdict(a, viewers.agentOwnerPrivate, "disconnect").ok, false);
  assert.equal(accountEditVerdict(a, null, "disconnect").ok, false);
  const ok = (ids: string[]) => accountEditVerdict(a, viewers.owner, "share", { share: { scope: "groups", groups: ids } }, groups);
  assert.equal(ok(["g1"]).ok, true);
  assert.equal(ok(["p-ann", "main"]).ok, true);
  assert.equal(ok(["g2"]).ok, false);
  assert.equal(ok([]).ok, false);
  assert.equal(ok(["nope"]).ok, false);
});

test("upsert keeps id/owner/share/policy, supersedes token", () => {
  const first = upsertAccount([], { ...acct({ scope: "private" }), id: undefined } as never, 5);
  assert.match(first.account.id, /^[0-9a-f]{8}$/);
  const shared = { ...first.account, share: { scope: "instance" } as ShareScope, policy: "autonomous" as const };
  const again = upsertAccount([shared], { ...acct({ scope: "private" }), token: "new", label: "Ann B", connectedVia: "bob", expiresAt: 99 }, 7);
  assert.equal(again.list.length, 1);
  assert.equal(again.account.id, first.account.id);
  assert.deepEqual(again.account.share, { scope: "instance" });
  assert.equal(again.account.policy, "autonomous");
  assert.equal(again.account.owner, "ann");
  assert.equal(again.account.token, "new");
  assert.equal(again.account.label, "Ann B");
  assert.equal(again.account.connectedVia, "bob");
  assert.equal(again.account.expiresAt, 99);
});

test("resolveAccountId", () => {
  const l = [{ ...acct({ scope: "private" }), id: "ab12cd34" }, { ...acct({ scope: "private" }), id: "ab99cd34" }, { ...acct({ scope: "private" }), id: "ab12" }];
  assert.equal((resolveAccountId(l, "ab12") as ConnectedAccount).id, "ab12");
  assert.equal(resolveAccountId(l, "ab9") === l[1], true);
  assert.equal(resolveAccountId(l, "ab"), "ambiguous");
  assert.equal(resolveAccountId(l, ""), "none");
  assert.equal(resolveAccountId(l, "  "), "none");
  assert.equal(resolveAccountId(l, "zz"), "none");
});

test("publicView drops secrets", () => {
  const v = publicView({ ...acct({ scope: "private" }), refreshToken: "r" });
  assert.ok(!("token" in v));
  assert.ok(!("refreshToken" in v));
  assert.equal(v.label, "Ann");
});

test("store: missing/garbage -> [], save is atomic 600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-"));
  const file = path.join(dir, "sub", "x.json");
  assert.deepEqual(loadAccountsStore(file), []);
  saveAccountsStore(file, [acct({ scope: "private" })]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(loadAccountsStore(file).length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["x.json"]);
  fs.writeFileSync(file, "{nope");
  assert.deepEqual(loadAccountsStore(file), []);
  fs.rmSync(dir, { recursive: true });
});
