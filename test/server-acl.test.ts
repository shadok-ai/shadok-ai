import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visibleChannels,
  viewerFor,
  memberGroupIds,
  canWriteSecretGroup,
  mergeGroupsPut,
  groupsPutFlow,
  MAIN_GROUP_ID,
  type Group,
} from "../src/groups.js";
import {
  visibleSecrets,
  secretOwnerGroup,
  secretWriteDecision,
  type Vault,
  type SecretEntry,
} from "../src/secrets.js";
import type { Channel } from "../src/channels.js";

// ── Fixtures: COMEX, RH and SALES as restricted groups + the Main commons ──────
const groups: Group[] = [
  { id: "main", name: "main", nature: "public", members: [], createdAt: 0 },
  { id: "comex", name: "COMEX", nature: "restricted", members: ["ada"], createdAt: 0 },
  { id: "rh", name: "RH", nature: "restricted", members: ["bob"], createdAt: 0 },
  { id: "sales", name: "SALES", nature: "restricted", members: ["cy"], createdAt: 0 },
];
const ada = { name: "ada", role: "member" as const }; // COMEX
const bob = { name: "bob", role: "member" as const }; // RH
const cy = { name: "cy", role: "member" as const }; // SALES
const admin = { name: "root", role: "admin" as const };

const ch = (sessionId: string, group: string | null): Channel =>
  ({ sessionId, name: sessionId, group } as Channel);

const e = (value: string, ownerGroup: string, sharedWith: string[] = []): SecretEntry => ({
  value, ownerGroup, sharedWith, profiles: [], createdBy: "u", createdAt: 1, updatedAt: 1,
});

// ── GET /channels filter (Review Focus #2) ─────────────────────────────────────
test("GET /channels: a COMEX member sees COMEX + public, never RH's", () => {
  const channels = [ch("x", "comex"), ch("y", "rh"), ch("z", null), ch("p", "main")];
  const seen = visibleChannels(channels, groups, viewerFor(ada)).map((c) => c.sessionId);
  assert.deepEqual(seen.sort(), ["p", "x", "z"]); // comex (own) + main + group-less; NOT rh
});

test("GET /channels: a deleted account (null viewer) gets only public/commons, not a 500 (Review Focus #3)", () => {
  const channels = [ch("x", "comex"), ch("y", "rh"), ch("z", null), ch("p", "main")];
  const seen = visibleChannels(channels, groups, viewerFor(null)).map((c) => c.sessionId);
  assert.deepEqual(seen.sort(), ["p", "z"]); // only public group + group-less
});

// ── GET /secrets tagging (own + shared-in + Main), names only ──────────────────
test("GET /secrets: a SALES caller omits COMEX-only names, keeps shared-in + Main, tagged by source", () => {
  const vault: Vault = {
    main: { COMMON: e("m", "main") },
    comex: { COMEX_ONLY: e("c", "comex"), LENT: e("l", "comex", ["sales"]) },
    sales: { SALES_OWN: e("s", "sales") },
  };
  const seen = visibleSecrets(vault, memberGroupIds(groups, viewerFor(cy)));
  assert.deepEqual(seen.map(({ name, source, ownerGroup }) => ({ name, source, ...(ownerGroup ? { ownerGroup } : {}) })), [
    { name: "COMMON", source: "main" },
    { name: "LENT", source: "shared", ownerGroup: "comex" },
    { name: "SALES_OWN", source: "own", ownerGroup: "sales" },
  ]);
  // COMEX_ONLY never leaks to SALES.
  assert.ok(!seen.some((s) => s.name === "COMEX_ONLY"));
});

test("GET /secrets: own beats shared beats main on a name present several ways", () => {
  const vault: Vault = {
    main: { K: e("m", "main") },
    comex: { K: e("own", "comex"), J: e("ownj", "comex") },
    rh: { K: e("shared", "rh", ["comex"]) },
  };
  const seen = visibleSecrets(vault, memberGroupIds(groups, viewerFor(ada)));
  assert.deepEqual(
    seen.filter((s) => s.name === "K").map(({ name, source, ownerGroup }) => ({ name, source, ownerGroup }))[0],
    { name: "K", source: "own", ownerGroup: "comex" },
  );
});

test("GET /secrets: a null viewer resolves to Main only (mono-tenant shape)", () => {
  const vault: Vault = { main: { A: e("a", "main") }, comex: { C: e("c", "comex") } };
  assert.deepEqual(
    visibleSecrets(vault, memberGroupIds(groups, viewerFor(null))).map(({ name, source }) => ({ name, source })),
    [{ name: "A", source: "main" }],
  );
  // Metadata rides along; the value never does.
  const [only] = visibleSecrets(vault, memberGroupIds(groups, viewerFor(null)));
  assert.ok(!("value" in only) && typeof only.createdAt === "number");
});

