import path from "node:path";
import type { DeploymentMode } from "./capability.js";
import { spawnGroupFor, MAIN_GROUP_ID, type Group, type Nature, type Viewer } from "./groups.js";

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
 * The whole server-side isolation policy for one spawn, kept pure so the start
 * handler stays a thin caller and the decision is fully testable (invariant 24:
 * a field threaded is not a field used — here the group is PROVEN to come from
 * identity, never from the client).
 *
 * - Mono-tenant is byte-for-byte today: no user (never wrap the spawn), no group
 *   written (a group-less channel is the commons, visible to everyone).
 * - A NEW multi-tenant agent is born into the CALLER's own group
 *   (`spawnGroupFor`, derived from the viewer and the server's group list — no
 *   client input) and drops to that group's user. The `groupPatch` is what the
 *   start-path upsert writes server-side; the commons resolves to no user.
 * - A RESUME never reassigns the group (it is SERVER_OWNED and already set), but
 *   still drops to the stored group's user — a private agent must come back
 *   under its own user, not as root.
 */
export function resolveSpawnIsolation(input: {
  mode: DeploymentMode;
  resumed: boolean;
  viewer: Viewer | null;
  groups: readonly Group[];
  /** The group the RESUMED channel already carries (null = commons / group-less). */
  storedGroupId: string | null;
}): { user: string | null; groupPatch: { group?: string } } {
  if (input.mode !== "multi-tenant") return { user: null, groupPatch: {} };
  if (input.resumed) {
    const g = input.storedGroupId ? input.groups.find((x) => x.id === input.storedGroupId) ?? null : null;
    return { user: g ? osUserFor(g) : null, groupPatch: {} };
  }
  const g = spawnGroupFor(input.viewer, input.groups);
  return {
    user: g ? osUserFor(g) : null,
    groupPatch: g ? { group: g.id } : {},
  };
}

/** The default base directory a group's HOME is created under. Overridable
 *  (`SHADOK_HOME_BASE`) for unusual layouts; `/home` is the Linux standard. */
export const DEFAULT_HOME_BASE = "/home";

// ── Shared Claude credential (Task 7) ─────────────────────────────────────────
//
// One Claude OAuth subscription is shared across every group's OS user: this is
// how the single-user instance already works (one `.credentials.json`, ~30 claude
// processes reading it). In multi-tenant each group HOME's
// `~/.claude/.credentials.json` is a SYMLINK to one shared file that lives OUTSIDE
// every HOME, so the rest of the HOME stays private (Task 6's chmod 700) while
// this one file is shared.
//
// THE SHARED FILE MUST BE GROUP-TRAVERSABLE. The first cut pointed the symlink at
// the server's own `~/.claude/.credentials.json` = `/root/.claude/...` when the
// server runs as root. `/root` is mode 700, so an `sk-*` group user gets EACCES
// traversing it and runs with NO credential — a SILENT break (the file itself was
// 660, which is why it looked fine). So the canonical shared path is a NEUTRAL,
// group-traversable location (`DEFAULT_SHARED_CREDENTIAL_PATH`, overridable via
// `SHADOK_SHARED_CREDENTIAL_PATH`), and the wiring makes the directory CHAIN to it
// traversable by `shadok-cred` (dir `root:shadok-cred` 0750, file 0660).
//
// T15 CARRY: Task 7 only USES this neutral path and wires traversable perms; the
// migration task (T15) is what SEEDS/populates the neutral file from the existing
// credential and symlinks the commons HOME to it. Until T15 runs (or the instance
// signs in), the file may be absent — provisioning then REFUSES loudly with a
// clear cause rather than spawning an agent credential-less (see
// `provisionGroupUser`).
//
// VERIFY-FIRST GATE (controller ruling, spec `[builder — verify BEFORE planning
// the auth path]`): the whole scheme assumes `claude` refreshes the credential
// IN PLACE (open+rewrite the same inode). A live investigation was INCONCLUSIVE
// and LEANED toward write-new-then-rename (the CLI uses write-tmp-then-rename for
// some files). The decision was to ship the symlink scheme NOW (it matches the
// working single-user instance) and make the rename-failure mode LOUD and
// diagnosable — see `classifyCredentialLink` / `checkCredentialDivergence`. If a
// real multi-user instance CONFIRMS rename, the follow-up is a full auth broker
// (a single owner process holds the credential and hands out read-only copies;
// agents never refresh directly) — `src/auth-broker.ts`, flagged, this PR on HOLD
// for exactly that test. Do NOT build the broker until rename is confirmed.

