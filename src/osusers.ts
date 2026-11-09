import { capabilityRefusal, type DeploymentMode } from "./capability.js";
import { spawnGroupFor, spawnGroupForRequest, canAdministerGroup, groupNameConflict, MAIN_GROUP_ID, type Group, type Nature, type Viewer } from "./groups.js";

/**
 * OS-user isolation: the pure policy behind dropping a spawned agent to the
 * target group's own Unix user. Dependency-free (type-only imports erased at
 * runtime) so the whole wall can be unit-tested without a server — the split
 * `groups.ts` / `kinship.ts` already use.
 *
 * Why an OS user per group at all: a SOFT profile guardrail (`--settings deny`)
 * is one Claude process refusing a tool; it is not a boundary between PEOPLE.
 * Running a private/restricted group's agents as a dedicated non-root user is
 * what the filesystem itself enforces. The server runs privileged and drops per
 * spawn; no agent ever runs as root (the commons agent runs as the server's own
 * non-root user, provisioned by migration — Task 15).
 */

/**
 * A group id reduced to a valid Linux username fragment: lowercase, only
 * `[a-z0-9_-]`, capped so `"sk-" + id` stays under the 32-char limit. Anything
 * else is dropped rather than transliterated — a username is not a display
 * name, and the id is already unique, so a lossy-but-stable mapping is fine.
 */
function sanitizeOsUserId(id: string): string {
  const s = String(id).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 28);
  // A group id that sanitizes to nothing (all-punctuation) still needs a name;
  // "x" keeps the user resolvable rather than producing a bare "sk-".
  return s || "x";
}

/**
 * The OS user an agent of this group runs as.
 *
 * `null` for a PUBLIC group: the commons shares the server's own (non-root)
 * user — there is nothing to isolate from, and the dedicated `main` user is
 * created by migration later (Task 15). A private/restricted group gets its own
 * `sk-<id>` user, provisioned on demand (Task 6).
 */
export function osUserFor(g: Group): string | null {
  if (g.nature === "public") return null;
  return "sk-" + sanitizeOsUserId(g.id);
}

/**
 * The privilege-drop wrapper for a spawn: run `bin args` as `user`, keeping the
 * caller-supplied environment.
 *
 * `setpriv` is chosen because it execs the target directly and does NOT touch
 * the environment — unlike a PAM path (`runuser`/`su`), which resets it and
 * would drop every `SHADOK_*`/secret the spawn depends on. `--init-groups` sets
 * the supplementary groups from `/etc/group`, and `--` ends setpriv's own flags
 * so a binary path starting with `-` could never be read as one.
 */
export function dropArgv(user: string, bin: string, args: string[]): { cmd: string; argv: string[] } {
  return { cmd: "setpriv", argv: ["--reuid", user, "--regid", user, "--init-groups", "--", bin, ...args] };
}

/**
 * The HOME directory a group's OS user owns: `<homeBase>/<user>`. ONE definition,
 * shared by `provisionPlan` (which CREATES it, with `useradd --home-dir`), by the
 * commons seeding in `server.ts` (`migCreateCommonsUser` / `migWireCommonsPot`,
 * both `${homeBase}/main`), and by `makePilot` (which must point the DROPPED
 * agent's `$HOME` at exactly that directory). Keeping it one function is what
 * guarantees the spawn's HOME is byte-for-byte where the
 * `~/.claude` was provisioned — a mismatch would leave auth/skills broken while
 * every provisioning step still "succeeded".
 */
export function homeForUser(user: string, homeBase: string): string {
  return `${homeBase}/${user}`;
}

