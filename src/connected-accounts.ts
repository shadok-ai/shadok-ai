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

export type ShareScope = { scope: "private" } | { scope: "groups"; groups: string[] } | { scope: "instance" };

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
    return Array.isArray(parsed) ? (parsed as ConnectedAccount[]) : [];
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
    share: incoming.share ?? { scope: "private" },
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

/** May `viewer` use this account? A peer-driven agent never can (v1). */
export function accountVisible(
  a: ConnectedAccount,
  viewer: Viewer | null,
  groups: readonly Group[],
  opts: { peerBox: string | null },
): boolean {
  if (!viewer || opts.peerBox) return false;
  const commons = commonsGroupIds(groups);
  const ownerPrivate = privateGroupFor(a.owner, groups);

  if (!isAgentViewer(viewer)) {
    if (viewer.name === a.owner) return true;
    if (a.share.scope === "instance") return true;
    if (a.share.scope === "groups") {
      return a.share.groups.some((id) => {
        if (commons.has(id)) return true;
        const g = groups.find((x) => x.id === id);
        return !!g && memberOf(g, viewer.name);
      });
    }
    return false;
  }

  const ag = viewer.agentGroup ?? null;
  const inOwnerPrivate = ag !== null && ownerPrivate !== null && ag === ownerPrivate.id;
  if (a.share.scope === "private") return inOwnerPrivate;
  if (a.share.scope === "groups") {
    if (ag === null) return a.share.groups.includes(MAIN_GROUP_ID);
    return a.share.groups.some((id) => {
      const g = groups.find((x) => x.id === id);
      return g ? viewerInGroup(g, viewer) : id === ag;
    });
  }
  return ag === null || commons.has(ag) || inOwnerPrivate;
}

// ---- edit rules ----------------------------------------------------------

export type AccountChange = "share" | "policy" | "reconnect" | "disconnect";

export function accountEditVerdict(
  a: ConnectedAccount,
  viewer: Viewer | null,
  change: AccountChange,
  next?: { share?: ShareScope; policy?: "approve" | "autonomous" },
  groups: readonly Group[] = [],
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
  if (change === "share" && next?.share?.scope === "groups") {
    const ids = next.share.groups;
    if (!Array.isArray(ids) || ids.length === 0) return no("Pick at least one group to share with.");
    for (const id of ids) {
      const g = groups.find((x) => x.id === id);
      if (!g) return no(`Group "${id}" does not exist.`);
      if (!commonsGroupIds(groups).has(id) && !memberOf(g, a.owner)) return no(`You are not a member of "${g.name}", so you cannot share into it.`);
    }
  }
  return { ok: true };
}