/** The shared unix group that owns the one credential file. Every provisioned
 *  `sk-<id>` user is added to it, and the file is group-owned by it with mode
 *  660, so any group user can READ and (for an in-place refresh) WRITE it while
 *  the refresh stays readable by the others. */
export const SHARED_CRED_GROUP = "shadok-cred";

/**
 * The NEUTRAL, group-traversable canonical path the shared credential lives at
 * by default (overridable via `SHADOK_SHARED_CREDENTIAL_PATH` in `server.ts`).
 *
 * Deliberately NOT under `/root` (or any user HOME): `/root` is mode 700, so a
 * group user cannot traverse it and would run credential-less in SILENCE even
 * though the file itself is 660. `/var/lib/shadok-ai/` is a standard, neutral
 * place whose chain we can make group-traversable. The file here is SEEDED by
 * the migration task (T15); Task 7 only points the symlinks at it and wires the
 * traversable perms on the directory chain.
 */
export const DEFAULT_SHARED_CREDENTIAL_PATH = "/var/lib/shadok-ai/credentials/.credentials.json";

/**
 * The symlink a group HOME gets and the shared file it points at. Pure. The link
 * is always `<home>/.claude/.credentials.json`; the target is the server-owned
 * shared credential path, which lives OUTSIDE the HOME (so Task 6's 0700 wall on
 * the HOME is untouched — only this single file crosses it).
 */
export function credentialWiring(home: string, sharedCredentialPath: string): { link: string; target: string } {
  return { link: `${home}/.claude/.credentials.json`, target: sharedCredentialPath };
}

/**
 * The exact, ordered privileged commands that wire a group HOME to the shared
 * credential. Pure (a list of `[cmd, argv]`) so the sequence is locked by test,
 * exactly like `provisionPlan`'s `useradd`. Run as root through the injected
 * `run` in `provisionGroupUser`. Each step is load-bearing:
 * - `groupadd -f` the shared group (idempotent across re-provision);
 * - `install -d` the shared file's DIRECTORY as `root:shadok-cred` mode 0750, so
 *   the chain to the credential is TRAVERSABLE by every group user (group execute
 *   = traverse). Without this the file is 660 but unreachable — a silent no-auth
 *   spawn. The directory's contents stay root-owned; only traverse is granted;
 * - `usermod -aG` adds THIS user to the shared group (so it can read+write it);
 * - `install -d -o <user> -g <user> -m 700 <home>/.claude`: creates+owns the dir
 *   ATOMICALLY and does NOT follow a final planted symlink the way mkdir+chown
 *   would (Important #2 belt; the lstat refusal in `provisionGroupUser` is the
 *   suspenders). Task 6's wall — only this user traverses it;
 * - `ln -sfn` the symlink (`-f` replace, `-n` don't deref an existing link, so a
 *   re-provision never nests link-in-link), then chown -h it to the user;
 * - `chgrp`/`chmod 660` the SHARED file so every member user reads+writes it and
 *   an in-place refresh by any one of them stays readable by the others.
 *
 * WHITELIST: the only paths whose owner/group/mode this plan touches are the
 * shared file, its parent dir, `<home>/.claude` and the link — nothing else.
 */
export function credentialWiringPlan(
  user: string,
  home: string,
  sharedCredentialPath: string,
): Array<[string, string[]]> {
  const { link, target } = credentialWiring(home, sharedCredentialPath);
  const claudeDir = `${home}/.claude`;
  const sharedDir = path.dirname(sharedCredentialPath);
  return [
    ["groupadd", ["-f", SHARED_CRED_GROUP]],
    ["install", ["-d", "-o", "root", "-g", SHARED_CRED_GROUP, "-m", "0750", sharedDir]],
    ["usermod", ["-aG", SHARED_CRED_GROUP, user]],
    ["install", ["-d", "-o", user, "-g", user, "-m", "700", claudeDir]],
    ["ln", ["-sfn", target, link]],
    ["chown", ["-h", `${user}:${user}`, link]],
    ["chgrp", [SHARED_CRED_GROUP, sharedCredentialPath]],
    ["chmod", ["660", sharedCredentialPath]],
  ];
}

