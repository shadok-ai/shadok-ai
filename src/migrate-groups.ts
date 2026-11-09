import path from "node:path";
import type { DeploymentMode } from "./capability.js";
import type { Group } from "./groups.js";

/**
 * Automatic migration of a running SINGLE-TENANT instance into isolated groups,
 * on the first boot of a CAPABLE (multi-tenant) instance. It is ADDITIVE: today
 * there are no isolated groups, so every existing file is a commons/public file
 * and nothing is reclassified — the migration only CREATES the isolation layer
 * (the non-root commons user, the per-account private groups) and labels what
 * exists as the public commons.
 *
 * Two halves, kept apart like the rest of the isolation code (`groups.ts` is the
 * pure policy, `server.ts` the impure plumbing):
 *  - `migrationPlan` / `respawnPlan` / `commonsOsUser` are PURE and unit-tested;
 *  - `runMigration` takes INJECTED side-effect deps so the step order and the
 *    fail-safe behaviour are tested with no exec/fs.
 *
 * THE T5 CARRY — the commons must not stay root. Today the Docker image has no
 * `USER` directive, so the container runs as root and a commons agent would run
 * as root (it walks every wall). Migration creates the non-root `main` user and
 * chowns the existing root-owned tree to it; afterwards every commons/public
 * spawn drops to `main` (`commonsOsUser`), so no agent ever runs as root. The
 * drop is GATED on the migration having completed (the volume marker), so a
 * partial failure falls back to today's behaviour (commons as the server's own
 * user) rather than a broken half-migrated state.
 */

/** The non-root commons user migration creates; the user every commons/public
 *  agent runs as once migration has completed. */
export const COMMONS_USER = "main";

/**
 * The migration marker's FILENAME. The server joins it under `~/.shadok-ai`,
 * which is the `shadok-data` volume mount (`shadok-data → /root/.shadok-ai`, see
 * `src/ssh.ts`) — NOT the ephemeral server HOME — so the marker survives a
 * `docker rm`+recreate and the one-time data migration never re-runs.
 *
 * The OS layer is a SEPARATE idempotency concern: a recreate keeps the volume
 * (so this marker and the group list survive) but wipes `/etc/passwd` + the
 * HOMEs. The server therefore treats the instance as "already migrated" only
 * when the marker is present AND the `main` user actually exists — the second
 * term is what re-triggers the idempotent provisioning after a recreate, which
 * is exactly what `reprovisionGroups` below re-provisions.
 */
export const MIGRATION_MARKER_FILE = "groups-migrated.json";

export interface MigrationPlan {
  /** Create the non-root commons user `main` (+ its HOME). */
  createCommonsUser: boolean;
  /** chown the existing root-owned tree (workspace, HOMEs, flat vault) to `main`
   *  ONCE — files do not move. */
  chownTree: boolean;
  /** Lift today's flat secret vault into Main's slice (`migrateFlatVault`). */
  vaultToMain: boolean;
  /** Auto-provision one EMPTY private group per account (each person → a
   *  private group). The account names, deduped, order preserved. */
  provisionPrivatePerAccount: string[];
  /** Label today's channels/groups as public/commons (they are already public by
   *  nature from Task 2; this guarantees Main exists). */
  labelExistingPublic: boolean;
  /** Already-persisted private/restricted groups whose OS user+HOME must be
   *  (re-)provisioned at boot. A docker recreate keeps the data volume (the group
   *  list) but loses `/etc/passwd` + the HOMEs, so their `sk-*` users are gone;
   *  `provisionGroupUser` is idempotent, so re-listing them is always safe. */
  reprovisionGroups: string[];
}

/**
 * The plan, decided from what the instance IS. `null` means "do nothing":
 *  - already migrated (the marker is present AND `main` exists) → null, so the
 *    second call is a no-op (idempotent);
 *  - mono-tenant → null: a non-capable (npx) install is NOT migrated — it stays
 *    byte-for-byte today's single-tenant instance.
 * Otherwise every flag is set, one private group is listed per account, and the
 * persisted private/restricted groups are listed for re-provisioning.
 */
