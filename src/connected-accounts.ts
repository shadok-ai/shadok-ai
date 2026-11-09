import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { instanceKey } from "./paths.js";
import {
  MAIN_GROUP_ID,
  isAgentViewer,
  memberOf,
  privateGroupFor,
  viewerInGroup,
  type Group,
  type Viewer,
} from "./groups.js";

/**
 * Connected accounts (LinkedIn): a credential produced by a Connect flow, owned
 * by one person, shared under a scope and used under a policy. Server-owned,
 * NOT the secret vault — its entries are never injected into an agent's env.
 * Pure rules up top, thin fs below. Design:
 * docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md §3.
 */

/**
 * Who may use an account: a UNION of tiers, any combination of them, then
 * narrowed by profile. `personal` = the owner's own Personal group; `groups` =
 * named groups; `everyone` = Main and every public group (never someone else's
 * Personal or a restricted group the owner is not in). `profiles`, when not
 * empty, keeps only agents running one of those profiles — on top of the
 * tiers, never instead of them: the group is the wall, the profile a filter.
 */
export interface ShareScope {
  personal: boolean;
  groups: string[];
  everyone: boolean;
  profiles: string[];
}

/** What a new account starts with: its owner's Personal group, any profile. A
 *  factory, not a shared object: a spread would share the arrays. */
export function defaultShare(): ShareScope {
  return { personal: true, groups: [], everyone: false, profiles: [] };
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))] : [];

/**
 * Any stored or posted share → the current shape. Reads the v1 single-choice
 * form (`{scope:"private"|"groups"|"instance"}`) too, so an account saved
 * before the multi-choice picker keeps exactly its reach. The owner's own
 * Personal group named in `groups` folds into `personal` (the two meant the
 * same thing — the duplicate the v1 picker offered), and a PUBLIC group (Main
 * included) folds into `everyone`: the commons is one tier, and the client's
 * picker reads it the same way, so the two can never disagree on reach. Null
 * for a shape that is neither.
 */
export function normalizeShare(
  raw: unknown,
  ownerPersonalId: string | null = null,
  publicIds: ReadonlySet<string> = new Set([MAIN_GROUP_ID]),
): ShareScope | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  let out: ShareScope;
  if (typeof r.scope === "string") {
    if (r.scope === "private") out = defaultShare();
    else if (r.scope === "instance") out = { personal: false, groups: [], everyone: true, profiles: [] };
    else if (r.scope === "groups" && Array.isArray(r.groups)) out = { personal: false, groups: strList(r.groups), everyone: false, profiles: [] };
    else return null;
  } else {
    if (r.groups !== undefined && !Array.isArray(r.groups)) return null;
    if (r.profiles !== undefined && !Array.isArray(r.profiles)) return null;
    out = { personal: r.personal === true, groups: strList(r.groups), everyone: r.everyone === true, profiles: strList(r.profiles) };
  }
  if (ownerPersonalId && out.groups.includes(ownerPersonalId)) {
    out = { ...out, personal: true, groups: out.groups.filter((g) => g !== ownerPersonalId) };
  }
  if (out.groups.some((g) => publicIds.has(g))) {
    out = { ...out, everyone: true, groups: out.groups.filter((g) => !publicIds.has(g)) };
  }
  return out;
}

/** Does the share's profile filter let an agent on `profile` through? Empty filter = any profile. */
export function profileAllowed(share: ShareScope, profile: string | null | undefined): boolean {
  const profiles = Array.isArray(share?.profiles) ? share.profiles : [];
  return profiles.length === 0 || (!!profile && profiles.includes(profile));
}

export interface ConnectedAccount {
  id: string;
  provider: "linkedin";
  kind: "member" | "organization";
  label: string;
  externalId: string;
  owner: string;
  connectedVia: string;
  share: ShareScope;
  policy: "approve" | "autonomous";
  /** Never leaves the server: every route returns `publicView`. */
  token: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  status?: "ok" | "expired";
  createdAt: number;
  updatedAt: number;
}

export type PublicAccount = Omit<ConnectedAccount, "token" | "refreshToken">;

