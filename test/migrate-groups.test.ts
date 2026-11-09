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
  strandedCheckDirs,
  SHADOK_INTERNAL_DIRS,
  CLAUDE_INTERNAL_DIRS,
  SERVER_OWNED_STATE,
  serverOwnedStatePaths,
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

// ── rewriteCronCheckHome: extra relocated prefixes (the .shadok-ai script dirs) ──
// #419 moved only the `.claude` base (which covers any `.claude/*` path). A guard
// also names scripts under `.shadok-ai/<dir>`, which has no base rewrite of its
// own, so the rewrite takes extra RELATIVE prefixes for those.

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

// ── strandedCheckDirs ─────────────────────────────────────────────────────────
// Which home-rooted <top>/<sub> script dirs a cron check names under the old /root
// HOME — the dirs the heal must carry across. The trap is not one directory, it is
// "any /root path a check names": .claude/scripts (biosense), any .shadok-ai/<dir>
// (dogfood). EXCLUDES shadok's own state/credential stores and the big
// already-migrated .claude trees.

test("strandedCheckDirs: extracts .shadok-ai script dirs as relative prefixes, deduped", () => {
  assert.deepEqual(
    strandedCheckDirs(
      "sh /root/.shadok-ai/checks/a.sh; sh /root/.shadok-ai/checks/b.sh; node /root/.shadok-ai/scripts/c.mjs",
      "/root",
    ).sort(),
    [".shadok-ai/checks", ".shadok-ai/scripts"],
  );
});

test("strandedCheckDirs: .claude/scripts is discovered too — the gap biosense revealed (#419 did skills only)", () => {
  assert.deepEqual(strandedCheckDirs("/root/.claude/scripts/repo-sync.sh", "/root"), [".claude/scripts"]);
});

test("strandedCheckDirs: a $HOME- or ~-relative reference still yields its dir (it must exist in the new HOME)", () => {
  // The check is portable (no rewrite needed), but the dir must be COPIED, so the
  // $HOME/~ forms are discovered as well as the absolute oldHome one.
  assert.deepEqual(strandedCheckDirs("python3 $HOME/.claude/scripts/pr-automerge-check.py", "/root"), [".claude/scripts"]);
  assert.deepEqual(strandedCheckDirs("sh ${HOME}/.shadok-ai/checks/x.sh", "/root"), [".shadok-ai/checks"]);
  assert.deepEqual(strandedCheckDirs("sh ~/.shadok-ai/marketing/m.sh", "/root"), [".shadok-ai/marketing"]);
});

test("strandedCheckDirs: a credential/state dir is REFUSED even when named (never relocate secrets)", () => {
  assert.deepEqual(strandedCheckDirs("cat /root/.shadok-ai/ssh/id_ed25519", "/root"), []);
  assert.deepEqual(strandedCheckDirs("cat /root/.shadok-ai/users/x.key", "/root"), []);
  assert.deepEqual(strandedCheckDirs("node /root/.shadok-ai/ledger/x.json", "/root"), []);
});

test("strandedCheckDirs: a big already-migrated .claude tree is REFUSED (not re-copied)", () => {
  assert.deepEqual(strandedCheckDirs("cat /root/.claude/projects/x/y.jsonl", "/root"), []);
  assert.deepEqual(strandedCheckDirs("cat /root/.claude/todos/t.json", "/root"), []);
});

test("strandedCheckDirs: a top-level FILE (no subdir) is never matched", () => {
  // The `<top>/<sub>/<something>` shape is required, so secrets.json / .claude.json —
  // files, not dirs — can never be caught.
  assert.deepEqual(strandedCheckDirs("node /root/.shadok-ai/secrets.json", "/root"), []);
});

test("strandedCheckDirs: a /root path OUTSIDE the two script homes is not relocated", () => {
  // Only .claude and .shadok-ai host scripts; an arbitrary /root/<dir> is left for
  // the check-failed signal, never blindly copied.
  assert.deepEqual(strandedCheckDirs("sh /root/randomdir/x.sh", "/root"), []);
});

test("strandedCheckDirs: blank check or blank home yields nothing", () => {
  assert.deepEqual(strandedCheckDirs("", "/root"), []);
  assert.deepEqual(strandedCheckDirs("sh /root/.shadok-ai/checks/a.sh", ""), []);
});

