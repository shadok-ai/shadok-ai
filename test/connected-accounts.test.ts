import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accountEditVerdict,
  accountVisible,
  commonsGroupIds,
  normalizeShare,
  profileAllowed,
  defaultShare,
  loadAccountsStore,
  publicView,
  googlePolicies,
  resolveAccountId,
  saveAccountsStore,
  upsertAccount,
  type ConnectedAccount,
  type ShareScope,
  GOOGLE_AREA_SCOPES,
  accountDeadline,
  accountLapsed,
  agentAccountView,
  grantedAreas,
  patchRaisesAutonomy,
  policyPatch,
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
  // Main named as a group IS the Public tier (a public group folds into it),
  // so it reaches the owner's own Personal group too — exactly like `instance`.
  main: {
    owner: true, memberG1: true, nonMember: true, admin: true,
    agentOwnerPrivate: true, agentG1: false, agentMain: true, agentCommons: true, agentOtherPrivate: false, agentG2: false,
  },
  instance: {
    owner: true, memberG1: true, nonMember: true, admin: true,
    agentOwnerPrivate: true, agentG1: false, agentMain: true, agentCommons: true, agentOtherPrivate: false, agentG2: false,
  },
};
const sh = (o: Partial<ShareScope>): ShareScope => ({ personal: false, groups: [], everyone: false, profiles: [], ...o });
const shares: Record<string, ShareScope> = {
  private: sh({ personal: true }),
  g1: sh({ groups: ["g1"] }),
  main: sh({ groups: ["main"] }),
  instance: sh({ everyone: true }),
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
  const a = acct(sh({ personal: true }));
  assert.equal(accountEditVerdict(a, viewers.owner, "reconnect").ok, true);
  assert.equal(accountEditVerdict(a, viewers.owner, "policy", { policy: "autonomous" }).ok, true);
  assert.equal(accountEditVerdict(a, viewers.admin, "disconnect").ok, true);
  const p = accountEditVerdict(a, viewers.admin, "policy", { policy: "autonomous" });
  assert.equal(p.ok, false);
  assert.equal(accountEditVerdict(a, viewers.admin, "share", { share: sh({ everyone: true }) }).ok, false);
  assert.equal(accountEditVerdict(a, viewers.memberG1, "disconnect").ok, false);
  assert.equal(accountEditVerdict(a, viewers.agentOwnerPrivate, "disconnect").ok, false);
  assert.equal(accountEditVerdict(a, null, "disconnect").ok, false);
  const ok = (o: Partial<ShareScope>, profiles: string[] | null = null) =>
    accountEditVerdict(a, viewers.owner, "share", { share: sh(o) }, groups, profiles);
  assert.equal(ok({ groups: ["g1"] }).ok, true);
  assert.equal(ok({ personal: true, groups: ["g1", "main"], everyone: true }).ok, true, "tiers combine");
  assert.equal(ok({}).ok, true, "nothing ticked: no agent may use it, the owner still sees it");
  assert.equal(ok({ groups: ["g2"] }).ok, false);
  assert.equal(ok({ groups: ["nope"] }).ok, false);
  assert.equal(ok({ groups: ["p-cat"] }).ok, false, "someone else's Personal group");
  assert.equal(ok({ profiles: ["Writer"] }, ["Writer", "Dev"]).ok, true);
  assert.equal(ok({ profiles: ["Ghost"] }, ["Writer"]).ok, false, "an unknown profile");
});

test("normalizeShare: v1 shapes keep their reach, the owner's Personal folds in", () => {
  assert.deepEqual(normalizeShare({ scope: "private" }), sh({ personal: true }));
  assert.deepEqual(normalizeShare({ scope: "instance" }), sh({ everyone: true }));
  assert.deepEqual(normalizeShare({ scope: "groups", groups: ["g1", "g1"] }), sh({ groups: ["g1"] }));
  assert.deepEqual(normalizeShare({ scope: "groups", groups: ["p-ann", "g1"] }, "p-ann"), sh({ personal: true, groups: ["g1"] }));
  assert.deepEqual(normalizeShare({ personal: true, everyone: true, profiles: ["W", "W"] }), sh({ personal: true, everyone: true, profiles: ["W"] }));
  assert.equal(normalizeShare({ scope: "nope" }), null);
  assert.equal(normalizeShare({ groups: "g1" }), null);
  assert.equal(normalizeShare(null), null);
});

