import type { Role } from "./accounts.js";
import type { Channel } from "./channels.js";

/**
 * Groups: the unit of isolation between people sharing one cockpit. Pure and
 * dependency-free (type-only import, erased at runtime) so the whole access
 * model can be unit-tested without a server — the same split `kinship.ts` uses.
 *
 * Two different questions are kept apart on purpose: who may SEE/DRIVE a group's
 * agents (membership), and who may ADMINISTER it (an admin's reach is wider than
 * its view — it can manage a team without reading its conversations).
 */

export type Nature = "private" | "restricted" | "public";

export interface Group {
  id: string;
  name: string;
  nature: Nature;
  members: string[];
  owner?: string;
  osUser?: string | null;
  createdAt: number;
}

/** The shared public group every instance starts with. */
export const MAIN_GROUP_ID = "main";

export interface Viewer {
  name: string;
  role: Role;
}

/** A private group's owner counts as a member even if the list omits them. */
export function memberOf(g: Group, name: string): boolean {
  return g.members.includes(name) || (g.nature === "private" && g.owner === name);
}

/** Operational visibility, and also the see/drive rule. An admin is NOT exempt. */
export function canSeeGroup(g: Group, viewer: Viewer | null): boolean {
  if (g.nature === "public") return true;
  return viewer !== null && memberOf(g, viewer.name);
}

/** Admin reach: never over a private group; admins or members otherwise. */
export function canAdministerGroup(g: Group, viewer: Viewer | null): boolean {
  if (viewer === null || g.nature === "private") return false;
  return viewer.role === "admin" || memberOf(g, viewer.name);
}

export function visibleGroupIds(groups: readonly Group[], viewer: Viewer | null): Set<string> {
  return new Set(groups.filter((g) => canSeeGroup(g, viewer)).map((g) => g.id));
}

/**
 * The groups a viewer may LIST (`GET /groups`). A group row leaks its
 * `members`/`owner`/`osUser`, so the list must be filtered by the caller or a
 * non-member learns a restricted group's roster and a private group's very
 * existence (which "a private group is invisible even to an admin" forbids).
 *
 * A row is kept iff the viewer may SEE it (`canSeeGroup`) OR ADMINISTER it
 * (`canAdministerGroup`). The admin nuance is REQUIRED, not cosmetic: an admin
 * administers restricted groups (their membership/secrets) WITHOUT being a
 * member, so must still see their rows — a plain `canSeeGroup`/`visibleGroupIds`
 * alone would wrongly hide a restricted group from the very admin who manages
 * it. And `canAdministerGroup` returns false for a PRIVATE group the viewer does
 * not own, so a foreign private group stays hidden even from an admin.
 *
 * Row-level only (which groups), never field-level: a group the viewer can SEE
 * but is not a member/admin of is public, whose `members` are already empty; a
 * restricted/private group only survives the filter for a member/admin, who may
 * read its members. So there is nothing left to trim.
 *
 * A null viewer (no account) sees public groups only. Mono-tenant (only a public
 * Main exists) → everyone keeps Main, unchanged.
 */
export function listableGroups(groups: readonly Group[], viewer: Viewer | null): Group[] {
  return groups.filter((g) => canSeeGroup(g, viewer) || canAdministerGroup(g, viewer));
}

/**
 * May `viewer` see the SESSION identified by `sessionId`? The HTTP-route mirror
 * of the WS `mayDriveSession` and `GET /live`'s `visible()` — the same group
 * boundary, reused by the routes that return a single session's content or
 * metadata (`/diff`, `/recover`, `/sessions`), so agent-by-session-key and
 * browser-by-account resolve identically. Keyed on the channel registry, which
 * is the authority on where a session lives (invariant 1); the request only ever
 * names the id/path asked about, never its own group.
 *
 *  - no `sessionId`, or a session with no channel row, or a channel with no group
 *    → commons / legacy, visible to everyone (today's behaviour);
 *  - a channel whose group resolves → visible iff `canSeeGroup` (an admin is NOT
 *    exempt — a restricted group's agents run as a member, not the admin);
 *  - a channel whose group id does NOT resolve → HIDDEN (fail-closed), the twin
 *    of `visibleChannels` and `canResumeAs`.
 */
export function canSeeSession(
  sessionId: string | null | undefined,
  channels: readonly Channel[],
  groups: readonly Group[],
  viewer: Viewer | null,
): boolean {
  if (!sessionId) return true; // no id to resolve → legacy / commons
  const gid = channels.find((c) => c.sessionId === sessionId)?.group ?? null;
  if (!gid) return true; // commons / group-less
  const g = groups.find((x) => x.id === gid);
  if (!g) return false; // dangling group → fail closed
  return canSeeGroup(g, viewer);
}

