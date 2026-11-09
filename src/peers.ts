import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceKey } from "./paths.js";

/**
 * PEERS — other instances (or harnesses) allowed to reach THIS one's agents.
 *
 * A peer is the cross-instance twin of a web account (`accounts.ts`), and it
 * enrols the same way: named, revocable, per launch dir, and reached through a
 * **single-use ticket** that is CONSUMED on first use, exactly as a user's
 * invitation link is. What the invitee keeps afterwards is a durable token it
 * obtained itself — so the long-lived credential never travels through an
 * invitation, a chat, or an invitee's transcript.
 *
 * Two properties are load-bearing, and the first one was missing at first.
 *
 * The token is salted PER PEER. It used to be `hmac(secret, "peer:"+name)`,
 * which is deterministic: deleting a row revoked the token, but re-adding a peer
 * under the SAME name minted the identical token again — handing a leaked
 * credential straight back. Revocation was not rotation. The row now carries a
 * random `salt` mixed into the MAC, so re-inviting the same name yields a
 * different token, and the only way to rotate used to be renaming the peer or
 * rotating the instance secret (which is shared with every user session).
 *
 * It stays **non-expiring** once enrolled — a cross-instance link is persistent
 * and must not hit the 7-day cookie cliff — and **revocable by the registry**:
 * verifying requires the name to still be listed here, so deleting the row
 * kills every token for it. See docs/superpowers/specs/2026-09-26-cross-instance-
 * agent-collaboration-design.md.
 *
 * A peer that connects is a DISTINCT principal, scoped by the caller to the
 * agents it created (`Channel.createdByPeer`) — never B's whole fleet.
 */

/** A pending enrolment: the single-use ticket, and when it stops being usable. */
export interface PeerInvite {
  ticket: string;
  expiresAt: number;
}

export interface Peer {
  name: string;
  createdAt: number;
  note?: string;
  /**
   * Random, per peer, mixed into the token's MAC. Without it the token is a
   * pure function of the name, so revoke-then-re-invite returns the SAME
   * credential — see the note above. Absent on a row written before this
   * existed; `withSalts` backfills one, which invalidates that row's old token
   * (deliberately: a deterministic token is the thing being removed).
   */
  salt?: string;
  /** Present until the ticket is redeemed. While it is here the peer has NOT
   *  enrolled, and its durable token does not authenticate anything. */
  invite?: PeerInvite;
  /** When the ticket was redeemed and the durable token handed over. */
  enrolledAt?: number;
  /**
   * How much of this cockpit the peer may touch:
   *  - `restricted` (default) — only the agents IT created (`ownedByPeer`), and
   *    only `GET /diff` over HTTP. The scope a peer gets when nobody says
   *    otherwise.
   *  - `member` — everything a web MEMBER can: see and drive EVERY agent, read
   *    `/usage` / `/live`, spawn, the lot. Not admin (no account or peer
   *    management). "Invite an agent like a user."
   * Absent on a row from before scopes existed → `restricted`, so an upgrade
   * can never widen a credential that is already out there: a peer that was
   * boxed to its own agents stays boxed until someone RE-INVITES it as a
   * member. Widening is a decision, and a decision is written down.
   */
  scope?: "member" | "restricted";
}

/** The scope of a peer row, defaulting to `restricted`. The one place the
 *  default lives, so a stored row and a bare token agree — and it is the SAFE
 *  one: `member` only ever comes from something that spelled it out. */
export function peerScope(peer: { scope?: "member" | "restricted" } | undefined): "member" | "restricted" {
  return peer?.scope === "member" ? "member" : "restricted";
}

/** How long a ticket stays redeemable. Long enough to reach an agent that is
 *  mid-task, short enough that a forgotten invitation is not a standing door. */
export const PEER_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/** INBOUND registry, per launch dir, 600 — peers allowed to reach THIS instance. */
export function peerFileFor(cwd: string = process.cwd()): string {
  return path.join(os.homedir(), ".shadok-ai", "peers", instanceKey(cwd) + ".json");
}

/**
 * OUTBOUND registry, per launch dir AND per tier, 600 — peers THIS instance can
 * reach (`{ alias: { url, token } }`, managed by `pilotctl peer add`). The server
 * hands its path to every agent as SHADOK_PEERS_FILE (twin of the ledger file),
 * since an agent's cwd is a worktree, not the launch dir. Written and read by the
 * CLIENT (pilotctl); the server only computes the path.
 *
 * `stateHome` is invariant 54's correction, and this file was missed by it: the
 * path was anchored on `os.homedir()`, i.e. the SERVER's home, so every dropped
 * agent was handed a path under `/root` (mode 700) that it cannot read — making
 * `pilotctl --peer <alias>` dead for every agent in multi-tenant, silently,
 * because an unreadable registry parses as "no peers configured". Callers pass
 * the agent's own state home (`agentStateHome`); the default keeps mono-tenant
 * byte-for-byte unchanged.
 *
 * One consequence, and it is the right one: the registry becomes PER TIER. A
 * peer credential an agent obtained belongs to its own tier, not to the machine
 * — the same rule the secret vault already applies. A private group starts with
 * an empty registry and enrols its own peers; only the COMMONS inherits the
 * pre-tier file, which is what that single shared registry already meant back
 * when every agent ran as root (`tierPeersOutSeed`).
 */
