/**
 * Private groups — who may see an agent (spec:
 * docs/superpowers/specs/2026-10-29-private-groups-design.md).
 *
 * A tab group can be made private; only its members see the agents inside it.
 * Everyone else sees that the group EXISTS (name, members, how many agents) and
 * nothing more. Every rule lives here, pure, so the server only has to ask.
 *
 * This is the visibility layer only: agents share the server's OS user, so
 * anything with a shell can still read transcripts on disk.
 */
import type { Channel } from "./channels.js";
import { BOOTSTRAP_ADMIN } from "./accounts.js";

/**
 * The instance password's account can never hold a private group: it is
 * injected into EVERY agent's env (`SHADOK_AUTH`), so a group it belonged to
 * would be readable by any agent on the instance. Privacy is for named accounts.
 */
export function canHoldPrivate(name: string): boolean {
  return !!name && name !== BOOTSTRAP_ADMIN;
}

/** Who is asking. `all` is the server itself (or an instance with no password,
 *  where accounts — and with them privacy — do not exist). */
export type Viewer =
  | { kind: "all" }
  | { kind: "person"; name: string }
  | { kind: "agent"; sessionId: string };

/** A tab group as stored. Cosmetic fields are the client's; `private`,
 *  `members` and `owner` are the server's. */
export interface Group {
  id: number;
  name?: string;
  private?: boolean;
  members?: string[];
  owner?: string;
  [k: string]: unknown;
}

/** The fields a client can never write through `PUT /groups`. */
const ACCESS_FIELDS = ["private", "members", "owner"] as const;

export function isPrivate(g: Group | undefined | null): boolean {
  return !!g && g.private === true;
}

function groupById(groups: Group[], id: unknown): Group | undefined {
  return id == null ? undefined : groups.find((g) => g && g.id === id);
}

/** The private group a channel sits in, if any. */
export function privateGroupOf(c: Pick<Channel, "group"> | undefined, groups: Group[]): Group | undefined {
  const g = groupById(groups, c?.group);
  return isPrivate(g) ? g : undefined;
}

/**
 * May this viewer see what is inside this group? A public group: yes. A private
 * one: a member, the server, or an agent that lives in it.
 */
export function canSeeGroup(viewer: Viewer, g: Group | undefined, channels: Channel[]): boolean {
  if (!isPrivate(g)) return true;
  if (viewer.kind === "all") return true;
  if (viewer.kind === "person") return canHoldPrivate(viewer.name) && (g!.members ?? []).includes(viewer.name);
  const own = channels.find((c) => c.sessionId === viewer.sessionId);
  return own?.group === g!.id;
}

export function canSeeChannel(viewer: Viewer, c: Channel | undefined, groups: Group[], channels: Channel[]): boolean {
  if (!c) return true; // not in the registry: nothing private to protect
  if (viewer.kind === "agent" && c.sessionId === viewer.sessionId) return true;
  return canSeeGroup(viewer, privateGroupOf(c, groups), channels);
}

/** Can the viewer see the agent with this id? An id the registry does not know
 *  is not private (a session that never got a channel row). */
export function canSeeSession(viewer: Viewer, id: string, groups: Group[], channels: Channel[]): boolean {
  return canSeeChannel(viewer, channels.find((c) => c.sessionId === id), groups, channels);
}

export function visibleChannels(viewer: Viewer, channels: Channel[], groups: Group[]): Channel[] {
  return channels.filter((c) => canSeeChannel(viewer, c, groups, channels));
}

/**
 * The group list as this viewer may read it. A private group they are not in is
 * reduced to its existence: name, icon, order, members, owner, and how many
 * agents it holds — never which ones.
 */