/**
 * Who may change a group's membership. Refusals are explicit strings, never a
 * silent no-op. Only `restricted` groups have a mutable roster.
 */
export function membershipVerdict(
  actor: Viewer | null,
  g: Group,
  action: "invite" | "leave" | "remove",
  target: string,
): { ok: true } | { ok: false; error: string } {
  if (actor === null) return { ok: false, error: "not signed in" };
  if (g.nature !== "restricted") {
    return { ok: false, error: `membership of a ${g.nature} group cannot be changed` };
  }
  switch (action) {
    case "invite":
      return memberOf(g, actor.name) ? { ok: true } : { ok: false, error: "only a member can invite" };
    case "leave":
      return actor.name === target ? { ok: true } : { ok: false, error: "you can only remove yourself" };
    case "remove":
      // Mirrors `invite`: whoever may add a member may also remove one (a Private
      // group is run by its members); an admin keeps the override.
      return memberOf(g, actor.name) || actor.role === "admin"
        ? { ok: true }
        : { ok: false, error: "only a member can remove a member" };
  }
}

/**
 * The sealed private group a given account OWNS, or null. Pure, so the account
 * lifecycle hooks (Task 16) can be reasoned about with no server: one person maps
 * to exactly ONE private group (`owner === name`), which is what makes both the
 * invite-provision (idempotency check: already provisioned?) and the delete
 * cascade (which group to tear down?) a single lookup rather than a scan repeated
 * at two call sites. Keyed on `owner`, never on `members`: a private group's
 * roster can list the owner (the brief) or omit them (`memberOf` treats the owner
 * as a member either way) — only the owner is the durable identity.
 */
export function privateGroupFor(accountName: string, groups: readonly Group[]): Group | null {
  return groups.find((g) => g.nature === "private" && g.owner === accountName) ?? null;
}

/**
 * A fresh sealed private group for a person (Task 16's invite-provision). The
 * owner is also listed as the sole member (the brief's exact shape
 * `{nature:"private", owner:name, members:[name]}`), which is redundant with
 * `memberOf` but unambiguous on disk. `osUser` is left null here — the server
 * sets it via `osUserFor` (osusers.ts) before persisting, exactly as
 * `migProvisionPrivateGroup` does; keeping this pure avoids a groups↔osusers
 * import cycle (osusers already imports groups).
 */
export function newPrivateGroup(accountName: string, id: string, now: number): Group {
  return {
    id,
    name: accountName,
    nature: "private",
    members: [accountName],
    owner: accountName,
    osUser: null,
    createdAt: now,
  };
}

/** An account dropped from a members list (new array, order preserved). */
export function membersWithout(members: readonly string[], accountName: string): string[] {
  return members.filter((m) => m !== accountName);
}

/**
 * The group-list change when an account is DELETED (pure — Task 16's cascade).
 *
 * Two different things happen to the two kinds of group the person touched, and
 * the distinction is the whole point:
 *  - their SEALED PRIVATE group (`owner === name`) is TORN DOWN — returned as
 *    `torndown` so the caller can `teardownGroupUser` it (OS user, HOME, agents)
 *    and its row is removed from the list;
 *  - every RESTRICTED group they were a member of SURVIVES; the person is merely
 *    dropped from its `members` (never tear down a shared group because one
 *    member left — the brief).
 *
 * Returns `{ torndown, groups }`: the group to tear down (or null — mono-tenant,
 * or a person with no private group yet), and the remaining list to persist.
 */
export function accountDeleteGroups(
  accountName: string,
  groups: readonly Group[],
): { torndown: Group | null; groups: Group[] } {
  const torndown = privateGroupFor(accountName, groups);
  const remaining = groups
    .filter((g) => !(torndown && g.id === torndown.id))
    .map((g) =>
      g.members.includes(accountName) ? { ...g, members: membersWithout(g.members, accountName) } : g,
    );
  return { torndown, groups: remaining };
}

/**
 * The channels a viewer may see:
 * - a channel with NO group is kept: it is commons, visible to everyone;
 * - a channel whose group resolves to a known group is kept iff the viewer may
 *   see that group (`canSeeGroup`);
 * - a channel whose group id resolves to NO known group is HIDDEN (fail-closed).
 *   A dangling or lost group row (e.g. a deleted or corrupt restricted group)
 *   must never flip its channels to visible-to-everyone: confidentiality comes
 *   first, so when in doubt the safe direction is to hide, not reveal.
 */