export function peersOutFileFor(cwd: string = process.cwd(), stateHome: string = os.homedir()): string {
  return path.join(stateHome, ".shadok-ai", "peers-out", instanceKey(cwd) + ".json");
}

/**
 * Should the pre-tier outbound registry (the one in the SERVER's home) be seeded
 * into this tier's own? Only for the COMMONS, and only when the tier has none of
 * its own yet.
 *
 * Carrying it to every tier would be a widening: it would hand a private group a
 * bearer token for another instance that nobody granted it. Carrying it nowhere
 * would be a silent regression at the moment the path moves — a working `--peer`
 * alias would just stop resolving. The commons is the honest middle: before the
 * tiers existed every agent ran as root and read exactly this file, so the
 * commons inheriting it changes nothing about who holds what.
 *
 * Never an overwrite: a tier that already has a registry has been managing its
 * own, and the server's copy may be older.
 */
export function tierPeersOutSeed(input: {
  tier: "commons" | "group";
  serverHasFile: boolean;
  tierHasFile: boolean;
}): boolean {
  return input.tier === "commons" && input.serverHasFile && !input.tierHasFile;
}

export function loadPeers(file: string): Peer[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j) ? j.filter((p) => p && typeof p.name === "string") : [];
  } catch {
    return [];
  }
}