test("a v1 share in the store loads as the current shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-v1-"));
  const file = path.join(dir, "a.json");
  fs.writeFileSync(file, JSON.stringify([{ ...acct(sh({})), share: { scope: "instance" } }]));
  assert.deepEqual(loadAccountsStore(file)[0].share, sh({ everyone: true }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a public group named in a share IS the Public tier (server and client agree)", () => {
  const withPub = [...groups, g("pub", "public", [])];
  assert.deepEqual(normalizeShare({ scope: "groups", groups: ["pub", "g1"] }, null, new Set(["main", "pub"])), sh({ everyone: true, groups: ["g1"] }));
  assert.deepEqual(normalizeShare({ scope: "groups", groups: ["main"] }), sh({ everyone: true }));
  // Stored unfolded, read folded: a Main agent sees it, exactly as the Public chip says.
  const a = acct(sh({ groups: ["pub"] }));
  assert.equal(accountVisible(a, viewers.agentMain, withPub, noPeer), true);
  assert.equal(accountVisible(a, viewers.agentG2, withPub, noPeer), false);
});

test("edit verdict checks only what the edit ADDS: a deleted profile or group does not block later edits", () => {
  const a = acct(sh({ groups: ["gone"], profiles: ["Ghost"] }));
  assert.equal(accountEditVerdict(a, viewers.owner, "share", { share: sh({ groups: ["gone"], profiles: ["Ghost"], personal: true }) }, groups, ["Writer"]).ok, true);
  assert.equal(accountEditVerdict(a, viewers.owner, "share", { share: sh({ groups: ["gone"], profiles: ["Ghost", "Nope"] }) }, groups, ["Writer"]).ok, false);
});

test("defaultShare: each call is a fresh object", () => {
  const x = defaultShare();
  x.groups.push("g1");
  assert.deepEqual(defaultShare().groups, []);
});

test("tiers are a union: Personal + g1 reaches both, and nothing else", () => {
  const a = acct(sh({ personal: true, groups: ["g1"] }));
  assert.equal(accountVisible(a, viewers.agentOwnerPrivate, groups, noPeer), true);
  assert.equal(accountVisible(a, viewers.agentG1, groups, noPeer), true);
  assert.equal(accountVisible(a, viewers.agentMain, groups, noPeer), false);
  assert.equal(accountVisible(a, viewers.agentG2, groups, noPeer), false);
  // Everyone + g1: the commons AND a restricted group Everyone alone never reaches.
  const b = acct(sh({ everyone: true, groups: ["g1"] }));
  assert.equal(accountVisible(b, viewers.agentG1, groups, noPeer), true);
  assert.equal(accountVisible(b, viewers.agentMain, groups, noPeer), true);
  assert.equal(accountVisible(b, viewers.agentOtherPrivate, groups, noPeer), false);
  // Nothing ticked: no agent, the owner still manages it.
  const none = acct(sh({}));
  for (const k of Object.keys(viewers).filter((k) => k.startsWith("agent"))) assert.equal(accountVisible(none, viewers[k], groups, noPeer), false, k);
  assert.equal(accountVisible(none, viewers.owner, groups, noPeer), true);
});

test("profile filter: narrows agents (even unwalled), never people", () => {
  const a = acct(sh({ everyone: true, profiles: ["Writer"] }));
  assert.equal(accountVisible(a, viewers.agentMain, groups, { ...noPeer, agentProfile: "Writer" }), true);
  assert.equal(accountVisible(a, viewers.agentMain, groups, { ...noPeer, agentProfile: "Dev" }), false);
  assert.equal(accountVisible(a, viewers.agentMain, groups, { ...noPeer, agentProfile: null }), false, "no profile is not every profile");
  assert.equal(accountVisible(a, viewers.agentMain, groups, { ...noPeer, agentsUnwalled: true, agentProfile: "Dev" }), false);
  assert.equal(accountVisible(a, viewers.agentMain, groups, { ...noPeer, agentsUnwalled: true, agentProfile: "Writer" }), true);
  assert.equal(accountVisible(a, viewers.nonMember, groups, noPeer), true, "a person is not filtered by profile");
  // The filter never widens: the right profile in the wrong group stays out.
  assert.equal(accountVisible(a, viewers.agentG2, groups, { ...noPeer, agentProfile: "Writer" }), false);
  assert.equal(profileAllowed(sh({}), null), true);
});