export function migrationPlan(input: {
  alreadyMigrated: boolean;
  mode: DeploymentMode;
  accounts: readonly string[];
  existingGroups: readonly Group[];
}): MigrationPlan | null {
  if (input.alreadyMigrated) return null;
  if (input.mode !== "multi-tenant") return null;

  // One private group per account, deduped, stable order (a person may appear
  // twice across sources; a username maps to exactly one private group).
  const seen = new Set<string>();
  const provisionPrivatePerAccount: string[] = [];
  for (const raw of input.accounts) {
    const a = (raw ?? "").trim();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    provisionPrivatePerAccount.push(a);
  }

  // Only private/restricted groups carry an OS user to re-provision; public
  // groups (commons, cosmetic tab-groups) resolve to the server's own user.
  const reprovisionGroups = input.existingGroups
    .filter((g) => g.nature === "private" || g.nature === "restricted")
    .map((g) => g.id);

  return {
    createCommonsUser: true,
    chownTree: true,
    vaultToMain: true,
    provisionPrivatePerAccount,
    labelExistingPublic: true,
    reprovisionGroups,
  };
}

/**
 * The OS user a COMMONS (public / group-less) agent must drop to.
 *
 * `main` once migration has completed on a multi-tenant instance — the T5 carry
 * that keeps the commons off root. `null` otherwise, meaning "the server's own
 * user", which is today's behaviour and the FAIL-SAFE default: if migration has
 * not completed (a partial failure withheld the marker), commons keeps running
 * exactly as it does today rather than drop to a `main` that may not exist.
 */
export function commonsOsUser(input: { migrated: boolean; mode: DeploymentMode }): string | null {
  return input.migrated && input.mode === "multi-tenant" ? COMMONS_USER : null;
}

/**
 * Repoint a cron `check` command from the OLD commons HOME's `.claude` tree to the
 * NEW one, after migration moved the commons agent off `/root` to `/home/main`.
 *
 * Why this is needed at all: an agent that authored a monitoring script stored it
 * (and hard-coded the guard path) under `$HOME/.claude/skills/.../scripts/` when
 * its HOME was still `/root`. Since cron guards now run DROPPED as the commons
 * `main` user (which cannot traverse `/root`, 0700), that absolute `/root/.claude`
 * path is unreadable and the guard dies `check-failed` in silence. The migration
 * relocates the `.claude` tree into the new HOME, so the reference must follow.
 *
 * The `<oldHome>/.claude` base is ALWAYS rewritten — the tree the migration moved —
 * plus any extra RELATIVE prefix the caller passes (the `~/.shadok-ai/<dir>` script
 * dirs a guard also names; see `shadokScriptDirs`). Every OTHER `/root/...` mention
 * is left intact, so a reference to a dir that was NOT relocated keeps pointing at
 * the original. Identity when the home did not move (mono-tenant, or old === new) or
 * when either base is blank (never blank out a path). A `$HOME`-relative check is
 * already portable and contains no absolute base to match, so it passes through
 * untouched. Pure, so the boot self-heal that walks the cron file stays a thin
 * caller — and the exact substitution is locked by test, the twin of
 * `rewriteSkillsBase`.
 */
export function rewriteCronCheckHome(
  check: string,
  oldHome: string,
  newHome: string,
  extraRelPrefixes: readonly string[] = [],
): string {
  if (!check || !oldHome || !newHome || oldHome === newHome) return check;
  let out = check;
  for (const rel of [".claude", ...extraRelPrefixes]) {
    out = out.split(oldHome + "/" + rel).join(newHome + "/" + rel);
  }
  return out;
}

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Shadok's OWN directories under `~/.shadok-ai` — NEVER carried into the commons
 * HOME by the stranded-script heal, even if a cron check names one. The credential
 * stores (`ssh`, `users`, `secrets`) are the load-bearing entries: copying them
 * into `/home/main` would hand every commons agent the SSH private key, the
 * per-session signing keys and the account password hashes. The rest are internal
 * per-instance state a guard has no business reading. A denylist (not an allowlist)
 * on purpose: an operator/agent names its script dir whatever it likes (`scripts`,
 * `checks`, `marketing`, …), and an allowlist would silently fail to heal a
 * custom-named one — reintroducing the exact silent breakage this closes.
 */
export const SHADOK_INTERNAL_DIRS: readonly string[] = [
  "app",
  "browsers",
  "channels",
  "config",
  "crons",
  "files",
  "keys",
  "ledger",
  "locks",
  "media",
  "peers",
  "pilotctl",
  "profiles",
  "run",
  "secrets",
  "self",
  "ssh",
  "tail",
  "tokens",
  "users",
  "whisper",
  "worktrees",
  "wt",
];