/**
 * What an lstat of a group HOME's `.credentials.json` found, as FOUR distinct
 * facts. Injected so the classifier stays pure and the real `fs` probe lives in
 * `server.ts`. `cannot-stat` is EACCES/other errors (a non-root server that
 * cannot read a 700 HOME); it is deliberately SEPARATE from `missing` (ENOENT).
 */
export type LinkProbe =
  | { state: "symlink"; target: string }
  | { state: "file" }
  | { state: "missing" }
  | { state: "cannot-stat" };

/**
 * The verify-first gate's category for a HOME credential, from an `lstat` probe:
 * - `symlink-ok` — the symlink we posed, pointing at the shared file;
 * - `wrong-target` — a symlink, but to something else;
 * - `real-file` — a REAL file where the symlink should be. THIS is the signature
 *   of a write-new-then-rename refresh (`claude` wrote a fresh 0600 file over the
 *   symlink), which breaks the shared scheme for multi-user;
 * - `missing` — no link at all (a pre-Task-7 HOME, or not yet wired);
 * - `cannot-stat` — the server could not lstat it (permission). NOT a rename.
 *
 * Only `real-file` is the genuine rename divergence. Collapsing `cannot-stat`
 * into divergence is what produced a FALSE "rename" warning on every spawn when a
 * non-root server could not read a 700 HOME.
 */
export type CredentialLinkState = "symlink-ok" | "wrong-target" | "real-file" | "missing" | "cannot-stat";

export function classifyCredentialLink(sharedCredentialPath: string, probe: LinkProbe): CredentialLinkState {
  switch (probe.state) {
    case "symlink":
      return probe.target === sharedCredentialPath ? "symlink-ok" : "wrong-target";
    case "file":
      return "real-file";
    case "missing":
      return "missing";
    case "cannot-stat":
      return "cannot-stat";
  }
}

/**
 * Run the divergence check for one group and, ONLY on a genuine `real-file`
 * divergence, emit a CLEAR warning naming the group and what it means —
 * converting a SILENT auth break (every agent in the group starts getting 401s
 * with "nothing changed on my side") into an actionable signal during the
 * hold-test. Returns the category so the caller can dedupe (warn once per group).
 *
 * The `warn` sink is injected so the firing is unit-testable; it defaults to
 * `console.warn`. `missing` / `wrong-target` / `cannot-stat` are NOT warned: a
 * missing link is a not-yet-wired HOME and a cannot-stat is a permission quirk of
 * a non-root probe — neither is the rename signal, and warning on them is the
 * false alarm this split removes.
 */
