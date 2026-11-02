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