test("upsert keeps id/owner/share/policy, supersedes token", () => {
  const first = upsertAccount([], { ...acct(sh({ personal: true })), id: undefined } as never, 5);
  assert.match(first.account.id, /^[0-9a-f]{8}$/);
  const shared = { ...first.account, share: sh({ everyone: true }), policy: "autonomous" as const };
  const again = upsertAccount([shared], { ...acct(sh({ personal: true })), token: "new", label: "Ann B", connectedVia: "bob", expiresAt: 99 }, 7);
  assert.equal(again.list.length, 1);
  assert.equal(again.account.id, first.account.id);
  assert.deepEqual(again.account.share, sh({ everyone: true }));
  assert.equal(again.account.policy, "autonomous");
  assert.equal(again.account.owner, "ann");
  assert.equal(again.account.token, "new");
  assert.equal(again.account.label, "Ann B");
  assert.equal(again.account.connectedVia, "bob");
  assert.equal(again.account.expiresAt, 99);
});

test("resolveAccountId", () => {
  const l = [{ ...acct(sh({ personal: true })), id: "ab12cd34" }, { ...acct(sh({ personal: true })), id: "ab99cd34" }, { ...acct(sh({ personal: true })), id: "ab12" }];
  assert.equal((resolveAccountId(l, "ab12") as ConnectedAccount).id, "ab12");
  assert.equal(resolveAccountId(l, "ab9") === l[1], true);
  assert.equal(resolveAccountId(l, "ab"), "ambiguous");
  assert.equal(resolveAccountId(l, ""), "none");
  assert.equal(resolveAccountId(l, "  "), "none");
  assert.equal(resolveAccountId(l, "zz"), "none");
});

test("publicView drops secrets", () => {
  const v = publicView({ ...acct(sh({ personal: true })), refreshToken: "r" });
  assert.ok(!("token" in v));
  assert.ok(!("refreshToken" in v));
  assert.equal(v.label, "Ann");
});

test("store: missing/garbage -> [], save is atomic 600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-"));
  const file = path.join(dir, "sub", "x.json");
  assert.deepEqual(loadAccountsStore(file), []);
  saveAccountsStore(file, [acct(sh({ personal: true }))]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(loadAccountsStore(file).length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["x.json"]);
  fs.writeFileSync(file, "{nope");
  assert.deepEqual(loadAccountsStore(file), []);
  fs.rmSync(dir, { recursive: true });
});

// C1: a mono-tenant instance has no private groups and every agent's group is
// null, so a freshly connected (private) account was invisible to every agent.
test("agentsUnwalled: an agent sees every account whatever the share scope", () => {
  const unwalled = { peerBox: null, agentsUnwalled: true };
  for (const s of Object.values(shares)) {
    assert.equal(accountVisible(acct(s), agent(null), [], unwalled), true, JSON.stringify(s));
    assert.equal(accountVisible(acct(s), agent(null), groups, unwalled), true, JSON.stringify(s));
    assert.equal(accountVisible(acct(s), agent("g2"), groups, unwalled), true, JSON.stringify(s));
  }
});

test("agentsUnwalled: a peer box still never sees, nor does a null viewer", () => {
  for (const s of Object.values(shares)) {
    assert.equal(accountVisible(acct(s), agent(null), [], { peerBox: "box", agentsUnwalled: true }), false);
    assert.equal(accountVisible(acct(s), null, [], { peerBox: null, agentsUnwalled: true }), false);
  }
});

test("agentsUnwalled leaves person visibility unchanged", () => {
  for (const [sk, row] of Object.entries(matrix)) {
    for (const vk of ["owner", "memberG1", "nonMember", "admin"]) {
      assert.equal(accountVisible(acct(shares[sk]), viewers[vk], groups, { peerBox: null, agentsUnwalled: true }), row[vk], `${sk} x ${vk}`);
    }
  }
});