/** The ONLY shape any route returns. */
export function publicView(a: ConnectedAccount): PublicAccount {
  const { token: _t, refreshToken: _r, ...rest } = a;
  void _t;
  void _r;
  return rest;
}

// ---- store ---------------------------------------------------------------

export function accountsFileFor(cwd: string): string {
  return path.join(os.homedir(), ".shadok-ai", "connected-accounts", `${instanceKey(cwd)}.json`);
}

/** Missing or unparseable file → []. Never throws. */
export function loadAccountsStore(file: string): ConnectedAccount[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // A v1 share is read as the current shape (`normalizeShare`), so every
    // rule below only ever sees one form.
    return Array.isArray(parsed)
      ? (parsed as ConnectedAccount[]).map((a) => ({ ...a, share: normalizeShare(a?.share) ?? defaultShare() }))
      : [];
  } catch {
    return [];
  }
}

/** Atomic (tmp + rename), mode 600, directory 700. */
export function saveAccountsStore(file: string, list: ConnectedAccount[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function newAccountId(list: readonly ConnectedAccount[]): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!list.some((a) => a.id === id)) return id;
  }
}

export type IncomingAccount = Omit<
  ConnectedAccount,
  "id" | "share" | "policy" | "createdAt" | "updatedAt"
> &
  Partial<Pick<ConnectedAccount, "share" | "policy">>;

/**
 * Identity is provider + externalId. A reconnect supersedes token, expiry,
 * connectedVia and label IN PLACE and keeps id, owner, share and policy.
 */
export function upsertAccount(
  list: readonly ConnectedAccount[],
  incoming: IncomingAccount,
  now: number,
): { list: ConnectedAccount[]; account: ConnectedAccount } {
  const existing = list.find((a) => a.provider === incoming.provider && a.externalId === incoming.externalId);
  if (existing) {
    const account: ConnectedAccount = {
      ...existing,
      token: incoming.token,
      expiresAt: incoming.expiresAt,
      refreshToken: incoming.refreshToken,
      refreshExpiresAt: incoming.refreshExpiresAt,
      connectedVia: incoming.connectedVia,
      label: incoming.label,
      status: "ok",
      updatedAt: now,
    };
    return { list: list.map((a) => (a === existing ? account : a)), account };
  }
  const account: ConnectedAccount = {
    ...incoming,
    id: newAccountId(list),
    share: incoming.share ?? defaultShare(),
    policy: incoming.policy ?? "approve",
    createdAt: now,
    updatedAt: now,
  };
  return { list: [...list, account], account };
}

/** Exact id wins; else a unique prefix. Empty/blank → none; several → ambiguous. */
export function resolveAccountId(
  list: readonly ConnectedAccount[],
  prefix: string,
): ConnectedAccount | "none" | "ambiguous" {
  const p = (prefix ?? "").trim();
  if (!p) return "none";
  const exact = list.find((a) => a.id === p);
  if (exact) return exact;
  const hits = list.filter((a) => a.id.startsWith(p));
  return hits.length === 0 ? "none" : hits.length === 1 ? hits[0] : "ambiguous";
}

// ---- visibility ----------------------------------------------------------

/** Main + every public group: the same tier as the vault's commons. */
export function commonsGroupIds(groups: readonly Group[]): Set<string> {
  const ids = new Set<string>([MAIN_GROUP_ID]);
  for (const g of groups) if (g.nature === "public") ids.add(g.id);
  return ids;
}

export interface VisibilityOpts {
  /** The restricted peer box driving the request, if any: such an agent never sees an account (v1). */
  peerBox: string | null;
  /**
   * No wall between agents (`DEPLOYMENT_MODE !== "multi-tenant"`): every agent
   * runs as the server's own OS user and reads the same files, so there is no
   * private group to scope by — every `agentGroup` is null. Without this a
   * freshly connected account (`private` by default) is invisible to EVERY
   * agent, the one the person connected it for included. The share scope still
   * governs which PEOPLE see it; for agents it is the soft layer the spec names.
   */
  agentsUnwalled?: boolean;
  /**
   * The calling agent's profile (`AgentPrincipal.profile`), for the share's
   * profile filter. Applied even when `agentsUnwalled`: it is a choice the
   * owner made, not a wall the OS has to build.
   */
  agentProfile?: string | null;
}