/**
 * The identity environment a privilege-dropped spawn needs — the OTHER half of
 * `dropArgv`. `setpriv --reuid <user>` changes the uid but NOT `$HOME`/`$USER`/
 * `$LOGNAME`, so a dropped agent keeps the SERVER's values: `HOME=/root`, which
 * is mode 700 and un-traversable by the `sk-*`/`main` user, so it can never reach
 * the per-group `~/.claude` the isolation wired (skills,
 * settings) — auth and skills break for EVERY dropped agent, silently. Point HOME
 * at the drop user's own directory (`homeForUser`) and set USER/LOGNAME for the
 * tools that read them.
 *
 * Returns `{}` when there is NO drop user (mono-tenant, or the commons before
 * migration): the spawn env is then byte-for-byte today's, HOME untouched — which
 * is the whole fail-safe contract (`resolveSpawnIsolation`/`commonsOsUser` return
 * a null user in exactly those cases). Pure, so the pilots and the tests share it.
 */
export function dropEnv(
  user: string | null | undefined,
  home: string | null | undefined,
): Record<string, string> {
  if (!user) return {};
  const env: Record<string, string> = { USER: user, LOGNAME: user };
  if (home) {
    env.HOME = home;
    // The server's inherited `GH_CONFIG_DIR` points at its own `/root/.claude/gh`,
    // which a privilege-dropped user cannot traverse (mode 0700) — so EVERY `gh`
    // call (and `git` via `gh auth git-credential`) dies "permission denied"
    // reading config before auth is even consulted. Point it at the drop user's
    // OWN writable config dir instead; the auth token is injected separately as
    // `GH_TOKEN` (`forcedEnv`), so `gh` is both reachable AND authenticated.
    env.GH_CONFIG_DIR = `${home}/.config/gh`;
  }
  return env;
}

/**
 * The whole server-side isolation policy for one spawn, kept pure so the start
 * handler stays a thin caller and the decision is fully testable (invariant 24:
 * a field threaded is not a field used — here the group is PROVEN to come from
 * identity, never from the client).
 *
 * - Mono-tenant is byte-for-byte today: no user (never wrap the spawn), no group
 *   written (a group-less channel is the commons, visible to everyone).
 * - A NEW multi-tenant agent is born into the LAUNCHER's group when it was
 *   spawned by another agent (`parentGroupId`), else the CALLER's own group
 *   (`spawnGroupFor`, derived from the viewer and the server's group list — no
 *   client input), and drops to that group's user. Inheriting the launcher's
 *   group is what keeps an agent-spawned child in the SAME isolation domain as
 *   its parent instead of the admin viewer's Personal group. The `groupPatch` is
 *   what the start-path upsert writes server-side; the commons resolves to no user.
 * - A RESUME never reassigns the group (it is SERVER_OWNED and already set), but
 *   still drops to the stored group's user — a private agent must come back
 *   under its own user, not as root. The parent group is ignored on resume.
 */
export function resolveSpawnIsolation(input: {
  mode: DeploymentMode;
  resumed: boolean;
  viewer: Viewer | null;
  groups: readonly Group[];
  /** The group the RESUMED channel already carries (null = commons / group-less). */
  storedGroupId: string | null;
  /** NEW spawns only: the group the client asked for; honoured iff the caller may see it. */
  requestedGroupId?: string | null;
  /** NEW spawns only: the group of the AGENT that launched this one, if any —
   *  inherited (no canSeeGroup gate; it is server-proven) unless a visible
   *  request overrides it. */
  parentGroupId?: string | null;
}): { user: string | null; groupPatch: { group?: string } } {
  if (input.mode !== "multi-tenant") return { user: null, groupPatch: {} };
  if (input.resumed) {
    const g = input.storedGroupId ? input.groups.find((x) => x.id === input.storedGroupId) ?? null : null;
    return { user: g ? osUserFor(g) : null, groupPatch: {} };
  }
  const g = spawnGroupForRequest(
    input.viewer,
    input.groups,
    input.requestedGroupId ?? null,
    input.parentGroupId ?? null,
  );
  return {
    user: g ? osUserFor(g) : null,
    groupPatch: g ? { group: g.id } : {},
  };
}

