import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrationPlan,
  runMigration,
  respawnPlan,
  commonsOsUser,
  COMMONS_USER,
  type MigrationPlan,
  type MigrationDeps,
} from "../src/migrate-groups.js";
import type { Group } from "../src/groups.js";

const G = (id: string, nature: Group["nature"]): Group => ({
  id,
  name: id,
  nature,
  members: [],
  osUser: null,
  createdAt: 0,
});

// ─── migrationPlan (pure) ─────────────────────────────────────────────────────

test("migrationPlan: null in mono-tenant (a non-capable install is not migrated)", () => {
  assert.equal(
    migrationPlan({ alreadyMigrated: false, mode: "mono-tenant", accounts: ["ada"], existingGroups: [] }),
    null,
  );
});

test("migrationPlan: null when already migrated (idempotent — second call → null)", () => {
  assert.equal(
    migrationPlan({ alreadyMigrated: true, mode: "multi-tenant", accounts: ["ada"], existingGroups: [] }),
    null,
  );
});

test("migrationPlan: capable + fresh lists one private group per account and sets every flag", () => {
  const plan = migrationPlan({
    alreadyMigrated: false,
    mode: "multi-tenant",
    accounts: ["ada", "bob", "ada"], // duplicate collapses
    existingGroups: [],
  });
  assert.ok(plan);
  const p = plan as MigrationPlan;
  assert.equal(p.createCommonsUser, true);
  assert.equal(p.chownTree, true);
  assert.equal(p.vaultToMain, true);
  assert.equal(p.labelExistingPublic, true);
  assert.deepEqual(p.provisionPrivatePerAccount, ["ada", "bob"]);
  assert.deepEqual(p.reprovisionGroups, []);
});

test("migrationPlan: lists persisted private/restricted groups to re-provision (docker-recreate carry)", () => {
  const plan = migrationPlan({
    alreadyMigrated: false,
    mode: "multi-tenant",
    accounts: [],
    existingGroups: [G("main", "public"), G("comex", "restricted"), G("ada-priv", "private"), G("cosmetic", "public")],
  });
  assert.ok(plan);
  // Only the private/restricted ones — public (commons/cosmetic) have no OS user.
  assert.deepEqual((plan as MigrationPlan).reprovisionGroups, ["comex", "ada-priv"]);
});

test("migrationPlan: blank/whitespace account names are dropped", () => {
  const plan = migrationPlan({
    alreadyMigrated: false,
    mode: "multi-tenant",
    accounts: ["ada", "", "   ", "bob"],
    existingGroups: [],
  });
  assert.deepEqual((plan as MigrationPlan).provisionPrivatePerAccount, ["ada", "bob"]);
});

// ─── commonsOsUser (pure) — the T5 carry: commons must not stay root ──────────

test("commonsOsUser: `main` only once migrated AND multi-tenant; null otherwise (fail-safe)", () => {
  assert.equal(commonsOsUser({ migrated: true, mode: "multi-tenant" }), COMMONS_USER);
  assert.equal(commonsOsUser({ migrated: false, mode: "multi-tenant" }), null);
  assert.equal(commonsOsUser({ migrated: true, mode: "mono-tenant" }), null);
  assert.equal(COMMONS_USER, "main");
});

// ─── respawnPlan (pure) ───────────────────────────────────────────────────────

test("respawnPlan: the running agents to respawn, deduped, order preserved", () => {
  assert.deepEqual(
    respawnPlan([
      { sessionId: "a" },
      { sessionId: "" },
      { sessionId: "b" },
      { sessionId: "a" }, // dup
      { sessionId: null },
      {},
    ]),
    ["a", "b"],
  );
});

// ─── runMigration (impure, injected deps) ─────────────────────────────────────