/**
 * Shadok's OWN credential and identity state under `~/.shadok-ai`, which the
 * SERVER must keep OWNING across the commons chown. `migChownTreeToCommons` runs
 * an unbounded `chown -R main:main ~/.shadok-ai` on purpose — the commons agent
 * has to keep working on what it already worked on — but that sweeps the
 * credential stores along with the working state, and "who may read this" is not
 * the same question as "who owns this".
 *
 * Nothing LEAKS from it: the server's HOME stays 0700, so `main` cannot even
 * traverse `/root` (the same wall that stranded the cron guards #419-#421 healed).
 * What breaks is the SERVER's own use of its files, and the SSH identity is where
 * that bites first: `~/.ssh` is a symlink to `~/.shadok-ai/ssh` (invariant 19,
 * the only path that survives a container recreate), so once the key and its
 * config belonged to `main`, every root-side `ssh` refused to run at all —
 * `Bad owner or permissions on /root/.ssh/config`, because OpenSSH checks the
 * OWNER of those files, not just their mode. Measured on the dogfood instance:
 * `git` over SSH and every `ssh` to the host were dead while looking configured,
 * and no merge noticed because `gh` speaks HTTPS.
 *
 * So this is re-asserted at EVERY capable boot rather than only right after the
 * migration — an instance already migrated by an older build heals on its next
 * update instead of needing a hand repair. Twin of `healCommonsStrandedScripts`.
 *
 * Every DIRECTORY here is also in `SHADOK_INTERNAL_DIRS`, the list that keeps the
 * heal from COPYING it into a group HOME. The two halves answer the same question
 * by different means — ownership in place, and relocation — so a test pins the
 * pairing: otherwise they drift apart one entry at a time, and a credential store
 * added to one list only would be half-protected in silence.
 */
export const SERVER_OWNED_STATE: readonly string[] = [
  // Stores (directories).
  "ssh", // the persistent SSH identity; `~/.ssh` points here (invariant 19)
  "users", // account hashes + the per-instance session-signing key (invariant 33)
  "peers", // the inbound peer tokens this instance minted for other cockpits
  "keys",
  "secrets",
  "tokens",
  // Files.
  "config.json", // the GUI password and the per-launch-dir Telegram tokens
  "secrets.json", // the vault
  "secret-origin.json",
  "secret-audit.jsonl",
  "profiles.json", // the GUARDRAILS, which an agent must never write (invariant 26)
  "profiles-declined.json",
];

/**
 * Absolute paths of `SERVER_OWNED_STATE` under `home`. PURE: whether a path
 * exists is the caller's business, so this needs no filesystem to test. A blank
 * home yields nothing rather than paths rooted at `/.shadok-ai` — a chown there
 * would be aimed at the wrong machine entirely.
 */
export function serverOwnedStatePaths(home: string): string[] {
  if (!home) return [];
  return SERVER_OWNED_STATE.map((rel) => path.join(home, ".shadok-ai", rel));
}

/**
 * The `~/.claude/<dir>` subtrees NEVER carried by the heal. `.credentials` is a
 * FILE, not a dir, so it can't match anyway — the real entries are the big
 * already-migrated trees (`migChownTreeToCommons` copies `projects`/`todos`/
 * `shell-snapshots`/`file-history`) and the caches (`statsig`/`plugins`/`ide`):
 * re-copying them would be wasteful, and they are not scripts a guard runs.
 * `skills` and `scripts` (and any custom dir) are deliberately NOT here — those
 * are where an agent keeps the monitoring scripts it authored.
 */
export const CLAUDE_INTERNAL_DIRS: readonly string[] = [
  "projects",
  "todos",
  "shell-snapshots",
  "file-history",
  "statsig",
  "plugins",
  "ide",
];

/** The two home subtrees under which an agent/operator legitimately drops a
 *  script a cron guard runs. An ALLOWLIST of TOPS (safe — scripts never live
 *  anywhere else under the HOME) combined with a per-top DENYLIST of SUBS (so a
 *  custom-named script dir still heals). */
const RELOCATABLE_TOPS: Record<string, readonly string[]> = {
  ".claude": CLAUDE_INTERNAL_DIRS,
  ".shadok-ai": SHADOK_INTERNAL_DIRS,
};

