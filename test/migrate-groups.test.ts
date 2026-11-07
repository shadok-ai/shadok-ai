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
  rewriteCronCheckHome,
  shadokScriptDirs,
  SHADOK_INTERNAL_DIRS,
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
    wireCommonsPot: () => { calls.push("commonsPot"); },
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
    "commonsPot",
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

test("runMigration: kills the running (root) panes BEFORE the long chown (Important #2 — no mid-migration root adoption)", async () => {
  const { deps, calls } = recordingDeps({
    respawnIds: ["s1"],
    respawn: () => { calls.push("respawn"); },
  });
  await runMigration(FULL_PLAN, deps);
  // The kill must precede the chown, or a client WS resume during the seconds-
  // long chown would adopt the still-live root pane.
  assert.ok(calls.indexOf("respawn") < calls.indexOf("chownTree"), "respawn/kill runs before chown");
  assert.ok(calls.indexOf("respawn") < calls.indexOf("createCommonsUser"), "and before everything else");
});

// ─── server wiring: a source-scan lock (server.ts is un-importable) ──────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, "..", "src", "server.ts"), "utf8");

test("server: the migration is wired into boot after ensureSshIdentity and gated by mode", () => {
  assert.ok(/runMigration\s*\(/.test(SERVER), "runMigration is called in server.ts");
  assert.ok(/runGroupsMigration\s*\(\s*\)/.test(SERVER), "the boot wrapper is invoked");
  // Boot and the post-sign-in retry share ONE entry point, `maybeRunGroupsMigration`,
  // which owns the mode gate (mono-tenant no-op), the in-flight guard and the
  // post-migration reprovision. See `test/migration-signin-retry.test.ts`.
  assert.ok(/DEPLOYMENT_MODE !== "multi-tenant"/.test(SERVER), "the entry point gates on DEPLOYMENT_MODE");
  // The BOOT invocation (the top-level `maybeRunGroupsMigration("boot")` call, not
  // its definition) must come after the SSH identity is set up.
  const sshIdx = SERVER.indexOf("Object.assign(process.env, ensureSshIdentity());");
  const bootCall = SERVER.indexOf('void maybeRunGroupsMigration("boot")');
  assert.ok(sshIdx !== -1 && bootCall !== -1, "both anchors present");
  assert.ok(bootCall > sshIdx, "the migration boot call runs after the SSH identity is set up");
});

test("server: commons spawns drop to the migrated `main` user (not root)", () => {
  assert.ok(/commonsOsUser\s*\(/.test(SERVER), "commonsOsUser is consulted at the spawn/restart path");
});

test("server: a drop user also sets HOME via homeForUser (CRITICAL #4)", () => {
  // makePilot must derive the drop user's HOME from the SAME helper the
  // provisioning used, or the agent reaches the server's /root instead.
  assert.ok(/homeForUser\s*\(\s*user\s*,\s*GROUP_HOME_BASE\s*\)/.test(SERVER), "makePilot derives home from the drop user");
  assert.ok(/new TmuxPilot\(\{[^}]*\buser\b[^}]*\bhome\b/.test(SERVER), "TmuxPilot gets both user and home");
  assert.ok(/new PtyPilot\(\{[^}]*\buser\b[^}]*\bhome\b/.test(SERVER), "PtyPilot gets both user and home");
});

test("server: the migration banner flag is set (pending/failed) and exposed on /version", () => {
  // A never-completing migration (e.g. signed-out) must be VISIBLE, not silent.
  assert.ok(/migrationState\s*=\s*"pending"/.test(SERVER), "pending is set when a real migration runs");
  assert.ok(/migrationState\s*=\s*groupsMigrated\s*\?\s*"ok"\s*:\s*"failed"/.test(SERVER), "failed is set when the marker is withheld");
  assert.ok(/migrated:\s*groupsMigrated,\s*migrationState/.test(SERVER), "migrationState is on versionState (/version + WS version)");
});

test("server: the migration respawn ENFORCES the kill (re-check, not fire-and-forget — Important #1a)", () => {
  const fn = SERVER.slice(SERVER.indexOf("async function migRespawnRunningAgents"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // It must re-check hasSession AFTER the kill (mirroring restartSession), not
  // kill once and move on.
  assert.ok(/for\s*\([^)]*tmuxHasSession\(name\)/.test(body), "re-checks the session is actually gone after the kill");
});

test("server: migration state transitions are broadcast, and commons paths go through homeForUser", () => {
  assert.ok(/migrationState = "pending";\s*\n\s*broadcastAll\(versionMessage\(\)\)/.test(SERVER), "pending is broadcast");
  assert.ok(/migrationState = groupsMigrated \? "ok" : "failed";\s*\n\s*broadcastAll\(versionMessage\(\)\)/.test(SERVER), "outcome is broadcast");
  assert.ok(!/\$\{GROUP_HOME_BASE\}\/\$\{COMMONS_USER\}/.test(SERVER), "no inline commons home path");
  // 3 pre-existing call sites + the commons `.claude/scripts` boot self-heal.
  assert.equal((SERVER.match(/homeForUser\(COMMONS_USER, GROUP_HOME_BASE\)/g) ?? []).length, 4);
});

test("index.html: the migration banner is shown before the #verView early return", () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"), "utf8");
  const i = html.indexOf("showMigrationBanner(msg.migrationState)");
  assert.ok(i > 0 && i < html.indexOf("if (!verView) return;"));
});

// ── rewriteCronCheckHome ──────────────────────────────────────────────────────
// When the commons agent's HOME moves off /root (migration to the non-root `main`
// user), a cron `check` command that hard-codes the OLD commons HOME under /root
// (`node /root/.claude/skills/.../x.mjs`) is run by the dropped `main` user, which
// cannot even traverse /root (0700) → the guard dies, `check-failed`, in silence.
// This rewrites that one base. Pure, so the boot self-heal stays a thin caller.

test("rewriteCronCheckHome: repoints the old commons HOME /.claude base to the new one", () => {
  assert.equal(
    rewriteCronCheckHome(
      "node /root/.claude/skills/shadok-scheduler/scripts/garder.mjs --bavard",
      "/root",
      "/home/main",
    ),
    "node /home/main/.claude/skills/shadok-scheduler/scripts/garder.mjs --bavard",
  );
});

test("rewriteCronCheckHome: only the `/.claude` subtree is moved, not unrelated /root refs", () => {
  // A legit reference to /root outside .claude is left alone (nothing else was
  // relocated); only the Claude state tree moved.
  assert.equal(
    rewriteCronCheckHome("sh /root/other.sh && node /root/.claude/x.mjs", "/root", "/home/main"),
    "sh /root/other.sh && node /home/main/.claude/x.mjs",
  );
});

test("rewriteCronCheckHome: every occurrence of the old base is moved", () => {
  assert.equal(
    rewriteCronCheckHome("node /root/.claude/a.mjs; node /root/.claude/b.mjs", "/root", "/home/main"),
    "node /home/main/.claude/a.mjs; node /home/main/.claude/b.mjs",
  );
});

test("rewriteCronCheckHome: identity when the home did not move (mono-tenant / same base)", () => {
  const c = "node /root/.claude/x.mjs";
  assert.equal(rewriteCronCheckHome(c, "/root", "/root"), c);
});

test("rewriteCronCheckHome: a $HOME-relative check is already portable and untouched", () => {
  const c = "sh $HOME/.claude/pr-watch/check-prs.sh";
  assert.equal(rewriteCronCheckHome(c, "/root", "/home/main"), c);
});

test("rewriteCronCheckHome: empty/missing old or new base is a no-op (never blank a path)", () => {
  const c = "node /root/.claude/x.mjs";
  assert.equal(rewriteCronCheckHome(c, "", "/home/main"), c);
  assert.equal(rewriteCronCheckHome(c, "/root", ""), c);
  assert.equal(rewriteCronCheckHome("", "/root", "/home/main"), "");
});

// ── rewriteCronCheckHome: extra relocated prefixes (the ~/.shadok-ai script dirs) ──
// #419 moved only the `.claude` base. A cron guard just as often names an
// operator/agent script dropped straight under the data dir
// (`/root/.shadok-ai/checks/x.sh`), which the dropped `main` user cannot reach
// either. The rewrite takes extra RELATIVE prefixes so those bases follow too.

test("rewriteCronCheckHome: an extra .shadok-ai script-dir prefix is repointed alongside .claude", () => {
  assert.equal(
    rewriteCronCheckHome(
      "sh /root/.shadok-ai/checks/competitors.sh && node /root/.claude/x.mjs",
      "/root",
      "/home/main",
      [".shadok-ai/checks"],
    ),
    "sh /home/main/.shadok-ai/checks/competitors.sh && node /home/main/.claude/x.mjs",
  );
});

test("rewriteCronCheckHome: a /root path NOT among the relocated prefixes is left intact", () => {
  // `.shadok-ai/scripts` was relocated; `.shadok-ai/ssh` never is, so its ref stays.
  assert.equal(
    rewriteCronCheckHome(
      "sh /root/.shadok-ai/scripts/a.sh; cat /root/.shadok-ai/ssh/id",
      "/root",
      "/home/main",
      [".shadok-ai/scripts"],
    ),
    "sh /home/main/.shadok-ai/scripts/a.sh; cat /root/.shadok-ai/ssh/id",
  );
});

test("rewriteCronCheckHome: env var on an unrelated path is untouched, only the /root base moves", () => {
  assert.equal(
    rewriteCronCheckHome(
      "SHADOK_REPO_DIR=/Users/me/proj sh /root/.shadok-ai/checks/pr-open.sh",
      "/root",
      "/home/main",
      [".shadok-ai/checks"],
    ),
    "SHADOK_REPO_DIR=/Users/me/proj sh /home/main/.shadok-ai/checks/pr-open.sh",
  );
});

test("rewriteCronCheckHome: no extra prefixes behaves exactly like the 3-arg form (.claude only)", () => {
  const c = "sh /root/.shadok-ai/checks/x.sh && node /root/.claude/y.mjs";
  assert.equal(rewriteCronCheckHome(c, "/root", "/home/main", []), rewriteCronCheckHome(c, "/root", "/home/main"));
});

// ── shadokScriptDirs ──────────────────────────────────────────────────────────
// Which ~/.shadok-ai/<dir> script directories a cron check names under the old
// /root HOME — the dirs the heal must carry across, EXCLUDING shadok's own state
// and credential stores (never copy a private key / session key into /home/main).

test("shadokScriptDirs: extracts the referenced script dirs as relative prefixes, deduped", () => {
  assert.deepEqual(
    shadokScriptDirs(
      "sh /root/.shadok-ai/checks/a.sh; sh /root/.shadok-ai/checks/b.sh; node /root/.shadok-ai/scripts/c.mjs",
      "/root",
    ).sort(),
    [".shadok-ai/checks", ".shadok-ai/scripts"],
  );
});

test("shadokScriptDirs: a credential/state dir is REFUSED even when named (never relocate secrets)", () => {
  assert.deepEqual(shadokScriptDirs("cat /root/.shadok-ai/ssh/id_ed25519", "/root"), []);
  assert.deepEqual(shadokScriptDirs("cat /root/.shadok-ai/users/x.key", "/root"), []);
  assert.deepEqual(shadokScriptDirs("node /root/.shadok-ai/ledger/x.json", "/root"), []);
});

test("shadokScriptDirs: a top-level .shadok-ai FILE (no subdir) is never matched", () => {
  // The `<dir>/<something>` shape is required, so secrets.json / config.json —
  // files, not dirs — can never be caught.
  assert.deepEqual(shadokScriptDirs("node /root/.shadok-ai/secrets.json", "/root"), []);
});

test("shadokScriptDirs: a .claude path is not a .shadok-ai script dir (that base is #419's job)", () => {
  assert.deepEqual(shadokScriptDirs("node /root/.claude/skills/x/s.mjs", "/root"), []);
});

test("shadokScriptDirs: blank check or blank home yields nothing", () => {
  assert.deepEqual(shadokScriptDirs("", "/root"), []);
  assert.deepEqual(shadokScriptDirs("sh /root/.shadok-ai/checks/a.sh", ""), []);
});

test("SHADOK_INTERNAL_DIRS: the load-bearing credential stores are on the denylist", () => {
  for (const d of ["ssh", "users", "secrets", "ledger", "channels", "crons"]) {
    assert.ok(SHADOK_INTERNAL_DIRS.includes(d), `${d} must be denylisted`);
  }
});

test("server: the commons stranded-script heal is wired into the boot reconciler and covers all halves", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
    "utf8",
  );
  // Called from the every-boot reconciler (not gated on the migration marker).
  assert.match(src, /preseedGroupHomes\(\);\s*\n[\s\S]{0,200}await healCommonsStrandedScripts\(\);/);
  // No-op unless the HOME actually moved off /root.
  assert.match(src, /if \(!newHome \|\| newHome === oldHome\) return;/);
  // Half 1: relocate the .claude/skills subtree the migration skipped.
  assert.match(src, /"\.claude", "skills"/);
  // Half 2: discover and relocate the ~/.shadok-ai script dirs the guards name.
  assert.match(src, /shadokScriptDirs\(c\.check, oldHome\)/);
  // Half 3: rewrite the guards for BOTH bases (the .claude base + the script dirs).
  assert.match(src, /rewriteCronCheckHome\(c\.check, oldHome, newHome, scriptDirs\)/);
});