export function checkCredentialDivergence(
  group: { id: string; home: string },
  sharedCredentialPath: string,
  deps: { probe: (p: string) => LinkProbe; warn?: (msg: string) => void },
): CredentialLinkState {
  const { link } = credentialWiring(group.home, sharedCredentialPath);
  const state = classifyCredentialLink(sharedCredentialPath, deps.probe(link));
  if (state === "real-file") {
    (deps.warn ?? console.warn)(
      `CREDENTIAL DIVERGENCE: group "${group.id}" HOME credential ${link} is no longer the shared ` +
        `symlink — it is now a REAL file. This is the signature of \`claude\` refreshing the OAuth token by ` +
        `write-new-then-rename, which BREAKS the shared-credential symlink scheme for multi-user: every other ` +
        `group can no longer read the credential. An AUTH BROKER is required (Task 7 / spec verify-first gate); ` +
        `this PR is on HOLD pending the real multi-user rename test.`,
    );
  }
  return state;
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
  const home = `${homeBase}/${user}`;
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
    seed: (home: string) => Promise<void>;
    homeBase: string;
    userExists?: (u: string) => Promise<boolean>;
    /** Task 7: when set (multi-tenant only), wire this HOME to the one shared
     *  Claude credential — symlink it in + shared-group the file. Absent in
     *  mono-tenant, so the credential wiring is byte-for-byte skipped there. */
    sharedCredentialPath?: string;
    /** Important #2: lstat `<home>/.claude` BEFORE any chown/chmod, so root never
     *  follows an agent-planted symlink and hands the agent ownership of its
     *  target. Injected (the real `fs` probe lives in `server.ts`); when present
     *  and the path is a symlink or a non-directory, provisioning REFUSES. */
    claudeDirStat?: (claudeDir: string) => { exists: boolean; isSymlink: boolean; isDir: boolean };
    /** Important #3: does the shared credential FILE exist? Absent ⇒ the instance
     *  is not signed in to Claude / T15 has not seeded it. Provisioning refuses
     *  with a clear cause rather than letting the later `chgrp` throw opaquely. */
    sharedCredentialExists?: (p: string) => boolean;
    /** Important #1: AFTER wiring, is the shared target actually reachable by the
     *  group user (best-effort — an actual read as the user if feasible, else a
     *  mode/owner inspection of the chain)? A false verdict THROWS: never let a
     *  spawn proceed credential-less in silence. */
    reachable?: (user: string, link: string) => Promise<{ ok: boolean; detail?: string }>;
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

  // Task 7: share the one Claude credential into this HOME (multi-tenant only —
  // `sharedCredentialPath` is absent in mono-tenant, so nothing runs). A failure
  // here is as fatal as a failed chmod: an agent whose credential symlink was
  // never posed (or is unreachable) cannot authenticate, which is a BROKEN wall,
  // so each step THROWS rather than spawn an agent credential-less in silence.
  if (deps.sharedCredentialPath) {
    const shared = deps.sharedCredentialPath;
    const { link } = credentialWiring(plan.home, shared);
    const claudeDir = `${plan.home}/.claude`;

    // Important #2: refuse to wire THROUGH an agent-planted symlink. If `.claude`
    // exists and is a symlink (or a non-directory), a root chown/chmod would
    // dereference it and hand the agent ownership of an arbitrary dir. The
    // `install -d` below is symlink-safe too, but this is the explicit guard.
    if (deps.claudeDirStat) {
      const st = deps.claudeDirStat(claudeDir);
      if (st.exists && (st.isSymlink || !st.isDir)) {
        throw new Error(
          `provisionGroupUser: refusing to wire credential — ${claudeDir} is a symlink or not a directory ` +
            `(an agent may have planted it); not following it with chown/chmod`,
        );
      }
    }

    // Important #3: a clear cause when the shared file is absent. The migration
    // (T15) seeds it; until then (or until the instance signs in) it may not
    // exist, and the `chgrp`/`chmod 660` below would throw opaquely.
    if (deps.sharedCredentialExists && !deps.sharedCredentialExists(shared)) {
      throw new Error(
        `provisionGroupUser: shared Claude credential not found at ${shared} — is the instance signed in to ` +
          `Claude? (provisioning refused rather than spawn without auth)`,
      );
    }

    try {
      for (const [cmd, argv] of credentialWiringPlan(plan.user, plan.home, shared)) {
        await deps.run(cmd, argv);
      }
    } catch (e) {
      throw new Error(
        `provisionGroupUser: credential wiring for ${plan.user} failed: ${(e as Error)?.message ?? e}`,
      );
    }

    // Important #1: PROVE the target is actually reachable by the group user
    // after wiring. The old /root path passed every wiring step yet left the file
    // unreachable (700 ancestor) — a silent no-credential spawn. If the check
    // says unreachable, THROW.
    if (deps.reachable) {
      const r = await deps.reachable(plan.user, link);
      if (!r.ok) {
        throw new Error(
          `provisionGroupUser: shared credential ${shared} is not reachable by ${plan.user}` +
            `${r.detail ? ` (${r.detail})` : ""} — refusing to spawn credential-less`,
        );
      }
    }
  }

  try {
    // Seed HOME regardless of whether the user was new: this is where the
    // per-HOME ~/.claude seeding, the credential symlink (Task 7) and the shared
    // mount (Task 12) hang, all of which must be safe to re-apply.
    await deps.seed(plan.home);
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
 *   be a real same-origin browser — an agent carries the bootstrap admin cookie
 *   and would otherwise reach it (invariant 26, exactly like `PUT /profiles`).
 * - instance (409) and sign-in (403): the existing guards, kept.
 * - mono-tenant REFUSES a private/restricted create via `isolationRefusal`
 *   (409): never mint a group that cannot actually isolate.
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
    isolationRefusal: (mode: DeploymentMode) => string | null;
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

  if (input.nature !== "public") {
    const refusal = deps.isolationRefusal(input.mode);
    if (refusal) return { status: 409, body: { error: refusal } };
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
  if (input.nature === "private") g.owner = input.account.name;
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
    account: { name: string } | null;
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