export function visibleChannels(
  channels: readonly Channel[],
  groups: readonly Group[],
  viewer: Viewer | null,
): Channel[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return channels.filter((c) => {
    if (!c.group) return true;
    const g = byId.get(c.group);
    if (!g) {
      // Fail closed: a dangling group id must never flip a channel to visible.
      console.warn(`groups: channel ${c.sessionId} references unknown group ${c.group}; hiding it`);
      return false;
    }
    return canSeeGroup(g, viewer);
  });
}

/**
 * The group a caller spawns a NEW agent into, derived from identity alone.
 *
 * A client never names its own group (it would just claim someone else's), so
 * this takes only the viewer and the server's group list. The rule:
 * - a member of exactly ONE non-public group → that group (their own);
 * - anyone else (no group, or several — which is ambiguous) → the commons.
 *
 * Falling back to the COMMONS on ambiguity is the safe direction: it never puts
 * an agent into a group the caller might not have meant, and never under another
 * group's OS user. Explicit cross-group selection is a later task; until then an
 * agent is born either in its caller's one group or in the shared commons.
 *
 * Returns null only when there is no group at all to resolve to (no `main`, no
 * public group) — the caller then treats it as the group-less commons.
 */
export function spawnGroupFor(viewer: Viewer | null, groups: readonly Group[]): Group | null {
  const commons = groups.find((g) => g.id === MAIN_GROUP_ID) ?? groups.find((g) => g.nature === "public") ?? null;
  if (!viewer) return commons;
  const own = groups.filter((g) => g.nature !== "public" && memberOf(g, viewer.name));
  return own.length === 1 ? own[0] : commons;
}

/**
 * The group a NEW agent is born into when the caller MAY name a target.
 *
 * The requested group is honoured only when the caller can see it (`canSeeGroup`:
 * public, or they are a member) — so a caller can place an agent in a group they
 * belong to, never plant one in a group they do not. Anything else (no request,
 * unknown id, foreign restricted/private group) falls back to `spawnGroupFor`.
 */
export function spawnGroupForRequest(
  viewer: Viewer | null,
  groups: readonly Group[],
  requestedGroupId: string | null,
): Group | null {
  if (requestedGroupId) {
    const g = groups.find((x) => x.id === requestedGroupId);
    if (g && canSeeGroup(g, viewer)) return g;
  }
  return spawnGroupFor(viewer, groups);
}

/**
 * May this viewer RESUME an agent that was born into `storedGroupId`?
 *
 * This is the people-boundary check on the resume path, and it is a SECURITY
 * gate, not cosmetics: the stored group drives a privilege drop to that group's
 * OS user (`osUserFor` → `setpriv`), so resuming a group's agent is exactly
 * driving a process AS that group. Without this check a member could plant a row
 * `{sessionId:"Z", group:"comex"}` (a transcript id they can read) and then
 * `start {resume:"Z"}` to come up under comex's Unix user — a privilege
 * escalation across the people wall.
 *
 * - No stored group (null) → the commons / group-less agent: always allowed,
 *   today's behaviour, no drop happens.
 * - A stored group that resolves to a known group → allowed iff `canSeeGroup`
 *   (a public group is seen by everyone; a private/restricted one only by a
 *   member — an admin is NOT exempt).
 * - A stored group id that resolves to NO known group → REFUSED (fail-closed,
 *   the twin of `visibleChannels`): an unverifiable claim is never honoured, and
 *   must never silently fall back to the commons user (that would still resume
 *   someone else's transcript).
 */
export function canResumeAs(
  storedGroupId: string | null | undefined,
  groups: readonly Group[],
  viewer: Viewer | null,
): boolean {
  if (!storedGroupId) return true;
  const g = groups.find((x) => x.id === storedGroupId) ?? null;
  if (!g) return false; // dangling group: cannot verify → fail closed
  return canSeeGroup(g, viewer);
}

/**
 * May an already-established session be RESTARTED into `storedGroupId`?
 *
 * A restart respawns a session that is ALREADY running as its group's user: the
 * people-boundary was enforced when it first spawned/resumed (`canResumeAs`), and
 * no human principal drives a restart — it is the session itself (the `restart`
 * message), the agent's own `/reload` (session-key scoped), or an admin's
 * `/restart-all`. So this deliberately does NOT re-check membership: an admin who
 * cannot SEE a private group must still be able to `/restart-all` its agents, and
 * the agent reloading itself carries no viewer. canResumeAs keyed on the
 * triggerer would wrongly refuse both.
 *
 * What it DOES guard is the one new risk a restart adds: a stored group that no
 * longer RESOLVES. `resolveSpawnIsolation` would then derive a null user and
 * respawn the private agent as the server's own (commons/root) user — a silent
 * privilege DOWNGRADE that keeps the foreign transcript running. Same fail-closed
 * direction as `visibleChannels` and `canResumeAs`: refuse rather than drop out of
 * the isolation wall.
 */