test("agentsUnwalled false is the walled matrix (multi-tenant unchanged)", () => {
  for (const [sk, row] of Object.entries(matrix)) {
    for (const [vk, expected] of Object.entries(row)) {
      assert.equal(accountVisible(acct(shares[sk]), viewers[vk], groups, { peerBox: null, agentsUnwalled: false }), expected, `${sk} x ${vk}`);
    }
  }
  assert.equal(accountVisible(acct(sh({ personal: true })), agent(null), [], { peerBox: null, agentsUnwalled: false }), false);
});

// ---- Google accounts -----------------------------------------------------

const gacct = (o: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: "g0000001", provider: "google", kind: "member", label: "ann@example.org", externalId: "sub-1", owner: "ann", connectedVia: "ann",
  share: sh({ personal: true }), policy: "approve", policies: { mail: "approve", calendar: "approve", drive: "approve" },
  scopes: ["openid", GOOGLE_AREA_SCOPES.calendar, GOOGLE_AREA_SCOPES.gmail], token: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET",
  expiresAt: 1_000, refreshExpiresAt: 900_000, createdAt: 1, updatedAt: 1, ...o,
});

test("the deadline of a Google account is its REFRESH token's — the hourly access token never expires the account", () => {
  assert.equal(accountDeadline(gacct()), 900_000);
  assert.equal(accountLapsed(gacct(), 5_000), false, "past the access token's expiry, well before the refresh token's");
  assert.equal(accountLapsed(gacct(), 900_000), true);
  assert.equal(accountLapsed(gacct({ status: "expired" }), 5), true);
  // No known deadline (an app out of Testing): never lapses by date.
  assert.equal(accountDeadline(gacct({ refreshExpiresAt: undefined })), null);
  assert.equal(accountLapsed(gacct({ refreshExpiresAt: undefined }), Number.MAX_SAFE_INTEGER), false);
  // LinkedIn is unchanged: expiresAt IS the deadline.
  assert.equal(accountDeadline(acct(sh({ personal: true }))), 9);
});

test("granted areas are read from the scopes Google returned, never assumed", () => {
  assert.deepEqual(grantedAreas(gacct()), ["calendar", "gmail"]);
  assert.deepEqual(grantedAreas(gacct({ scopes: undefined })), []);
  assert.deepEqual(grantedAreas(gacct({ scopes: ["https://www.googleapis.com/auth/drive"] })), ["drive_all"], "the whole-Drive scope is its own area, never read as drive.file");
  assert.deepEqual(grantedAreas(gacct({ scopes: [GOOGLE_AREA_SCOPES.drive] })), ["drive"], "…and drive.file never as the whole Drive");
});

test("a new Google account starts with both settings on approve; a reconnect keeps them and refreshes scopes and tokens", () => {
  const { policies: _p, ...incoming } = gacct();
  void _p;
  const first = upsertAccount([], incoming, 5);
  assert.deepEqual(first.account.policies, { mail: "approve", calendar: "approve", drive: "approve" });
  const chosen = { ...first.account, policies: { mail: "autonomous" as const, calendar: "approve" as const, drive: "approve" as const }, share: sh({ everyone: true }) };
  const again = upsertAccount([chosen], { ...incoming, token: "NEW", refreshToken: "NEW-R", scopes: ["openid", GOOGLE_AREA_SCOPES.drive], refreshExpiresAt: 2_000_000 }, 9);
  assert.equal(again.list.length, 1);
  assert.equal(again.account.id, first.account.id);
  assert.deepEqual(again.account.policies, { mail: "autonomous", calendar: "approve", drive: "approve" }, "a reconnect never resets a setting");
  assert.equal(again.account.share.everyone, true);
  assert.deepEqual(again.account.scopes, ["openid", GOOGLE_AREA_SCOPES.drive]);
  assert.equal(again.account.token, "NEW");
  assert.equal(again.account.refreshToken, "NEW-R");
  assert.equal(again.account.refreshExpiresAt, 2_000_000);
  // A LinkedIn account never grows the Google field.
  assert.equal("policies" in upsertAccount([], acct(sh({ personal: true })), 1).account, false);
});