// ── Secret WRITE gate (owner-group membership) ─────────────────────────────────
test("canWriteSecretGroup: private → owner only; restricted/Main → admin", () => {
  const priv: Group = { id: "p", name: "P", nature: "private", members: [], owner: "ada", createdAt: 0 };
  assert.equal(canWriteSecretGroup(priv, ada), true);
  assert.equal(canWriteSecretGroup(priv, bob), false);
  assert.equal(canWriteSecretGroup(priv, admin), false); // an admin is NOT the owner
  const comex = groups[1];
  assert.equal(canWriteSecretGroup(comex, admin), true);
  assert.equal(canWriteSecretGroup(comex, ada), false); // a plain member cannot write
  assert.equal(canWriteSecretGroup(null, admin), false); // unresolvable → fail closed
  assert.equal(canWriteSecretGroup(comex, null), false);
});

test("secretOwnerGroup: agent lands in its OWN channel group; browser via spawnGroupFor; client body ignored", () => {
  // Agent in COMEX → COMEX, regardless of any client-claimed group.
  assert.equal(secretOwnerGroup({ agentGroupId: "comex", viewer: admin, groups }), "comex");
  // Agent with no group → Main.
  assert.equal(secretOwnerGroup({ agentGroupId: null, viewer: admin, groups }), MAIN_GROUP_ID);
  // Browser member of exactly one group → that group.
  assert.equal(secretOwnerGroup({ viewer: ada, groups }), "comex");
  // Browser member of nothing → the commons.
  assert.equal(secretOwnerGroup({ viewer: admin, groups }), MAIN_GROUP_ID);
});

test("secretWriteDecision: an agent in COMEX may write there (bootstrap admin); a plain member may not", () => {
  const agent = secretWriteDecision({ agentGroupId: "comex", viewer: admin, groups });
  assert.deepEqual(agent, { ok: true, ownerGroup: "comex" });
  const member = secretWriteDecision({ viewer: ada, groups }); // browser member → own COMEX, not admin
  assert.equal(member.ok, false);
});

test("secretWriteDecision: mono-tenant (bootstrap admin, no groups) resolves to Main and is allowed", () => {
  assert.deepEqual(secretWriteDecision({ agentGroupId: null, viewer: admin, groups: [] }), {
    ok: true,
    ownerGroup: MAIN_GROUP_ID,
  });
});

// ── PUT /groups: browser-only + admin-gated membership/nature ──────────────────
test("groupsPutFlow: a non-browser (agent) is refused 403", () => {
  const r = groupsPutFlow({ fromBrowser: false, instanceOk: true, isAdmin: true, stored: groups, incoming: [] });
  assert.equal(r.status, 403);
});

test("mergeGroupsPut: a non-admin cosmetic PUT preserves membership/nature (no silent wipe)", () => {
  // The client sends cosmetic-only rows (no members/nature) — COMEX must stay restricted.
  const cosmetic = [{ id: "comex", name: "COMEX renamed", collapsed: true }, { id: "main", name: "main" }];
  const r = mergeGroupsPut(groups, cosmetic, false);
  assert.ok(r.ok);
  const comex = (r as { groups: Group[] }).groups.find((g) => g.id === "comex")!;
  assert.equal(comex.nature, "restricted");
  assert.deepEqual(comex.members, ["ada"]);
  assert.equal(comex.name, "COMEX renamed");
  // RH and SALES were omitted but are real groups → preserved, never deleted.
  const ids = (r as { groups: Group[] }).groups.map((g) => g.id).sort();
  assert.deepEqual(ids, ["comex", "main", "rh", "sales"]);
});

test("mergeGroupsPut: a non-admin changing membership is REFUSED", () => {
  const r = mergeGroupsPut(groups, [{ id: "comex", nature: "restricted", members: ["ada", "mallory"] }], false);
  assert.equal(r.ok, false);
});

test("mergeGroupsPut: an admin MAY change membership", () => {
  const r = mergeGroupsPut(groups, [{ id: "comex", members: ["ada", "newbie"] }], true);
  assert.ok(r.ok);
  assert.deepEqual((r as { groups: Group[] }).groups.find((g) => g.id === "comex")!.members, ["ada", "newbie"]);
});

test("mergeGroupsPut: a new non-public group via PUT is refused (use POST /groups)", () => {
  const r = mergeGroupsPut(groups, [{ id: "new", nature: "private" }], true);
  assert.equal(r.ok, false);
});

test("mergeGroupsPut: a new PUBLIC cosmetic group is accepted", () => {
  const r = mergeGroupsPut(groups, [{ id: "tab9", name: "Tab 9" }], false);
  assert.ok(r.ok);
  const g = (r as { groups: Group[] }).groups.find((x) => x.id === "tab9")!;
  assert.equal(g.nature, "public");
  assert.deepEqual(g.members, []);
});

// ── Mono-tenant: everything is Main → the filters are no-ops ───────────────────
test("mono-tenant: no groups + null-group channels are fully visible to everyone", () => {
  const channels = [ch("a", null), ch("b", null)];
  // No groups at all; even a null viewer sees every group-less channel.
  assert.deepEqual(visibleChannels(channels, [], viewerFor(null)).map((c) => c.sessionId), ["a", "b"]);
  // A bootstrap-admin viewer sees them too.
  assert.deepEqual(visibleChannels(channels, [], viewerFor(admin)).map((c) => c.sessionId), ["a", "b"]);
});