export function canRestartInto(storedGroupId: string | null | undefined, groups: readonly Group[]): boolean {
  if (!storedGroupId) return true;
  return groups.some((g) => g.id === storedGroupId);
}

/** An account as a Viewer (null passes through). */
export function viewerFor(account: { name: string; role: Role } | null): Viewer | null {
  return account ? { name: account.name, role: account.role } : null;
}

/**
 * The ids of every group a viewer is a MEMBER of (the owner of a private group
 * counts, per `memberOf`). This is the set a secret resolution reads against:
 * a member resolves their own groups' secrets, plus any shared with them, plus
 * the commons. A null viewer (a deleted account / no session) is a member of
 * nothing — only the commons remains, which is the fail-safe direction.
 */
export function memberGroupIds(groups: readonly Group[], viewer: Viewer | null): Set<string> {
  const out = new Set<string>();
  if (!viewer) return out;
  for (const g of groups) if (memberOf(g, viewer.name)) out.add(g.id);
  return out;
}

/**
 * The authoring groups a VIEWER may read ledger rows of (the group-scoped ones;
 * public rows are added by the caller regardless). It is the groups they belong
 * to, PLUS their commons home (`spawnGroupFor` — Main when they have no single
 * own group), so a commons operator still sees the commons' own rows while a
 * restricted-group member does NOT see Main-private ones. There is no
 * super-view: an admin with no memberships resolves to `{main}` exactly like
 * anyone else. Mono-tenant (no groups, or a null viewer) collapses to `{main}`,
 * which — since every row's authoring group normalises to Main there — keeps the
 * whole table visible, today's behaviour.
 */
export function ledgerGroupsFor(groups: readonly Group[], viewer: Viewer | null): Set<string> {
  const out = memberGroupIds(groups, viewer);
  const home = spawnGroupFor(viewer, groups);
  out.add(home ? home.id : MAIN_GROUP_ID);
  return out;
}

/**
 * May this viewer WRITE (create/update/delete/share/bind) a secret that belongs
 * to group `g`? A secret is a credential, so writing it is a privileged act:
 * - a PRIVATE group's secret → its OWNER only (a private group is one person's);
 * - a RESTRICTED (or any non-Main public) group's secret → a MEMBER of that
 *   group, OR an admin: a group's members co-own its vault, which is what lets a
 *   COMEX member manage COMEX's section (Task 11 — the group selector is useless
 *   to a member who cannot write their own group);
 * - the Main commons → an ADMIN (Main has no members, so `memberOf` is false for
 *   everyone and this reduces to admin-only, as before).
 *
 * An agent authenticates as the bootstrap admin, so it clears the admin bar for
 * its own commons/restricted group — which is how an agent stores a credential
 * it obtained (the `shadok-secrets` skill). A null group (unresolvable) or a
 * null viewer fails closed: never write a secret into a group we cannot verify.
 */
export function canWriteSecretGroup(g: Group | null | undefined, viewer: Viewer | null): boolean {
  if (!g || !viewer) return false;
  if (g.nature === "private") return g.owner === viewer.name;
  return viewer.role === "admin" || memberOf(g, viewer.name);
}

const sameMembers = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
};

/**
 * The server-side merge behind `PUT /groups` (pure, so the route is a thin
 * mapper and the SECURITY rule is unit-tested).
 *
 * The web client PUTs only COSMETIC fields (id, name, icon, collapsed, order) —
 * it never sends `members`/`nature`/`owner`. A naive `saveGroups(body)` would
 * therefore default those through `normalizeGroups` and silently turn a
 * restricted COMEX into an empty public group: a people-wall breach by omission.
 * So this MERGES onto the stored rows and treats the ACL fields as privileged:
 *
 * - cosmetic fields are always taken from the incoming row;
 * - `members`/`nature`/`owner` are changed ONLY when the caller is an admin AND
 *   the field is actually present; a non-admin attempting such a change is
 *   REFUSED (never a silent no-op, so the UI can say why);
 * - a brand-new id is accepted only as a PUBLIC cosmetic group — real
 *   private/restricted groups are minted by `POST /groups` (which provisions an
 *   OS user); a non-public new row is refused;
 * - a stored group the client OMITTED is preserved when it carries ACL meaning
 *   (`main`, any non-public group, or one with members): a cosmetic PUT must
 *   never DELETE a real group — that is `DELETE /groups`' job (with teardown).
 */