test("what an agent is told about an account carries no token, and the deadline rather than the access expiry", () => {
  const v = agentAccountView(gacct(), 5_000);
  assert.deepEqual(v, {
    id: "g0000001", label: "ann@example.org", provider: "google", kind: "member",
    policies: { mail: "approve", calendar: "approve", drive: "approve" }, areas: ["calendar", "gmail"], expiresAt: 900_000, status: "ok",
  });
  assert.doesNotMatch(JSON.stringify(v), /SECRET|token|scopes/i);
  const li = agentAccountView(acct(sh({ personal: true })), 5);
  assert.deepEqual(li, { id: "abcd1234", label: "Ann", provider: "linkedin", kind: "member", policy: "approve", expiresAt: 9, status: "ok" });
  assert.doesNotMatch(JSON.stringify(publicView(gacct())), /SECRET/);
});

test("policy patch: Google takes policies.mail / policies.calendar one at a time; LinkedIn takes policy; neither takes the other's", () => {
  assert.deepEqual(policyPatch(gacct(), { policies: { mail: "autonomous" } }), { ok: true, patch: { policies: { mail: "autonomous", calendar: "approve", drive: "approve" } } });
  assert.deepEqual(policyPatch(gacct({ policies: { mail: "autonomous", calendar: "approve", drive: "approve" } }), { policies: { calendar: "autonomous", drive: "approve" } }), {
    ok: true, patch: { policies: { mail: "autonomous", calendar: "autonomous", drive: "approve" } },
  });
  assert.equal(policyPatch(gacct(), { policy: "autonomous" }).ok, false, "a Google account never reads `policy`");
  assert.equal(policyPatch(gacct(), { policies: { mail: "always" } }).ok, false);
  assert.deepEqual(policyPatch(gacct(), { policies: { drive: "autonomous" } }), { ok: true, patch: { policies: { mail: "approve", calendar: "approve", drive: "autonomous" } } });
  assert.equal(policyPatch(gacct(), { policies: { files: "autonomous" } }).ok, false, "there is no fourth setting");
  // An account stored before the Drive setting existed: the missing key reads as approve.
  const old = gacct({ policies: { mail: "autonomous", calendar: "approve" } as never });
  assert.deepEqual(googlePolicies(old), { mail: "autonomous", calendar: "approve", drive: "approve" });
  assert.deepEqual(policyPatch(old, { policies: { calendar: "autonomous" } }), { ok: true, patch: { policies: { mail: "autonomous", calendar: "autonomous", drive: "approve" } } });
  assert.equal(patchRaisesAutonomy(old, { policies: { mail: "autonomous", calendar: "approve", drive: "autonomous" } }), true, "switching Drive edits to automatic is the owner's alone");
  assert.equal(publicView(old).policies?.drive, "approve");
  assert.equal(policyPatch(gacct(), { policies: {} }).ok, false);
  assert.equal(policyPatch(gacct(), { policies: [] }).ok, false);
  assert.deepEqual(policyPatch(gacct(), {}), { ok: true, patch: null });
  const li = acct(sh({ personal: true }));
  assert.deepEqual(policyPatch(li, { policy: "autonomous" }), { ok: true, patch: { policy: "autonomous" } });
  assert.equal(policyPatch(li, { policies: { mail: "autonomous" } }).ok, false);
  assert.equal(policyPatch(li, { policy: "yes" }).ok, false);
});

test("switching a setting to automatic is the owner's alone — never an admin on someone else's account", () => {
  const a = gacct();
  assert.equal(patchRaisesAutonomy(a, { policies: { mail: "autonomous", calendar: "approve", drive: "approve" } }), true);
  assert.equal(patchRaisesAutonomy(a, { policies: { mail: "approve", calendar: "autonomous", drive: "approve" } }), true);
  assert.equal(patchRaisesAutonomy(gacct({ policies: { mail: "autonomous", calendar: "approve", drive: "approve" } }), { policies: { mail: "approve", calendar: "approve", drive: "approve" } }), false, "back to approve raises nothing");
  assert.equal(accountEditVerdict(a, person("ann"), "policy", { policy: "autonomous" }, groups).ok, true);
  assert.equal(accountEditVerdict(a, person("bob", "admin"), "policy", { policy: "autonomous" }, groups).ok, false);
  assert.equal(accountEditVerdict(a, person("bob", "admin"), "policy", { policy: "approve" }, groups).ok, false, "nor may an admin change it back");
  assert.equal(accountEditVerdict(a, agent("p-ann"), "policy", { policy: "autonomous" }, groups).ok, false, "an agent never changes a setting");
});