export function savePeers(file: string, peers: Peer[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(peers, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A peer name is a slug: lowercased, safe chars, non-empty. null if nothing
 *  usable survives — an empty/invalid name must never become a live credential. */
export function normPeerName(name: unknown): string | null {
  const s = String(name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || null;
}

/**
 * Pure: add (or supersede) a peer by name, with a FRESH salt and a fresh
 * single-use ticket.
 *
 * Superseding re-rolls the salt on purpose: re-inviting a name is exactly when
 * the old credential must stop working. `salt`/`ticket` are injected so the
 * result is testable; `newPeer` below supplies real randomness.
 */
export function addPeer(
  peers: Peer[],
  name: string,
  now: number,
  note: string | undefined,
  salt: string,
  ticket: string,
  ttlMs: number = PEER_INVITE_TTL_MS,
  scope: "member" | "restricted" = "restricted",
): Peer[] {
  const row: Peer = {
    name,
    createdAt: now,
    ...(note ? { note } : {}),
    salt,
    invite: { ticket, expiresAt: now + ttlMs },
    scope,
  };
  return [...peers.filter((p) => p.name !== name), row];
}

/** Impure twin of `addPeer`: draws the salt and the ticket. */
export function newPeer(
  peers: Peer[],
  name: string,
  now: number,
  note?: string,
  scope: "member" | "restricted" = "restricted",
): { peers: Peer[]; ticket: string } {
  const ticket = randomBytes(32).toString("base64url");
  return {
    peers: addPeer(peers, name, now, note, randomBytes(16).toString("hex"), ticket, PEER_INVITE_TTL_MS, scope),
    ticket,
  };
}

/**
 * Backfill a salt on any row written before salts existed.
 *
 * Doing this INVALIDATES that row's existing token, and that is the point: the
 * saltless token is the deterministic one being removed. A peer whose token
 * stops working is re-invited; a peer whose leaked token kept working would not
 * know to.
 */
export function withSalts(peers: Peer[], mint: () => string = () => randomBytes(16).toString("hex")): Peer[] {
  return peers.map((p) => (p.salt ? p : { ...p, salt: mint() }));
}

export type RedeemVerdict =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Pure: may this ticket be redeemed right now?
 *
 * Refuses an unknown, an expired and an ALREADY-REDEEMED ticket with the same
 * wording on purpose. Redemption deletes the ticket, so a used one and an
 * invented one are indistinguishable from here — and saying which would tell a
 * guesser that a ticket once existed. Same reasoning as the user invitation's
 * "this link is no longer valid".
 */
export function redeemVerdict(peers: readonly Peer[], ticket: unknown, now: number): RedeemVerdict {
  const t = typeof ticket === "string" ? ticket.trim() : "";
  const gone = { ok: false as const, error: "this invitation is no longer valid — it may already have been used" };
  if (!t) return { ok: false, error: "no invitation ticket" };
  const row = peers.find((p) => p.invite && p.invite.ticket === t);
  if (!row || !row.invite) return gone;
  if (row.invite.expiresAt <= now) return gone;
  return { ok: true, name: row.name };
}

/** Pure: consume the ticket — the row stays (that is the peer), the invitation
 *  goes. This is what makes the ticket single-use. */
export function redeemPeer(peers: readonly Peer[], name: string, now: number): Peer[] {
  return peers.map((p) => {
    if (p.name !== name) return p;
    const { invite: _used, ...rest } = p;
    return { ...rest, enrolledAt: now };
  });
}

/** Pure: drop a peer by name (revocation). */
export function removePeer(peers: Peer[], name: string): Peer[] {
  return peers.filter((p) => p.name !== name);
}

/**
 * The peer token: `<b64url(name)>.<hmac("peer:"+b64+":"+salt)>`, twin of
 * `signSessionKey` but SALTED per peer — see the note at the top of this file.
 */
export function signPeerToken(name: string, secret: Buffer, salt: string): string {
  const n = Buffer.from(name, "utf8").toString("base64url");
  return `${n}.${createHmac("sha256", secret).update(`peer:${n}:${salt}`).digest("hex")}`;
}

/** Pure: the name a token CLAIMS, from its first half. Proves nothing on its
 *  own — the MAC is checked in `peerFromToken`, which needs the row's salt. */
export function peerTokenName(token: unknown): string | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2) return null;
  const [n, mac] = parts;
  if (!n || !mac) return null;
  try {
    return Buffer.from(n, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

/**
 * The peer a token authenticates, or null.
 *
 * Three conditions, and each one is a different refusal:
 *  - the name is still in the registry — deleting the row is the revocation;
 *  - that row has ENROLLED (no pending invite left). A durable token for a peer
 *    that never redeemed its ticket authenticates nothing, which is what keeps
 *    the ticket the only way in;
 *  - the MAC verifies against THAT ROW's salt, so a token minted before a
 *    re-invitation is dead.
 */
export function peerFromToken(token: string, secret: Buffer, peers: readonly Peer[]): string | null {
  const claimed = peerTokenName(token);
  if (!claimed) return null;
  const row = peers.find((p) => p.name === claimed);
  if (!row || !row.salt || row.invite) return null;
  const mac = String(token).split(".")[1] ?? "";
  const want = createHmac("sha256", secret).update(`peer:${Buffer.from(claimed, "utf8").toString("base64url")}:${row.salt}`).digest("hex");
  // Length first: timingSafeEqual THROWS on a length mismatch (invariant in
  // readSessionKey), which would be a 500 instead of a clean refusal.
  if (mac.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  return row.name;
}

/**
 * The ownership rule — a peer may only touch an agent IT created. The single
 * named check behind every peer scope (resume, stop, /diff): a channel with a
 * different `createdByPeer`, or none (a local agent), is NOT this peer's.
 */
export function ownedByPeer(channel: { createdByPeer?: string } | undefined, peer: string): boolean {
  return !!channel && channel.createdByPeer === peer;
}

/**
 * The copy-paste invitation for an AGENT — the peer equivalent of a user's
 * single-use link, and single-use in the same way. The invitee is an agent, not a
 * human, so instead of a page where it picks a password it gets a PROMPT to paste
 * into its own session: the cockpit URL, a TICKET, the brief, and exactly how to
 * join and report back.
 *
 * It carries the ticket and never the durable token, which is the point: an
 * invitation is copied, pasted and kept in a transcript, so what it holds must
 * be worthless once used.
 * `brief` is the human's task (empty allowed). Pure so the wording is tested.
 */
export function agentInvitePrompt(opts: {
  url: string;
  ticket: string;
  brief?: string;
  scope?: "member" | "restricted";
}): string {
  const url = opts.url.replace(/\/+$/, "");
  const brief = (opts.brief ?? "").trim();
  const member = peerScope({ scope: opts.scope }) === "member";
  const accessLine = member
    ? "You act as a full member of that cockpit: you can see, drive and measure EVERY agent on it, spawn more, and read its usage — everything a person you invite could. (You cannot manage its accounts or its peers — that stays with an admin.)"
    : "You can only see and drive the agents you spawn there — nothing else on that cockpit.";
  const listHint = member
    ? "  pilotctl list   --peer host                     # every agent on the cockpit"
    : "  # (you only see the agents you spawn; track their ids)";
  return [
    "You've been invited to collaborate with a shadok-ai cockpit as a peer agent.",
    "",
    `Cockpit: ${url}`,
    `Your invitation ticket: ${opts.ticket}`,
    "(Single use: `peer add` exchanges it for your own durable key, and the ticket",
    " dies at that moment. Keep the key you get back secret — it authenticates you",
    " as this peer, and it can be revoked at any time.)",
    "",
    "To join, use the shadok-ai-agents skill (pilotctl):",
    `  pilotctl peer add host ${url} ${opts.ticket}`,
    "  pilotctl spawn  --peer host --cwd /workspace     # start an agent on the cockpit",
    '  pilotctl prompt <id> "<your work>" --peer host   # drive it',
    "  pilotctl diff   <id> --peer host                 # read what it changed",
    listHint,
    "",
    accessLine,
    "",
    brief ? "Your brief:" : "No brief was included — ask your inviter what they need before you start.",
    ...(brief ? ["", brief] : []),
    "",
    "When the task is done, or if you get blocked, report back to whoever invited you.",
  ].join("\n");
}