/**
 * The home-rooted `<top>/<sub>` script directories a cron `check` names, that the
 * HOME move off `/root` stranded. A dropped `main` guard cannot traverse `/root`
 * (0700), so ANY `/root/<top>/<sub>/…` path it names — a script or its sibling
 * state file — is unreachable and the guard dies `check-failed` in silence. #419
 * relocated only `.claude/skills`; this generalises the discovery so `.claude/scripts`
 * (seen on the biosense cockpit), every `.shadok-ai/<dir>` (the dogfood instance),
 * and any future script dir are all carried across — the trap is not one directory,
 * it is "any `/root` path a check names".
 *
 * Matches an absolute `oldHome` reference AND a `$HOME`/`${HOME}`/`~`-relative one
 * (a portable check still needs its dir to EXIST in the new HOME). Only the 2-level
 * `<top>/<sub>` unit is relocated, with `<top>` restricted to the two script homes
 * and `<sub>` refused when it is shadok's own state/credentials or a big
 * already-migrated `.claude` tree (`RELOCATABLE_TOPS`). Returns distinct RELATIVE
 * prefixes (`".claude/scripts"`, `".shadok-ai/checks"`, …), ready to feed
 * `rewriteCronCheckHome` and `path.join`. Pure.
 */
export function strandedCheckDirs(check: string, oldHome: string): string[] {
  if (!check || !oldHome) return [];
  const homeAlt = [escapeRegExp(oldHome), "\\$HOME", "\\$\\{HOME\\}", "~"].join("|");
  const tops = Object.keys(RELOCATABLE_TOPS).map((t) => escapeRegExp(t)).join("|");
  const re = new RegExp("(?:" + homeAlt + ")/(" + tops + ")/([^/\\s'\"]+)/", "g");
  const out = new Set<string>();
  for (let m = re.exec(check); m; m = re.exec(check)) {
    const [, top, sub] = m;
    if (RELOCATABLE_TOPS[top]?.includes(sub)) continue;
    out.add(top + "/" + sub);
  }
  return [...out];
}

/**
 * The running agents to respawn, as session ids — deduped, order preserved so
 * the caller cycles them ONE AT A TIME (the OAuth refresh-token race,
 * `restartAllSessions` discipline). The kill runs EARLY in `runMigration` (before
 * the seconds-long chown) so no live root pane survives to be adopted by a client
 * resume mid-migration.
 *
 * A pre-migration tmux pane was created while the server ran as root, so it is
 * running as root; it must be RESPAWNED, never re-adopted (invariant 25 —
 * `TmuxPilot.start()` adopts a live pane and keeps its uid). The server's
 * respawn dep hard-kills each pane AND verifies it is gone, so the next resume
 * creates a fresh process under the correct (post-migration) user, keeping
 * history (`--resume`); the adoption guard in `TmuxPilot.start()` is the second
 * line of defence should any pane outlive the kill.
 */