export function groupsView(viewer: Viewer, groups: Group[], channels: Channel[]): Group[] {
  return groups.map((g) => {
    if (canSeeGroup(viewer, g, channels)) return g;
    return {
      id: g.id,
      name: g.name,
      ...(g.icon !== undefined ? { icon: g.icon } : {}),
      ...(g.order !== undefined ? { order: g.order } : {}),
      private: true,
      locked: true,
      members: g.members ?? [],
      ...(g.owner ? { owner: g.owner } : {}),
      agentCount: channels.filter((c) => c.group === g.id).length,
    };
  });
}

/**
 * Merge a client's `PUT /groups` into what is stored. A client owns the
 * cosmetic fields of the groups it can see; it never owns the access fields,
 * and it can neither edit nor delete a private group it is not in (its list
 * only carries a stub of it, or omits it).
 */
export function mergeClientGroups(viewer: Viewer, stored: Group[], incoming: unknown, channels: Channel[]): Group[] {
  const list = Array.isArray(incoming) ? incoming : [];
  const prevById = new Map(stored.map((g) => [g.id, g]));
  const result: Group[] = [];
  const seen = new Set<unknown>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || seen.has((raw as Group).id)) continue;
    const g = raw as Group;
    seen.add(g.id);
    const prev = prevById.get(g.id);
    if (prev && !canSeeGroup(viewer, prev, channels)) {
      result.push(prev); // a stub coming back: keep the real row, untouched
      continue;
    }
    const merged: Group = { ...g };
    delete merged.locked;
    delete merged.agentCount;
    for (const k of ACCESS_FIELDS) {
      delete merged[k];
      if (prev && prev[k] !== undefined) (merged as Record<string, unknown>)[k] = prev[k];
    }
    result.push(merged);
  }
  // A private group the client omitted: kept unless a member deleted it.
  for (const g of stored) {
    if (seen.has(g.id)) continue;
    if (isPrivate(g) && !canSeeGroup(viewer, g, channels)) result.push(g);
  }
  return result;
}

/**
 * Merge a client's `PUT /channels` body against privacy: hidden agents are
 * removed from the body (so a crafted entry cannot rewrite them) and reported so
 * the caller keeps them; a move into a private group the viewer is not in is
 * reverted. The result goes to `mergeChannels` with `keep` added to the ids it
 * never drops.
 */
export function guardClientChannels(
  viewer: Viewer,
  stored: Channel[],
  groups: Group[],
  incoming: unknown,
): { body: Channel[]; keep: Set<string> } {
  const prevById = new Map(stored.map((c) => [c.sessionId, c]));
  const keep = new Set(stored.filter((c) => !canSeeChannel(viewer, c, groups, stored)).map((c) => c.sessionId));
  const body: Channel[] = [];
  for (const c of Array.isArray(incoming) ? (incoming as Channel[]) : []) {
    if (!c || typeof c.sessionId !== "string" || keep.has(c.sessionId)) continue;
    const prev = prevById.get(c.sessionId);
    if (c.group !== (prev?.group ?? null) && c.group != null) {
      const verdict = moveVerdict(viewer, prev ?? c, c.group, groups, stored);
      if (verdict) {
        body.push({ ...c, group: prev?.group ?? null });
        continue;
      }
    }
    body.push(c);
  }
  return { body, keep };
}

/**
 * Why this viewer may not put this agent into group `to`, or null if it may.
 * Moving into a private group needs membership; a Telegram-bound agent cannot
 * go private, since a board group is shared with everyone in it.
 */
export function moveVerdict(
  viewer: Viewer,
  c: Pick<Channel, "telegram" | "home">,
  to: number | null | undefined,
  groups: Group[],
  channels: Channel[],
): string | null {
  const g = groupById(groups, to);
  if (!isPrivate(g)) return null;
  if (!canSeeGroup(viewer, g, channels)) return "not a member of that private group";
  if (c.telegram) return "this agent is mirrored to Telegram — stop mirroring it before making it private";
  return null;
}

/** The group a NEW agent should land in: the one asked for, if allowed, else the
 *  parent's private group, so delegated work never leaks into the open. */