/** May `viewer` use this account? A peer-driven agent never can (v1). */
export function accountVisible(
  a: ConnectedAccount,
  viewer: Viewer | null,
  groups: readonly Group[],
  opts: VisibilityOpts,
): boolean {
  if (!viewer || opts.peerBox) return false;
  // Normalised here too, not only at load: an account built in memory (a
  // test, a future caller) must not slip past the rules in the v1 shape.
  const share = normalizeShare(a.share, privateGroupFor(a.owner, groups)?.id ?? null, commonsGroupIds(groups)) ?? defaultShare();
  if (isAgentViewer(viewer) && !profileAllowed(share, opts.agentProfile)) return false;
  if (opts.agentsUnwalled && isAgentViewer(viewer)) return true;
  const commons = commonsGroupIds(groups);
  const ownerPrivate = privateGroupFor(a.owner, groups);

  if (!isAgentViewer(viewer)) {
    if (viewer.name === a.owner) return true;
    if (share.everyone) return true;
    return share.groups.some((id) => {
      if (commons.has(id)) return true;
      const g = groups.find((x) => x.id === id);
      return !!g && memberOf(g, viewer.name);
    });
  }

  const ag = viewer.agentGroup ?? null;
  const inOwnerPrivate = ag !== null && ownerPrivate !== null && ag === ownerPrivate.id;
  if (share.personal && inOwnerPrivate) return true;
  // Everyone: the commons, plus the owner's own Personal group — but never
  // another person's Personal group or a restricted one.
  if (share.everyone && (ag === null || commons.has(ag) || inOwnerPrivate)) return true;
  return share.groups.some((id) => {
    if (ag === null) return id === MAIN_GROUP_ID;
    const g = groups.find((x) => x.id === id);
    return g ? viewerInGroup(g, viewer) : id === ag;
  });
}

// ---- edit rules ----------------------------------------------------------

export type AccountChange = "share" | "policy" | "reconnect" | "disconnect";

export function accountEditVerdict(
  a: ConnectedAccount,
  viewer: Viewer | null,
  change: AccountChange,
  next?: { share?: ShareScope; policy?: "approve" | "autonomous" },
  groups: readonly Group[] = [],
  profileNames: readonly string[] | null = null,
): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!viewer) return no("Sign in to change a connected account.");
  if (isAgentViewer(viewer)) return no("An agent cannot change a connected account.");
  const isOwner = viewer.name === a.owner;
  if (!isOwner) {
    if (viewer.role === "admin" && change === "disconnect") return { ok: true };
    if (viewer.role === "admin") {
      return no("An admin can only disconnect someone else's account; its owner changes the rest.");
    }
    return no("Only the owner of this account can change it.");
  }
  if (change === "policy" && next?.policy === "autonomous" && !isOwner) {
    return no("Only the owner can let an account publish without approval.");
  }
  if (change === "share" && next?.share) {
    // Only what this edit ADDS is checked: the client re-sends the whole share,
    // and a group or profile deleted since must not block every later edit.
    const cur = normalizeShare(a.share) ?? defaultShare();
    for (const id of next.share.groups.filter((g) => !cur.groups.includes(g))) {
      const g = groups.find((x) => x.id === id);
      if (!g) return no(`Group "${id}" does not exist.`);
      if (g.nature === "private") return no(`"${g.name}" is someone's Personal group; it cannot be shared into.`);
      if (!commonsGroupIds(groups).has(id) && !memberOf(g, a.owner)) return no(`You are not a member of "${g.name}", so you cannot share into it.`);
    }
    if (profileNames) {
      for (const p of next.share.profiles.filter((x) => !cur.profiles.includes(x))) {
        if (!profileNames.includes(p)) return no(`There is no profile named "${p}".`);
      }
    }
  }
  return { ok: true };
}
