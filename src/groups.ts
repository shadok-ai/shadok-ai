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
      return actor.role === "admin" ? { ok: true } : { ok: false, error: "only an admin can remove a member" };
  }
}

/**
 * The channels a viewer may see. A channel with no group (legacy / commons) is
 * public. A channel whose group id resolves to nothing is ALSO kept: fail-open
 * on an unknown group, because hiding a channel the server itself made would
 * strand it, whereas restricted groups are always known when they exist.
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

/** An account as a Viewer (null passes through). */
export function viewerFor(account: { name: string; role: Role } | null): Viewer | null {
  return account ? { name: account.name, role: account.role } : null;
}