test("denylists: the load-bearing stores/trees are refused", () => {
  for (const d of ["ssh", "users", "secrets", "ledger", "channels", "crons", "media"]) {
    assert.ok(SHADOK_INTERNAL_DIRS.includes(d), `.shadok-ai/${d} must be denylisted`);
  }
  for (const d of ["projects", "todos", "shell-snapshots", "file-history"]) {
    assert.ok(CLAUDE_INTERNAL_DIRS.includes(d), `.claude/${d} must be denylisted`);
  }
  // skills + scripts are the script homes — they must NOT be denylisted.
  assert.ok(!CLAUDE_INTERNAL_DIRS.includes("skills"));
  assert.ok(!CLAUDE_INTERNAL_DIRS.includes("scripts"));
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
  // Half 1: relocate the .claude/skills subtree the migration skipped (always).
  assert.match(src, /"\.claude", "skills"/);
  // Half 2: discover and relocate every home-rooted script dir the guards name.
  assert.match(src, /strandedCheckDirs\(c\.check, oldHome\)/);
  // Half 3: rewrite the guards (the .claude base + the relocated script dirs).
  assert.match(src, /rewriteCronCheckHome\(c\.check, oldHome, newHome, scriptDirs\)/);
});

test("server-owned state: the paths are the server's credentials, under its own HOME", () => {
  const paths = serverOwnedStatePaths("/root");
  // The SSH identity is the load-bearing one: `~/.ssh` is a symlink to it, and
  // OpenSSH refuses a key or a config owned by another user, mode notwithstanding.
  assert.ok(paths.includes("/root/.shadok-ai/ssh"));
  // The vault, the accounts (with the session-signing key) and the guardrails.
  for (const rel of ["secrets.json", "users", "profiles.json", "config.json"]) {
    assert.ok(paths.includes(`/root/.shadok-ai/${rel}`), `${rel} must stay the server's`);
  }
  // Every path sits under the given home: a chown is aimed at a machine, so a
  // path escaping the home would be aimed at the wrong one.
  for (const p of paths) assert.ok(p.startsWith("/root/.shadok-ai/"), p);
  assert.equal(paths.length, SERVER_OWNED_STATE.length);
  assert.equal(new Set(SERVER_OWNED_STATE).size, SERVER_OWNED_STATE.length, "no duplicate entry");
});

test("server-owned state: the commons agent's OWN working state is never reclaimed", () => {
  // The chown exists so the commons agent keeps working on what it worked on.
  // Reclaiming these would undo the migration itself, one directory at a time.
  for (const rel of ["channels", "crons", "ledger", "media", "files", "tail", "worktrees", "pilotctl"]) {
    assert.ok(!SERVER_OWNED_STATE.includes(rel), `${rel} belongs to the commons agent`);
  }
});

test("server-owned state: a blank home yields nothing, never paths rooted at /", () => {
  assert.deepEqual(serverOwnedStatePaths(""), []);
});

test("server-owned state: every store is ALSO denylisted from the stranded-script heal", () => {
  // The two halves answer one question — who may reach a credential — by different
  // means: ownership in place here, relocation there. Pinned together, because a
  // store added to one list only would be half-protected in silence.
  for (const rel of SERVER_OWNED_STATE) {
    if (rel.includes(".")) continue; // a file, which the heal can never match (it copies <top>/<sub>/ dirs)
    assert.ok(SHADOK_INTERNAL_DIRS.includes(rel), `~/.shadok-ai/${rel} must also be in SHADOK_INTERNAL_DIRS`);
  }
});

test("server: the credential re-own heal is wired into the boot reconciler, after the script heal", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
    "utf8",
  );
  assert.match(src, /await healCommonsStrandedScripts\(\);[\s\S]{0,200}await healServerOwnedState\(\);/);
  // Multi-tenant only: nothing chowned anything on a mono-tenant instance.
  assert.match(src, /async function healServerOwnedState[\s\S]{0,120}DEPLOYMENT_MODE !== "multi-tenant"\) return;/);
  // The owner is the SERVER's own uid/gid, read at runtime — not a hardcoded root.
  assert.match(src, /const owner = `\$\{uid\}:\$\{gid\}`;/);
  // A directory is judged on itself AND its immediate entries (the hand-repair shape).
  assert.match(src, /readdirSync\(p\)/);
  // No privileged spawn when everything is already ours — this runs on every boot.
  assert.match(src, /if \(!fs\.existsSync\(p\) \|\| !foreign\(p\)\) continue;/);
});