/** The default base directory a group's HOME is created under. Overridable
 *  (`SHADOK_HOME_BASE`) for unusual layouts; `/home` is the Linux standard. */
export const DEFAULT_HOME_BASE = "/home";

/**
 * The state directory a dropped agent owns inside its tier HOME — the parent of
 * everything shadok and its own tooling keep per agent (`pilotctl`'s state, the
 * peers file a hand-run CLI falls back to, the worktrees and the self-clone
 * invariant 54 moved here).
 */
export function tierStateDir(home: string): string {
  return `${home}/.shadok-ai`;
}

/**
 * Invariant 54's third case, and the one the first two CREATED. Moving a dropped
 * agent's state into its own home fixed the LOCATION, but the server is root and
 * every writer there (`selfRepoDir`, `worktreeDir`, `factoryDir`) mkdirs with
 * `recursive: true` — so whichever ran first made `<home>/.shadok-ai` ITSELF
 * root-owned, inside a home the agent otherwise owns. The agent can then reach
 * the directory and not write it: `pilotctl` dies on
 * `EACCES: mkdir '/home/main/.shadok-ai/pilotctl'`, which is how it was found —
 * every worker spawn of a production dispatch loop failing while the home, the
 * skills and the credentials were all correct. MEASURED on correctsms 0.17.33.
 *
 * Deliberately a three-way answer rather than "mkdir -p and hope":
 *  - absent → `create`, performed AS the user so it is born owned by them (the
 *    same rule as `writeAsUserAtomic`: root must not write through a 0700 home);
 *  - present and writable by the user → `null`, touch nothing. The common case,
 *    and it must stay free: this runs before every spawn;
 *  - present and NOT writable → `chown`, which is the repair half. Without it
 *    only brand-new homes would be correct and every already-running instance
 *    would stay broken — the directory exists, so a create is a silent no-op.
 *
 * The chown is the DIRECTORY only, never its contents: what is inside has owners
 * for its own reasons (a root-owned self-clone checkout, a worktree already
 * chowned by `chownAgentStateToDropUser`), and rewriting those would undo
 * decisions made elsewhere.
 */
export function tierStateDirAction(probe: {
  exists: boolean;
  writableByUser: boolean;
}): "create" | "chown" | null {
  if (!probe.exists) return "create";
  return probe.writableByUser ? null : "chown";
}

// ── Privileged wiring plans ───────────────────────────────────────────────────
//
// (The old shared-credential-FILE mechanism lived here. Each group agent now
// authenticates through an injected `CLAUDE_CODE_OAUTH_TOKEN` env var forced last
// at spawn, so no credential file is shared, linked or checked any more.)

/**
 * Privileged wiring commands, SPLIT BY WHO RUNS THEM (same TOCTOU rule for every
 * plan): the HOME is owned by the group user and is mode 700, so if ROOT wrote
 * inside it, an agent that planted a symlink could make root dereference it. Root
 * therefore does ONLY the shared side, and the HOME side runs AS THE GROUP USER
 * via `runAsUser`. Pure lists of `[cmd, argv]` so the split is locked by test.
 */
export interface WiringPlan {
  /** Shared-side, run AS ROOT. Root never touches the HOME. */
  rootCmds: Array<[string, string[]]>;
  /** HOME-side, run AS THE GROUP USER (`runAsUser`). */
  userCmds: Array<[string, string[]]>;
}

/**
 * Wrap a command so the privileged `run` executes it AS the group user rather
 * than as root. `runuser -u <user> --` drops privilege and execs the target
 * directly; `--` ends runuser's own flags so an argument starting with `-` can
 * never be read as one. Pure (a single `[cmd, argv]`) so the HOME-side split is
 * locked by test.
 */
export function runAsUser(user: string, cmd: string, argv: string[]): [string, string[]] {
  return ["runuser", ["-u", user, "--", cmd, ...argv]];
}