export function spawnGroup(
  viewer: Viewer,
  asked: number | null | undefined,
  parent: string | null | undefined,
  groups: Group[],
  channels: Channel[],
): number | null | undefined {
  if (asked != null && !moveVerdict(viewer, {}, asked, groups, channels)) return asked;
  const p = parent ? channels.find((c) => c.sessionId === parent) : undefined;
  return privateGroupOf(p, groups)?.id;
}

export type AccessResult = { ok: true; groups: Group[] } | { ok: false; error: string };

/** Only a signed-in PERSON who is (or becomes, as creator) a member manages a
 *  private group — never an agent, never the server acting on its own. */
function personOnly(viewer: Viewer): string | null {
  if (viewer.kind !== "person") return "only a signed-in person can manage a private group";
  if (!canHoldPrivate(viewer.name))
    return "the instance password is shared with every agent — sign in with your own account to use private groups";
  return null;
}

/**
 * Make group `id` private (creator becomes owner and member) or public again
 * (members only — this exposes its agents to everyone).
 */
export function setPrivate(
  viewer: Viewer,
  groups: Group[],
  channels: Channel[],
  id: number,
  on: boolean,
  accountsEnabled: boolean,
): AccessResult {
  const who = personOnly(viewer);
  if (who) return { ok: false, error: who };
  if (!accountsEnabled) return { ok: false, error: "private groups need accounts — set a GUI password first" };
  const g = groupById(groups, id);
  if (!g) return { ok: false, error: "no such group" };
  const name = (viewer as { name: string }).name;
  if (on) {
    if (isPrivate(g)) return { ok: false, error: "already private" };
    const bound = channels.find((c) => c.group === id && c.telegram);
    if (bound) return { ok: false, error: "an agent in this group is mirrored to Telegram — stop mirroring it first" };
    return { ok: true, groups: groups.map((x) => (x === g ? { ...x, private: true, owner: name, members: [name] } : x)) };
  }
  if (!isPrivate(g)) return { ok: false, error: "not private" };
  if (!canSeeGroup(viewer, g, channels)) return { ok: false, error: "not a member of that private group" };
  return {
    ok: true,
    groups: groups.map((x) => {
      if (x !== g) return x;
      const { private: _p, members: _m, owner: _o, ...rest } = x;
      return rest as Group;
    }),
  };
}

/** Replace a private group's member list. Members only; existing accounts
 *  only; never empty. */
export function setMembers(
  viewer: Viewer,
  groups: Group[],
  channels: Channel[],
  id: number,
  members: unknown,
  accountNames: string[],
): AccessResult {
  const who = personOnly(viewer);
  if (who) return { ok: false, error: who };
  const g = groupById(groups, id);
  if (!g || !isPrivate(g)) return { ok: false, error: "no such private group" };
  if (!canSeeGroup(viewer, g, channels)) return { ok: false, error: "not a member of that private group" };
  if (!Array.isArray(members) || members.some((m) => typeof m !== "string"))
    return { ok: false, error: "members must be a list of account names" };
  const list = [...new Set((members as string[]).map((m) => m.trim()).filter(Boolean))];
  const unknown = list.filter((m) => !accountNames.includes(m));
  if (unknown.length) return { ok: false, error: `no such account: ${unknown.join(", ")}` };
  if (list.some((m) => !canHoldPrivate(m)))
    return { ok: false, error: `${BOOTSTRAP_ADMIN} is the instance password, shared with every agent — it cannot be a member` };
  if (!list.length) return { ok: false, error: "a private group needs at least one member" };
  return { ok: true, groups: groups.map((x) => (x === g ? { ...x, members: list } : x)) };
}

/** An account was deleted: it leaves every private group. Without this, an
 *  admin could delete a member and re-invite the same name to walk in. */
export function dropMember(groups: Group[], name: string): Group[] {
  return groups.map((g) =>
    isPrivate(g) && (g.members ?? []).includes(name) ? { ...g, members: (g.members ?? []).filter((m) => m !== name) } : g,
  );
}
