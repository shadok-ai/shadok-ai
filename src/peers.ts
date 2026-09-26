import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceKey } from "./paths.js";

/**
 * PEERS — other instances (or harnesses) allowed to reach THIS one's agents.
 *
 * A peer is the cross-instance twin of a web account (`accounts.ts`): named,
 * revocable, per launch dir. Its credential is a token shaped exactly like the
 * agent session key (invariant 33): an HMAC of the name, **non-expiring** (a
 * cross-instance link is persistent and must not hit the 7-day cookie cliff) and
 * **revocable by the registry** — the token embeds the name, and verifying
 * requires that name to still be listed here. Delete the row ⇒ every token for
 * it is dead, with no server state to keep. No secret is stored (it is derived),
 * same as the session key. See docs/superpowers/specs/2026-09-26-cross-instance-
 * agent-collaboration-design.md.
 *
 * A peer that connects is a DISTINCT principal, scoped by the caller to the
 * agents it created (`Channel.createdByPeer`) — never B's whole fleet.
 */

export interface Peer {
  name: string;
  createdAt: number;
  note?: string;
}

/** Per-launch-dir registry, 600, like accounts/channels. */
export function peerFileFor(cwd: string = process.cwd()): string {
  return path.join(os.homedir(), ".shadok-ai", "peers", instanceKey(cwd) + ".json");
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

/** Pure: add (or supersede) a peer by name. */
export function addPeer(peers: Peer[], name: string, now: number, note?: string): Peer[] {
  const row: Peer = { name, createdAt: now, ...(note ? { note } : {}) };
  return [...peers.filter((p) => p.name !== name), row];
}

/** Pure: drop a peer by name (revocation). */
export function removePeer(peers: Peer[], name: string): Peer[] {
  return peers.filter((p) => p.name !== name);
}

/** The peer token: `<b64url(name)>.<hmac("peer:"+b64)>`, twin of `signSessionKey`. */
export function signPeerToken(name: string, secret: Buffer): string {
  const n = Buffer.from(name, "utf8").toString("base64url");
  return `${n}.${createHmac("sha256", secret).update(`peer:${n}`).digest("hex")}`;
}

/** Pure: the name a token attests to by its MAC alone, or null. Does NOT check
 *  the registry — that is `peerFromToken`. */
export function readPeerToken(token: string, secret: Buffer): string | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2) return null;
  const [n, mac] = parts;
  if (!n || !mac) return null;
  const want = createHmac("sha256", secret).update(`peer:${n}`).digest("hex");
  // Length first: timingSafeEqual THROWS on a length mismatch (invariant in
  // readSessionKey), which would be a 500 instead of a clean refusal.
  if (mac.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    return Buffer.from(n, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

/** The peer a token authenticates: a valid MAC AND a name still in the registry.
 *  A token whose row was deleted is refused — that is the revocation. */
export function peerFromToken(token: string, secret: Buffer, peers: Peer[]): string | null {
  const name = readPeerToken(token, secret);
  if (!name) return null;
  return peers.some((p) => p.name === name) ? name : null;
}

/**
 * The ownership rule — a peer may only touch an agent IT created. The single
 * named check behind every peer scope (resume, stop, /diff): a channel with a
 * different `createdByPeer`, or none (a local agent), is NOT this peer's.
 */
export function ownedByPeer(channel: { createdByPeer?: string } | undefined, peer: string): boolean {
  return !!channel && channel.createdByPeer === peer;
}