// ── Shared pot (Task 12) ──────────────────────────────────────────────────────
//
// ONE server-owned directory every group's HOME exposes as `~/shared/`: the
// deliberate "make this public" drop point. Everything else in a HOME stays
// walled (0700). Unlike a read-shared resource, the pot is read+WRITE for
// all groups; the spec accepts no per-file guardrail, so any group can overwrite
// or delete another's file — hence no sticky bit.
//
// Its OWN unix group. The base is `root:shadok-shared` 2770 — setgid so files
// created inside inherit the group (visible to every member), no access for
// others. Files still carry the creator's umask, so a 644 file is readable but
// not overwritable by other groups; acceptable for a drop point.
//
// T15 CARRY: the commons HOME (the server's own user) is not provisioned here;
// the migration links `<commons-home>/shared` to the same base.

/** The unix group that owns the shared pot; every provisioned user joins it. */
export const SHARED_POT_GROUP = "shadok-shared";

/** Neutral default (overridable via `SHADOK_SHARED_POT_PATH` in `server.ts`),
 *  deliberately outside every HOME and `/root`. */
export const DEFAULT_SHARED_POT_PATH = "/var/lib/shadok-ai/shared";

/** The symlink a HOME gets and the one shared base it points at. Pure. */
export function sharedPotWiring(home: string, sharedBase: string): { link: string; target: string } {
  return { link: `${home}/shared`, target: sharedBase };
}

/**
 * Pot wiring split by who runs it, same TOCTOU rule as `WiringPlan`:
 * root touches only the shared base and group membership; the HOME-side link is
 * posed AS THE GROUP USER so root never writes through an agent-controlled path.
 * `chmod` after `install -d` because install does not alter an existing dir's
 * mode on every coreutils path, and a re-provision must still converge.
 */
export function sharedPotPlan(user: string, home: string, sharedBase: string): WiringPlan {
  const { link, target } = sharedPotWiring(home, sharedBase);
  return {
    rootCmds: [
      ["groupadd", ["-f", SHARED_POT_GROUP]],
      ["install", ["-d", "-o", "root", "-g", SHARED_POT_GROUP, "-m", "2770", sharedBase]],
      ["chmod", ["2770", sharedBase]],
      ["usermod", ["-aG", SHARED_POT_GROUP, user]],
    ],
    userCmds: [["ln", ["-sfn", target, link]]],
  };
}

/**
 * The on-demand provisioning plan for a group's OS user, kept PURE so the exact
 * `useradd` invocation and the HOME path are unit-tested without touching the
 * filesystem — the same split `dropArgv`/`resolveSpawnIsolation` already use.
 *
 * `null` for a PUBLIC group: the commons shares the server's own user, there is
 * nothing to provision (the `main` user itself is created by migration, Task 15).
 * A private/restricted group gets `sk-<id>` with its HOME at `<homeBase>/<user>`
 * and `--create-home`, so the account and its home directory land in one call.
 */
export interface ProvisionPlan {
  user: string;
  home: string;
  useradd: string[];
  seedHome: boolean;
}

export function provisionPlan(g: Group, homeBase: string): ProvisionPlan | null {
  const user = osUserFor(g);
  if (!user) return null; // public: nothing to provision
  const home = homeForUser(user, homeBase);
  return {
    user,
    home,
    // --home-dir pins HOME under the managed base (never /home/<user> by the
    // system default), --create-home makes the directory in the same call.
    useradd: ["useradd", "--create-home", "--home-dir", home, user],
    seedHome: true,
  };
}