export function respawnPlan(channels: readonly { sessionId?: string | null }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of channels) {
    const id = typeof c?.sessionId === "string" ? c.sessionId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The injected side effects `runMigration` drives. Every one is impure in the
 * server (useradd, chown, fs, exec) and a spy in tests, so the ORDER and the
 * fail-safe behaviour are exercised with no privilege and no filesystem.
 */
export interface MigrationDeps {
  /** Step 1 — create the non-root commons user `main` (+ HOME). Idempotent. */
  createCommonsUser: () => Promise<void> | void;
  /** Step 2 — chown the root-owned tree (workspace, HOMEs, flat vault) to `main`.
   *  Idempotent (chowning already-`main`-owned files is a no-op). */
  chownTreeToCommons: () => Promise<void> | void;
  /** Step 3 — wire the commons HOME to the shared pot (shared group + the
   *  `~/shared` link). Idempotent. Non-core: the agent token is injected at spawn,
   *  so there is no credential to seed and nothing here gates the marker. */
  wireCommonsPot: () => Promise<void> | void;
  /** Step 4 — lift the flat secret vault into Main's slice. Idempotent (a vault
   *  already in the nested shape has nothing flat to migrate). */
  migrateVaultToMain: () => Promise<void> | void;
  /** Step 5a — provision one empty private group for `account`. Idempotent. */
  provisionPrivateGroup: (account: string) => Promise<void> | void;
  /** Step 5b — re-provision a persisted private/restricted group (the
   *  docker-recreate carry). Idempotent via `provisionGroupUser`. */
  reprovisionGroup: (groupId: string) => Promise<void> | void;
  /** Step 6 — label today's channels/groups public/commons (ensure Main). */
  labelExistingPublic: () => Promise<void> | void;
  /** Is the volume marker already present? (belt-and-braces no-op guard). */
  markerExists: () => boolean;
  /** Write the volume marker (migration done). */
  writeMarker: () => void;
  /** The running agents to respawn, if any (from `respawnPlan`). */
  respawnIds?: string[];
  /** Respawn those agents, one at a time, respawned-not-readopted. */
  respawn?: (sessionIds: string[]) => Promise<void> | void;
  /** Log sink (defaults to `console.log`); every step logs, incl. failures. */
  log?: (msg: string) => void;
}

/**
 * Run the migration. IDEMPOTENT and FAIL-SAFE by construction:
 *  - every step is wrapped: a failure is LOGGED and the migration continues — a
 *    partial failure must never throw into the boot path (a thrown migration
 *    would take the whole instance down, far worse than an un-isolated commons);
 *  - the volume marker is written LAST and ONLY when the CORE steps (create
 *    `main`, chown the tree) both succeeded. Those are
 *    what make it safe for commons to drop to `main`; if any failed, the marker
 *    is withheld so `commonsOsUser` stays `null` (commons as today) and the next
 *    boot retries — safe because every step is idempotent. Group-level failures
 *    (one bad account/group) are logged but never block the marker; they are
 *    reconciled by the idempotent re-provisioning and the group routes.
 *
 * The caller only reaches here with a non-null plan (mode is multi-tenant and
 * the instance is not already migrated).
 */
export async function runMigration(plan: MigrationPlan, deps: MigrationDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  let coreOk = true;

  const step = async (name: string, enabled: boolean, fn: () => Promise<void> | void, core: boolean): Promise<void> => {
    if (!enabled) return;
    try {
      await fn();
      log(`migrate: ${name} ✓`);
    } catch (e) {
      log(`migrate: ${name} FAILED (continuing, fail-safe): ${(e as Error)?.message ?? e}`);
      if (core) coreOk = false;
    }
  };

  log("migrate: moving the instance into isolated groups (one-time, idempotent)");

  // ── Kill the running (root) panes FIRST, before the seconds-long chown. ──
  // A pre-migration pane runs as root; `chown -R` can take many seconds, and
  // during that window a client WS resume would otherwise ADOPT the live root
  // pane and drive it (the kill used to run last). Killing here closes that race:
  // once migration has begun, no root pane survives to be adopted. The kill is
  // ENFORCED by the server dep (re-check + hard kill); the next resume respawns a
  // fresh process under the new `main` drop, history kept via `--resume`.
  if (deps.respawn && deps.respawnIds && deps.respawnIds.length) {
    const ids = deps.respawnIds;
    await step(`kill ${ids.length} running (root) agent(s) — respawned, not re-adopted`, true, () => deps.respawn!(ids), false);
  }

  // ── Core: the commons must end up non-root `main`. ──
  await step("create commons user `main`", plan.createCommonsUser, deps.createCommonsUser, true);
  await step("chown root-owned tree → `main`", plan.chownTree, deps.chownTreeToCommons, true);
  await step("wire commons HOME to the shared pot", plan.createCommonsUser, deps.wireCommonsPot, false);

  // ── Data + groups: non-core (reconciled elsewhere if they fail). ──
  await step("flat vault → Main slice", plan.vaultToMain, deps.migrateVaultToMain, false);
  for (const account of plan.provisionPrivatePerAccount) {
    await step(`provision private group for ${account}`, true, () => deps.provisionPrivateGroup(account), false);
  }
  for (const gid of plan.reprovisionGroups) {
    await step(`re-provision persisted group ${gid.slice(0, 8)}`, true, () => deps.reprovisionGroup(gid), false);
  }
  await step("label existing channels/groups public", plan.labelExistingPublic, deps.labelExistingPublic, false);

  if (coreOk) {
    try {
      deps.writeMarker();
      log("migrate: done — instance moved to isolated groups (commons now runs as non-root `main`)");
    } catch (e) {
      log(`migrate: writing the marker FAILED: ${(e as Error)?.message ?? e}`);
    }
  } else {
    log("migrate: a core step failed — marker withheld, commons stays as today and the next boot retries");
  }
}