function recordingDeps(overrides: Partial<MigrationDeps> = {}): { deps: MigrationDeps; calls: string[]; logs: string[]; marker: { written: boolean } } {
  const calls: string[] = [];
  const logs: string[] = [];
  const marker = { written: false };
  const deps: MigrationDeps = {
    createCommonsUser: () => { calls.push("createCommonsUser"); },
    chownTreeToCommons: () => { calls.push("chownTree"); },
    seedSharedCredential: () => { calls.push("seedCredential"); },
    migrateVaultToMain: () => { calls.push("vault"); },
    provisionPrivateGroup: (a) => { calls.push(`provision:${a}`); },
    reprovisionGroup: (g) => { calls.push(`reprovision:${g}`); },
    labelExistingPublic: () => { calls.push("label"); },
    markerExists: () => marker.written,
    writeMarker: () => { marker.written = true; calls.push("writeMarker"); },
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, calls, logs, marker };
}

const FULL_PLAN: MigrationPlan = {
  createCommonsUser: true,
  chownTree: true,
  vaultToMain: true,
  provisionPrivatePerAccount: ["ada", "bob"],
  labelExistingPublic: true,
  reprovisionGroups: ["comex"],
};

test("runMigration: runs the steps in order and writes the marker last", async () => {
  const { deps, calls, marker } = recordingDeps();
  await runMigration(FULL_PLAN, deps);
  assert.deepEqual(calls, [
    "createCommonsUser",
    "chownTree",
    "seedCredential",
    "vault",
    "provision:ada",
    "provision:bob",
    "reprovision:comex",
    "label",
    "writeMarker",
  ]);
  assert.equal(marker.written, true);
});

test("runMigration: fail-safe — a non-core step failure logs, does not throw, marker still written", async () => {
  const { deps, calls, logs, marker } = recordingDeps({
    provisionPrivateGroup: (a) => { if (a === "ada") throw new Error("useradd boom"); },
  });
  await assert.doesNotReject(runMigration(FULL_PLAN, deps));
  assert.equal(marker.written, true, "a group-level failure must not block the marker");
  assert.ok(logs.some((l) => /ada/.test(l) && /FAIL/i.test(l)), "the failure is logged");
  // The marker is written LAST, so its presence proves later steps still ran.
  assert.ok(calls.includes("label") && calls.includes("writeMarker"), "later steps still run after a failure");
  void calls;
});

test("runMigration: a CORE step failure withholds the marker so the next boot retries", async () => {
  const { deps, marker, logs } = recordingDeps({
    chownTreeToCommons: () => { throw new Error("chown boom"); },
  });
  await assert.doesNotReject(runMigration(FULL_PLAN, deps));
  assert.equal(marker.written, false, "a core failure must leave the instance to retry (idempotent)");
  assert.ok(logs.some((l) => /withheld/i.test(l)));
});

test("runMigration: respawns the running agents one at a time (respawned, not re-adopted)", async () => {
  const respawned: string[] = [];
  const { deps } = recordingDeps({
    respawnIds: ["s1", "s2"],
    respawn: (ids) => { respawned.push(...ids); },
  });
  await runMigration(FULL_PLAN, deps);
  assert.deepEqual(respawned, ["s1", "s2"]);
});

// ─── server wiring: a source-scan lock (server.ts is un-importable) ──────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, "..", "src", "server.ts"), "utf8");

test("server: the migration is wired into boot after ensureSshIdentity and gated by mode", () => {
  assert.ok(/runMigration\s*\(/.test(SERVER), "runMigration is called in server.ts");
  assert.ok(/runGroupsMigration\s*\(\s*\)/.test(SERVER), "the boot wrapper is invoked");
  assert.ok(/DEPLOYMENT_MODE === "multi-tenant"/.test(SERVER), "the boot call is gated by DEPLOYMENT_MODE");
  // The BOOT invocation (the top-level `runGroupsMigration()` call, not its
  // definition) must come after the SSH identity is set up.
  const sshIdx = SERVER.indexOf("Object.assign(process.env, ensureSshIdentity());");
  const bootCall = SERVER.indexOf("void runGroupsMigration()");
  assert.ok(sshIdx !== -1 && bootCall !== -1, "both anchors present");
  assert.ok(bootCall > sshIdx, "the migration boot call runs after the SSH identity is set up");
});

test("server: commons spawns drop to the migrated `main` user (not root)", () => {
  assert.ok(/commonsOsUser\s*\(/.test(SERVER), "commonsOsUser is consulted at the spawn/restart path");
});