/**
 * Create (or reuse) the group's OS user and seed its HOME. Impure, but every
 * side effect is injected (`run`/`seed`/`userExists`) so the policy stays
 * exec-/fs-free under test.
 *
 * - PUBLIC → `null`: there is no dedicated user, so nothing runs.
 * - An EXISTING user is reused (idempotent): `useradd` is skipped, but the HOME
 *   is still (re-)seeded — seeding must be safe to repeat.
 * - A NEW user runs `useradd`, then seeds the HOME.
 *
 * T3 carry — FAIL HONESTLY. The boot capability probe is `sudo -n true`, which
 * is a FALSE POSITIVE when sudoers allows `true` but not `useradd`. So a failing
 * `run`/`seed` is NEVER swallowed: it is re-thrown with context, and the caller
 * must refuse the group rather than let a later `setpriv` silently fail to
 * isolate (an agent that "ran" but was never actually dropped to its own user).
 */
export async function provisionGroupUser(
  g: Group,
  deps: {
    run: (cmd: string, argv: string[]) => Promise<void>;
    seed: (home: string, user: string) => Promise<void>;
    homeBase: string;
    userExists?: (u: string) => Promise<boolean>;
    /** Task 12: when set (multi-tenant only), expose the one shared pot as
     *  `<home>/shared`. Absent in mono-tenant ⇒ nothing runs. */
    sharedPotPath?: string;
  },
): Promise<{ osUser: string; home: string } | null> {
  const plan = provisionPlan(g, deps.homeBase);
  if (!plan) return null; // public: commons, no isolation to set up

  const exists = deps.userExists ? await deps.userExists(plan.user) : false;
  if (!exists) {
    try {
      await deps.run(plan.useradd[0], plan.useradd.slice(1));
    } catch (e) {
      // Surface, do not swallow: a group whose user cannot be created must not
      // look provisioned (invariant: never fake an isolation wall).
      throw new Error(`provisionGroupUser: useradd failed for ${plan.user}: ${(e as Error)?.message ?? e}`);
    }
  }

  // Pose the people-wall on HOME itself. `useradd --create-home` chowns the
  // directory to the new user but leaves its MODE at whatever /etc/login.defs
  // dictates — which can be world/other-readable, so another group's `sk-*`
  // user could then read a private group's HOME. Force 0700 so only the owner
  // can traverse it. Done in BOTH branches (new AND reused), because a HOME that
  // existed before could carry a loose mode too. A failure here is as fatal as a
  // failed `useradd`: an un-private HOME is a BROKEN wall, which is worse than a
  // refused provision — so it THROWS like every other provisioning step.
  try {
    await deps.run("chmod", ["700", plan.home]);
  } catch (e) {
    throw new Error(`provisionGroupUser: chmod 700 ${plan.home} failed: ${(e as Error)?.message ?? e}`);
  }

  if (deps.sharedPotPath) {
    try {
      const pot = sharedPotPlan(plan.user, plan.home, deps.sharedPotPath);
      for (const [cmd, argv] of pot.rootCmds) await deps.run(cmd, argv);
      for (const [cmd, argv] of pot.userCmds) {
        const [wcmd, wargv] = runAsUser(plan.user, cmd, argv);
        await deps.run(wcmd, wargv);
      }
    } catch (e) {
      throw new Error(`provisionGroupUser: shared pot wiring for ${plan.user} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  try {
    // Seed HOME regardless of whether the user was new: this is where the
    // per-HOME ~/.claude seeding and the shared
    // mount (Task 12) hang, all of which must be safe to re-apply.
    await deps.seed(plan.home, plan.user);
  } catch (e) {
    throw new Error(`provisionGroupUser: seeding ${plan.home} failed: ${(e as Error)?.message ?? e}`);
  }
  return { osUser: plan.user, home: plan.home };
}

/**
 * Tear down a group's OS user when the group is deleted. Best-effort by design:
 * it NEVER throws into the caller — a delete half-done (user killed, account
 * left behind, or vice versa) would leave an unremovable group, which is worse
 * than a logged failure. Each step is tried and any error is swallowed-and-logged.
 *
 * It RETURNS the outcome rather than failing silently: on a `killAgents`/`userdel`
 * failure the group row is still removed (so the delete completes), but the
 * caller gets `{ ok:false, warning }` so it can tell the operator the OS
 * user/HOME may be ORPHANED. A silent drop here would leave a stray `sk-*`
 * account and its HOME with no trace anywhere.
 *
 * - PUBLIC → no-op (`{ ok:true }`): the commons has no dedicated user to remove.
 * - else: kill the group's running agents first (so no process holds the account
 *   open), then `userdel --remove` to delete the account together with its HOME
 *   directory and mail spool.
 */
export async function teardownGroupUser(
  g: Group,
  deps: {
    run: (cmd: string, argv: string[]) => Promise<void>;
    homeBase: string;
    killAgents?: () => Promise<void>;
  },
): Promise<{ ok: boolean; warning?: string }> {
  const user = osUserFor(g);
  if (!user) return { ok: true }; // public: nothing to tear down

  let ok = true;
  const warnings: string[] = [];

  if (deps.killAgents) {
    try {
      await deps.killAgents();
    } catch (e) {
      const msg = `killing ${user}'s agents failed: ${(e as Error)?.message ?? e}`;
      console.warn(`teardownGroupUser: ${msg}`);
      ok = false;
      warnings.push(msg);
    }
  }
  try {
    // --remove deletes the account AND its HOME directory + mail spool.
    await deps.run("userdel", ["--remove", user]);
  } catch (e) {
    const msg = `userdel --remove ${user} failed: ${(e as Error)?.message ?? e}`;
    console.warn(`teardownGroupUser: ${msg}`);
    ok = false;
    warnings.push(msg);
  }

  return ok ? { ok: true } : { ok: false, warning: warnings.join("; ") };
}

/**
 * Boot reconciler (Task 16, Important #1): (re-)provision every private/restricted
 * group whose OS user is MISSING, INDEPENDENT of the migration marker.
 *
 * Why this is separate from the migration's `reprovisionGroups` list: that list
 * only runs DURING a real migration (or after a docker-recreate wiped `main`),
 * because `runGroupsMigration` returns early once the instance is
 * `alreadyMigrated` (marker present AND `main` exists). So on a live, already-
 * migrated instance a person whose private-group ROW was persisted (by the invite
 * hook) but whose OS user FAILED to provision — a transient `useradd`
 * error — was never healed: the invite hook's "retries at boot via the migration
 * reprovision list" was FALSE for the steady state. This pass closes that. It runs
 * on EVERY capable boot, probes each non-public group's user, and re-provisions
 * the missing ones. Because `provisionGroupUser` is idempotent, a group whose user
 * already exists is skipped (no `useradd`), and re-running right after a fresh
 * migration simply finds everything present — which is why wiring it AFTER
 * migration never double-provisions. It subsumes the docker-recreate reprovision
 * for the steady state.
 *
 * Best-effort and NEVER throws: a per-group failure (or an unreadable probe) is
 * logged and the loop continues — one bad group must not block the others nor the
 * boot. Returns a summary for the caller to log. Injected `userExists`/`provision`
 * keep it exec-/fs-free under test, like the rest of this module.
 */
export async function reconcileGroupProvisioning(
  groups: readonly Group[],
  deps: {
    userExists: (user: string) => Promise<boolean>;
    provision: (g: Group) => Promise<void>;
    log?: (msg: string) => void;
  },
): Promise<{ provisioned: string[]; present: string[]; failed: string[] }> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const provisioned: string[] = [];
  const present: string[] = [];
  const failed: string[] = [];
  for (const g of groups) {
    const user = osUserFor(g);
    if (!user) continue; // public/commons: no dedicated user to reconcile
    let exists = false;
    try {
      exists = await deps.userExists(user);
    } catch {
      // An unreadable probe → treat as missing and attempt the idempotent
      // provision rather than skip a group that may genuinely need healing.
      exists = false;
    }
    if (exists) {
      present.push(g.id);
      continue;
    }
    try {
      await deps.provision(g);
      provisioned.push(g.id);
      log(`groups: reprovisioned ${g.nature} group ${g.id.slice(0, 8)} (${user}) — OS user was missing`);
    } catch (e) {
      failed.push(g.id);
      log(
        `groups: reprovision of ${g.id.slice(0, 8)} (${user}) FAILED (best-effort, continuing): ` +
          `${(e as Error)?.message ?? e}`,
      );
    }
  }
  return { provisioned, present, failed };
}

