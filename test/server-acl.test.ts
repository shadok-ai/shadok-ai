import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  // The never-leak-a-value invariant: EVERY returned row — own, shared-in and
  // inherited-from-Main alike — carries metadata but never the `value` key.
  // (This spans all three sources; checking one entry would hide a leak in
  // whichever source happened not to be first.)
  assert.equal(seen.length, 3);
  for (const s of seen) assert.ok(!("value" in s), `row ${s.name} must not carry value`);
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
test("canWriteSecretGroup: private → owner only; restricted → member OR admin; Main → admin", () => {
  const priv: Group = { id: "p", name: "P", nature: "private", members: [], owner: "ada", createdAt: 0 };
  assert.equal(canWriteSecretGroup(priv, ada), true);
  assert.equal(canWriteSecretGroup(priv, bob), false);
  assert.equal(canWriteSecretGroup(priv, admin), false); // an admin is NOT the owner
  const comex = groups[1]; // restricted, members: ["ada"]
  assert.equal(canWriteSecretGroup(comex, admin), true); // admin always
  assert.equal(canWriteSecretGroup(comex, ada), true); // a MEMBER co-owns the group's vault (Task 11)
  assert.equal(canWriteSecretGroup(comex, bob), false); // a non-member (member of RH) cannot write COMEX
  const main = groups[0]; // the commons: no members → admin-only, as before
  assert.equal(canWriteSecretGroup(main, admin), true);
  assert.equal(canWriteSecretGroup(main, ada), false); // a plain member cannot write Main
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

test("secretWriteDecision: an agent in COMEX may write there (bootstrap admin); a browser member of COMEX may too", () => {
  const agent = secretWriteDecision({ agentGroupId: "comex", viewer: admin, groups });
  assert.deepEqual(agent, { ok: true, ownerGroup: "comex" });
  // A browser member of exactly COMEX (omitted group → own COMEX) now co-owns
  // the group's vault (Task 11 — member-write), so this is allowed.
  const member = secretWriteDecision({ viewer: ada, groups });
  assert.deepEqual(member, { ok: true, ownerGroup: "comex" });
  // A browser member of RH, with no own group that is COMEX, cannot write COMEX.
  const foreign = secretWriteDecision({ requestedGroup: "comex", viewer: bob, groups });
  assert.equal(foreign.ok, false);
});

test("secretWriteDecision: mono-tenant (bootstrap admin, no groups) resolves to Main and is allowed", () => {
  assert.deepEqual(secretWriteDecision({ agentGroupId: null, viewer: admin, groups: [] }), {
    ok: true,
    ownerGroup: MAIN_GROUP_ID,
  });
});

// ── Task 11: a VALIDATED requested target group (server authorizes, never trusts) ──
test("secretOwnerGroup: a browser `requestedGroup` targets it; an agent's is IGNORED", () => {
  // Browser: the requested group becomes the target (authorized separately).
  assert.equal(secretOwnerGroup({ requestedGroup: "rh", viewer: admin, groups }), "rh");
  // Omitted → identity-derived own group (back-compat).
  assert.equal(secretOwnerGroup({ viewer: ada, groups }), "comex");
  // AGENT: a differing requested group is ignored — it writes ONLY its own group.
  assert.equal(secretOwnerGroup({ agentGroupId: "comex", requestedGroup: "rh", viewer: admin, groups }), "comex");
  // A blank/whitespace request falls back to the identity default.
  assert.equal(secretOwnerGroup({ requestedGroup: "   ", viewer: ada, groups }), "comex");
});

test("secretWriteDecision: a requested group must pass the SAME write gate (human)", () => {
  const priv: Group = { id: "p", name: "P", nature: "private", members: [], owner: "ada", createdAt: 0 };
  const g2 = [...groups, priv];
  // A member of G targeting G → OK.
  assert.deepEqual(secretWriteDecision({ requestedGroup: "comex", viewer: ada, groups }), { ok: true, ownerGroup: "comex" });
  // A non-member targeting G → refused (no write).
  assert.equal(secretWriteDecision({ requestedGroup: "comex", viewer: bob, groups }).ok, false);
  // An admin targeting a restricted G → OK.
  assert.deepEqual(secretWriteDecision({ requestedGroup: "rh", viewer: admin, groups }), { ok: true, ownerGroup: "rh" });
  // An admin targeting a PRIVATE G they do not own → refused (private is sealed).
  assert.equal(secretWriteDecision({ requestedGroup: "p", viewer: admin, groups: g2 }).ok, false);
  // The private owner targeting it → OK.
  assert.deepEqual(secretWriteDecision({ requestedGroup: "p", viewer: ada, groups: g2 }), { ok: true, ownerGroup: "p" });
  // A requested group that does not resolve → fail closed.
  assert.equal(secretWriteDecision({ requestedGroup: "ghost", viewer: admin, groups }).ok, false);
});

test("secretWriteDecision: an agent sending group:G2 writes ONLY its own G1 (request ignored)", () => {
  // Agent's channel is COMEX; a body group of RH must not aim RH's vault.
  assert.deepEqual(
    secretWriteDecision({ agentGroupId: "comex", requestedGroup: "rh", viewer: admin, groups }),
    { ok: true, ownerGroup: "comex" },
  );
  // Even requesting a private group it does not own: still only its own group.
  assert.deepEqual(
    secretWriteDecision({ agentGroupId: "comex", requestedGroup: "nonexistent", viewer: admin, groups }),
    { ok: true, ownerGroup: "comex" },
  );
});

// ── PUT /groups: browser-only + admin-gated membership/nature ──────────────────
test("groupsPutFlow: a non-browser (agent) is refused 403", () => {
  const r = groupsPutFlow({ fromBrowser: false, instanceOk: true, actor: "root", stored: groups, incoming: [] });
  assert.equal(r.status, 403);
});

test("mergeGroupsPut: a non-admin cosmetic PUT preserves membership/nature (no silent wipe)", () => {
  // The client sends cosmetic-only rows (no members/nature) — COMEX must stay restricted.
  const cosmetic = [{ id: "comex", name: "COMEX renamed", collapsed: true }, { id: "main", name: "main" }];
  const r = mergeGroupsPut(groups, cosmetic, "mallory");
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
  const r = mergeGroupsPut(groups, [{ id: "comex", nature: "restricted", members: ["ada", "mallory"] }], "mallory");
  assert.equal(r.ok, false);
});

test("mergeGroupsPut: a NON-member admin cannot change a restricted group's members/nature/owner", () => {
  for (const patch of [{ members: ["ada", "root"] }, { nature: "public" }, { owner: "root" }]) {
    assert.equal(mergeGroupsPut(groups, [{ id: "comex", ...patch }], "root").ok, false);
  }
  const f = groupsPutFlow({ fromBrowser: true, instanceOk: true, actor: "root", stored: groups, incoming: [{ id: "comex", members: ["root"] }] });
  assert.equal(f.status, 403);
  assert.equal(f.groups, undefined);
});

test("mergeGroupsPut: a non-member (admin or not) may still change cosmetics of a visible group", () => {
  for (const who of ["root", "mallory", null]) {
    const r = mergeGroupsPut(groups, [{ id: "comex", name: "Renamed", icon: "x" }], who);
    assert.ok(r.ok);
    const c = (r as { groups: Group[] }).groups.find((g) => g.id === "comex")!;
    assert.equal(c.name, "Renamed");
    assert.deepEqual(c.members, ["ada"]);
  }
});

test("mergeGroupsPut: a MEMBER may change membership", () => {
  const r = mergeGroupsPut(groups, [{ id: "comex", members: ["ada", "newbie"] }], "ada");
  assert.ok(r.ok);
  assert.deepEqual((r as { groups: Group[] }).groups.find((g) => g.id === "comex")!.members, ["ada", "newbie"]);
});

test("mergeGroupsPut: a new non-public group via PUT is refused (use POST /groups)", () => {
  const r = mergeGroupsPut(groups, [{ id: "new", nature: "private" }], "ada");
  assert.equal(r.ok, false);
});

test("mergeGroupsPut: a new PUBLIC cosmetic group is accepted", () => {
  const r = mergeGroupsPut(groups, [{ id: "tab9", name: "Tab 9" }], "mallory");
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

// ── Task 16: account lifecycle wiring — a source-scan lock (server.ts is
// un-importable at module load, like the migrate-groups wiring lock) ───────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, "..", "src", "server.ts"), "utf8");

test("server: redeeming an invite provisions the person's private group (multi-tenant only)", () => {
  // The hook exists, is DEPLOYMENT_MODE-gated, and is driven by the redeem handler.
  assert.ok(/ensurePrivateGroupProvisioned\s*\(/.test(SERVER), "the invite→provision hook is defined and called");
  const fn = SERVER.slice(SERVER.indexOf("async function ensurePrivateGroupProvisioned"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/DEPLOYMENT_MODE !== "multi-tenant"/.test(body), "no-op in mono-tenant (byte-for-byte today)");
  assert.ok(/privateGroupFor\(/.test(body), "idempotent: does not double-provision an existing private group");
  assert.ok(/newPrivateGroup\(/.test(body), "a NEW person gets a fresh private group");
  assert.ok(/osUserFor\(/.test(body), "the group's osUser is stamped before persist");
  assert.ok(/saveGroups\(/.test(body), "the group row is persisted (so boot reprovision can retry)");
  assert.ok(/provisionOsUserFor\(/.test(body), "the privileged OS-user provision is kicked");
  // Best-effort: a provision failure is caught (sign-in must not be blocked).
  assert.ok(/catch\b/.test(body), "a provision failure is caught, not thrown into the redeem");
  // The redeem handler must actually call the hook.
  const redeem = SERVER.slice(SERVER.indexOf('app.post("/invite/:token"'));
  const redeemBody = redeem.slice(0, redeem.indexOf("\n});\n"));
  assert.ok(/ensurePrivateGroupProvisioned\(/.test(redeemBody), "the redeem route invokes the hook");
});

test("server: DELETE /users cascades to tear down ONLY the person's private group", () => {
  const route = SERVER.slice(SERVER.indexOf('app.delete("/users"'));
  const body = route.slice(0, route.indexOf("\n});\n"));
  assert.ok(/accountDeleteGroups\(/.test(body), "the pure cascade decides what to tear down / what to keep");
  assert.ok(/teardownGroupUser\(/.test(body), "the private group's OS user + HOME are torn down");
  assert.ok(/killGroupAgents\(/.test(body), "its running agents are killed (T6 helper, needed here)");
  assert.ok(/saveGroups\(/.test(body), "the remaining group list (row removed, memberships dropped) is persisted");
  assert.ok(/DEPLOYMENT_MODE === "multi-tenant"/.test(body), "the cascade is multi-tenant only (mono no-op)");
  // The userdel warning is SURFACED, not swallowed.
  assert.ok(/warning/.test(body), "a teardown warning is surfaced to the admin");
  // No break-glass: the admin never reads the private group's contents — there is
  // no loadHistory / transcript read on the delete path.
  assert.ok(!/loadHistory/.test(body), "no break-glass: the private space is destroyed unread");
  // Explicit confirmation before the irreversible destruction.
  assert.ok(/confirm/.test(body), "an explicit confirmation gate guards the irreversible destroy");
});

test("server: DELETE /users removes the group row (saveGroups) BEFORE the teardown await — closes stale-save + reuse leak", () => {
  const route = SERVER.slice(SERVER.indexOf('app.delete("/users"'));
  const body = route.slice(0, route.indexOf("\n});\n"));
  // The cascade block: the row is persisted BEFORE `await teardownGroupUser(...)`.
  const cascade = body.slice(body.indexOf('DEPLOYMENT_MODE === "multi-tenant"'));
  const saveIdx = cascade.indexOf("saveGroups(");
  const teardownIdx = cascade.indexOf("await teardownGroupUser(");
  assert.ok(saveIdx >= 0, "the remaining group list is persisted");
  assert.ok(teardownIdx >= 0, "the private group's OS user is torn down");
  assert.ok(
    saveIdx < teardownIdx,
    "saveGroups MUST run before the teardown await (stale-save: a concurrent edit during userdel is not clobbered; " +
      "reuse-leak: no ownerless row survives a crash for a re-invite to match+reuse by owner)",
  );
  // The group list is re-read fresh for that save (invariant 6, not a pre-await snapshot).
  assert.ok(/accountDeleteGroups\(\s*name,\s*loadGroups\(\)\s*\)/.test(cascade), "the save re-reads loadGroups() fresh");
});

test("server: a boot reconciler re-provisions missing group OS users, INDEPENDENT of the migration marker", () => {
  assert.ok(/async function ensureGroupsProvisioned\s*\(/.test(SERVER), "the boot reconciler is defined");
  const fn = SERVER.slice(SERVER.indexOf("async function ensureGroupsProvisioned"));
  const fnBody = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/DEPLOYMENT_MODE !== "multi-tenant"/.test(fnBody), "no-op in mono-tenant");
  assert.ok(/reconcileGroupProvisioning\(/.test(fnBody), "it delegates to the pure/injected reconciler");
  assert.ok(/loadGroups\(\)/.test(fnBody), "it iterates the persisted group list");
  assert.ok(/osUserExists\b/.test(fnBody), "it reuses the existing OS-user probe");
  assert.ok(/provisionOsUserFor\b/.test(fnBody), "it (re)provisions via the idempotent provision helper");
  // Wired AFTER migration (boot + the post-sign-in retry share `maybeRunGroupsMigration`),
  // and NOT gated behind the migration marker: the reconciler runs on every capable
  // run. Inside the shared entry point, `ensureGroupsProvisioned` is awaited right
  // after `runGroupsMigration` resolves.
  const entry = SERVER.slice(SERVER.indexOf("async function maybeRunGroupsMigration"));
  const entryBody = entry.slice(0, entry.indexOf("\n}\n"));
  assert.ok(
    /await runGroupsMigration\(\);\s*\n\s*await ensureGroupsProvisioned\(\);/.test(entryBody),
    "ensureGroupsProvisioned runs AFTER runGroupsMigration resolves, in the shared entry point",
  );
});

test("server: migProvisionPrivateGroup uses newPrivateGroup (unified members:[name] shape — Minor #3)", () => {
  const fn = SERVER.slice(SERVER.indexOf("async function migProvisionPrivateGroup"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/newPrivateGroup\(/.test(body), "the migration creator shares newPrivateGroup with the invite hook");
  assert.ok(!/members:\s*\[\]/.test(body), "no more members:[] — the owner is listed as a member");
});

test("server: POST /groups/members is browser-only, instance-gated and decided by membershipVerdict", () => {
  const at = SERVER.indexOf('app.post("/groups/members"');
  assert.ok(at >= 0, "the membership route exists");
  const body = SERVER.slice(at, SERVER.indexOf("\n});\n", at));
  assert.ok(/requestFromBrowser\(req\)/.test(body), "browser-only: an agent carries the admin cookie");
  assert.ok(/channelWriteAllowed\(/.test(body), "instance-key gate");
  assert.ok(/canSeeGroup\(/.test(body), "an unseen group is 404, never fabricated");
  assert.ok(/membershipVerdict\([^)]*"invite"/.test(body), "add goes through the invite verdict");
  assert.ok(/membershipVerdict\([^)]*"remove"/.test(body), "remove goes through the remove verdict");
  assert.ok(!/isAdmin|role === "admin"/.test(body), "authority is membershipVerdict, not a bare admin check");
});

test("server: GET /accounts is a names-only roster for any signed-in account", () => {
  const at = SERVER.indexOf('app.get("/accounts"');
  assert.ok(at >= 0, "the roster route exists");
  const body = SERVER.slice(at, SERVER.indexOf("\napp.", at + 5));
  assert.ok(/currentAccount\(req\)/.test(body), "requires a signed-in caller");
  assert.ok(!/accountAdmin\(/.test(body), "a member may read it: not admin-only");
  assert.ok(/loadAccounts\(\)\.map\(\(a\) => a\.name\)/.test(body), "maps accounts to names");
  for (const leak of ["hash", "sessionsAfter", ".role", "passkeys"]) {
    assert.ok(!body.includes(leak), `names only: the handler never touches ${leak}`);
  }
});

test("ensureGroupsProvisioned: the capable boot gives the bootstrap admin a Personal group", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/server.ts"), "utf8");
  const start = src.indexOf("async function ensureGroupsProvisioned");
  assert.ok(start >= 0, "function exists");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("ensurePrivateGroupProvisioned(BOOTSTRAP_ADMIN)"), "provisions the operator's Personal group");
});

test("PUT /secrets refuses a reserved name before any write", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/server.ts"), "utf8");
  const start = src.indexOf('app.put("/secrets", (req, res)');
  const guard = src.indexOf("RESERVED_SECRET_NAMES.has(key)", start);
  const write = src.indexOf("setSecret(key", start);
  assert.ok(start > 0 && guard > start && write > guard, "reserved guard must precede setSecret in PUT /secrets");
});