export function mergeGroupsPut(
  stored: readonly Group[],
  incoming: readonly unknown[],
  isAdmin: boolean,
): { ok: true; groups: Group[] } | { ok: false; error: string } {
  const byId = new Map(stored.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const out: Group[] = [];
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id =
      typeof row.id === "string" && row.id
        ? row.id
        : typeof row.id === "number" && Number.isFinite(row.id)
          ? String(row.id)
          : "";
    if (!id) continue;
    seen.add(id);
    const prev = byId.get(id);
    const wantsNature: Nature | undefined =
      row.nature === "private" || row.nature === "restricted" || row.nature === "public" ? row.nature : undefined;
    const wantsMembers = Array.isArray(row.members)
      ? (row.members.filter((m): m is string => typeof m === "string") as string[])
      : undefined;
    const wantsOwner = typeof row.owner === "string" ? row.owner : undefined;
    if (prev) {
      const natureChange = wantsNature !== undefined && wantsNature !== prev.nature;
      const membersChange = wantsMembers !== undefined && !sameMembers(wantsMembers, prev.members);
      const ownerChange = wantsOwner !== undefined && wantsOwner !== (prev.owner ?? undefined);
      // The Personal seal: a private group is immutable to everyone, admin
      // included — it goes away only with its account (DELETE /groups).
      if (prev.nature === "private" && (natureChange || membersChange || ownerChange)) {
        return { ok: false, error: "a personal group is sealed and cannot be changed" };
      }
      if ((natureChange || membersChange || ownerChange) && !isAdmin) {
        return { ok: false, error: "only an admin can change a group's membership or nature" };
      }
      // Display extras (icon/collapsed/order) travel on the row but aren't on
      // the Group type — carry them through a loose record, like normalizeGroups.
      const cosmetic: Record<string, unknown> = {};
      if (typeof row.name === "string") cosmetic.name = row.name;
      if ("icon" in row) cosmetic.icon = row.icon;
      if ("collapsed" in row) cosmetic.collapsed = row.collapsed;
      if ("order" in row) cosmetic.order = row.order;
      const acl: Partial<Group> = isAdmin
        ? {
            ...(wantsNature !== undefined ? { nature: wantsNature } : {}),
            ...(wantsMembers !== undefined ? { members: wantsMembers } : {}),
            ...(wantsOwner !== undefined ? { owner: wantsOwner } : {}),
          }
        : {};
      out.push({ ...prev, ...cosmetic, ...acl } as unknown as Group);
    } else {
      if (wantsNature === "private" || wantsNature === "restricted") {
        return { ok: false, error: "create a private or restricted group from the group panel" };
      }
      const extras: Record<string, unknown> = {};
      if ("icon" in row) extras.icon = row.icon;
      if ("collapsed" in row) extras.collapsed = row.collapsed;
      out.push({
        id,
        name: typeof row.name === "string" ? row.name : "",
        nature: "public",
        members: [],
        osUser: null,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
        ...extras,
      } as unknown as Group);
    }
  }
  for (const g of stored) {
    if (seen.has(g.id)) continue;
    if (g.id === MAIN_GROUP_ID || g.nature !== "public" || g.members.length > 0) out.push(g);
  }
  return { ok: true, groups: out };
}

/**
 * `PUT /groups`' whole decision as a transport-free `{status, body, groups?}`
 * (the twin of `createGroupFlow`), so the route is a thin mapper and every guard
 * is unit-tested with no server.
 *
 * Guard order, each load-bearing:
 * - `fromBrowser` FIRST (403): writing the group list is a cockpit act — an
 *   agent authenticates as the bootstrap admin and would otherwise edit
 *   membership/nature by `curl` (T2/T6 carry, same spirit as `POST /groups`).
 * - instance (409): the stale-tab guard, kept.
 * - the ACL merge (`mergeGroupsPut`): a non-admin membership/nature change → 403.
 */
export function groupsPutFlow(input: {
  fromBrowser: boolean;
  instanceOk: boolean;
  isAdmin: boolean;
  stored: readonly Group[];
  incoming: readonly unknown[];
}): { status: number; body: Record<string, unknown>; groups?: Group[] } {
  if (!input.fromBrowser) return { status: 403, body: { error: "group management is done from the web UI only" } };
  if (!input.instanceOk) return { status: 409, body: { error: "instance-mismatch" } };
  const r = mergeGroupsPut(input.stored, input.incoming, input.isAdmin);
  if (!r.ok) return { status: 403, body: { error: r.error } };
  return { status: 200, body: { ok: true }, groups: r.groups };
}