/**
 * May a group be DELETED, given the channels currently on disk? (Pure.)
 *
 * T4 carry (fail-closed). `visibleChannels` HIDES a channel whose group id does
 * not resolve, so deleting a group that channels still reference would strand
 * them — invisible to everyone, un-closable through the normal (now-hidden) UI.
 * We REFUSE the delete rather than reassign those channels to the commons: the
 * commons is visible to EVERYONE, so silently moving a private/restricted
 * group's channels there would turn a confidential conversation public — exactly
 * the people-wall breach this feature exists to prevent. The safe direction is
 * to make the operator close or move those agents first. Structural channel type
 * (`{ group? }`) keeps this dependency-free.
 */
export function groupDeleteVerdict(
  groupId: string,
  channels: readonly { group?: string | null }[],
): { ok: true } | { ok: false; error: string } {
  const n = channels.filter((c) => c.group === groupId).length;
  if (n > 0) {
    return { ok: false, error: `group ${groupId} still has ${n} channel(s); close or move them first` };
  }
  return { ok: true };
}

/**
 * The outcome of a `/groups` create/delete, as a transport-free `{status, body}`
 * so the express handler is a thin mapper (req → input, result → res) and the
 * whole route — its GUARDS and its ORDERING — is unit-testable with injected
 * spies, with no server to boot.
 */
export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Create a group (the privileged route's whole decision).
 *
 * Guard order matters and each is load-bearing:
 * - `fromBrowser` FIRST (403): this route can run `useradd` as root, so it must
 *   be a person's same-origin browser session — never an agent or a peer
 *   (`requestFromBrowser`) (invariant 26, exactly like `PUT /profiles`).
 * - instance (409) and sign-in (403): the existing guards, kept.
 * - mono-tenant REFUSES a private/restricted create via `capabilityRefusal`
 *   (400): never mint a group that cannot actually isolate.
 * - provision runs STRICTLY BEFORE persist: a provision throw returns 500 and
 *   NOTHING is saved, so no later spawn can try to drop to a non-existent user.
 */
export async function createGroupFlow(
  input: {
    fromBrowser: boolean;
    instanceOk: boolean;
    account: { name: string } | null;
    name: string;
    nature: Nature;
    mode: DeploymentMode;
  },
  deps: {
    provision: (g: Group) => Promise<void>;
    loadGroups: () => Group[];
    saveGroups: (groups: Group[]) => void;
    newId: () => string;
    now: () => number;
  },
): Promise<RouteResult> {
  if (!input.fromBrowser) return { status: 403, body: { error: "group management is done from the web UI only" } };
  if (!input.instanceOk) return { status: 409, body: { error: "instance-mismatch" } };
  if (!input.account) return { status: 403, body: { error: "sign in to create a group" } };
  const name = input.name.trim();
  if (!name) return { status: 400, body: { error: "name required" } };

  // A Personal group is auto-provisioned with its account, never user-created.
  if (input.nature === "private") {
    return { status: 400, body: { error: "a personal group is created automatically, not here" } };
  }
  if (input.nature !== "public") {
    // The ONE refusal primitive (capability.ts): same 400 + message everywhere.
    const refusal = capabilityRefusal(input.mode);
    if (refusal) return refusal;
  }

  // No two groups with the same name (private/Personal excluded — auto-named).
  // Checked before provisioning so a clash never leaves a stray OS user behind.
  if (groupNameConflict(name, deps.loadGroups())) {
    return { status: 409, body: { error: `a group named "${name}" already exists` } };
  }

  const id = deps.newId();
  const g: Group = {
    id,
    name,
    nature: input.nature,
    members: input.nature === "restricted" ? [input.account.name] : [],
    createdAt: deps.now(),
    osUser: null,
  };
  g.osUser = osUserFor(g);

  // Provision the OS user BEFORE persisting: if provisioning fails honestly
  // (T3), the group is never written, so no later spawn drops to a user that
  // does not exist (which would silently fail to isolate).
  if (input.nature !== "public" && input.mode === "multi-tenant") {
    try {
      await deps.provision(g);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      console.error(`groups: provisioning ${g.id} failed:`, msg);
      return { status: 500, body: { error: `could not provision the group's user: ${msg}` } };
    }
  }

  const list = deps.loadGroups();
  if (list.some((x) => x.id === g.id)) return { status: 409, body: { error: "group already exists" } };
  deps.saveGroups([...list, g]);
  return { status: 200, body: { ok: true, group: g as unknown as Record<string, unknown> } };
}

/**
 * Delete a group (the privileged route's whole decision). Same browser-first
 * guard as `createGroupFlow` (its mirror runs `userdel --remove`). `main` is
 * refused; a group still referenced by channels is refused (`groupDeleteVerdict`,
 * fail-closed). Teardown runs BEFORE the row is removed and NEVER throws — but
 * its warning is surfaced to the caller so an orphaned OS user/HOME does not go
 * unnoticed, even though the group row is removed regardless.
 */
export async function deleteGroupFlow(
  input: {
    fromBrowser: boolean;
    instanceOk: boolean;
    account: { name: string; role: "admin" | "member" } | null;
    id: string;
    mode: DeploymentMode;
  },
  deps: {
    loadGroups: () => Group[];
    saveGroups: (groups: Group[]) => void;
    loadChannels: () => { group?: string | null }[];
    teardown: (g: Group) => Promise<{ ok: boolean; warning?: string }>;
  },
): Promise<RouteResult> {
  if (!input.fromBrowser) return { status: 403, body: { error: "group management is done from the web UI only" } };
  if (!input.instanceOk) return { status: 409, body: { error: "instance-mismatch" } };
  if (!input.account) return { status: 403, body: { error: "sign in to delete a group" } };
  const id = input.id.trim();
  if (!id) return { status: 400, body: { error: "group id required" } };
  if (id === MAIN_GROUP_ID) return { status: 409, body: { error: "the main group cannot be deleted" } };

  const list = deps.loadGroups();
  const g = list.find((x) => x.id === id);
  if (!g) return { status: 404, body: { error: "no such group" } };

  // Personal is torn down only with its account; a Private (restricted) group
  // only by a member. Public stays open to any signed-in caller.
  if (g.nature === "private") return { status: 403, body: { error: "a personal group cannot be deleted" } };
  if (g.nature === "restricted" && !canAdministerGroup(g, { name: input.account.name, role: input.account.role } as Viewer)) {
    return { status: 403, body: { error: "only a member can delete this group" } };
  }

  // T4 carry (fail-closed): refuse while channels still reference the group.
  const verdict = groupDeleteVerdict(id, deps.loadChannels());
  if (!verdict.ok) return { status: 409, body: { error: verdict.error } };

  let warning: string | undefined;
  if (input.mode === "multi-tenant") {
    // Best-effort, never throws — but surface a failure so the operator learns
    // the OS user/HOME may be orphaned even though the group row is removed.
    const r = await deps.teardown(g);
    if (!r.ok) warning = r.warning;
  }
  deps.saveGroups(list.filter((x) => x.id !== id));
  return { status: 200, body: warning ? { ok: true, warning } : { ok: true } };
}
