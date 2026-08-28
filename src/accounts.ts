import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { instanceKey } from "./paths.js";

/**
 * Web accounts, PER INSTANCE (per launch directory) — the same scope as
 * channels, crons and the instance lock.
 *
 * Per instance rather than global is the consistent choice: SHADOK_GUI_PASSWORD
 * is already per process, so accounts share the scope of the door they extend.
 * Profiles and the secret vault are the global exception, not the rule.
 */
export type Role = "admin" | "member";

export interface Account {
  name: string;
  role: Role;
  /** Absent until an invitation is redeemed. */
  passwordHash?: string;
  createdAt: number;
  /** Present only while the invitation is outstanding. */
  invite?: { token: string; expiresAt: number };
}

/** The account that lives in SHADOK_GUI_PASSWORD, never in the file. */
export const BOOTSTRAP_ADMIN = "admin";

function storeFile(): string {
  return path.join(os.homedir(), ".shadok-ai", "users", instanceKey() + ".json");
}

export function loadAccounts(): Account[] {
  try {
    const v = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return Array.isArray(v) ? v.filter((a) => a && typeof a.name === "string") : [];
  } catch {
    return [];
  }
}

export function saveAccounts(list: Account[]): void {
  const f = storeFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}

/** `scrypt$<salt hex>$<derived hex>` — salted, so two identical passwords do
 *  not produce the same hash and cannot be spotted as identical. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(plain: string, hash: string): boolean {
  const parts = String(hash ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const want = Buffer.from(parts[2], "hex");
    if (!salt.length || !want.length) return false;
    const got = scryptSync(plain, salt, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/**
 * Who may change which account. Pure, so the whole policy is one testable
 * place rather than a condition repeated at three endpoints.
 */
export function userWriteVerdict(o: {
  actorRole: Role | null;
  action: "create" | "delete" | "role";
  target: string;
  exists: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (o.actorRole !== "admin") return { ok: false, error: "only an admin can manage accounts" };
  const name = o.target.trim();
  if (!name) return { ok: false, error: "name required" };
  if (o.action === "create") {
    if (name === BOOTSTRAP_ADMIN)
      return { ok: false, error: `"${BOOTSTRAP_ADMIN}" is reserved for the instance password` };
    return o.exists ? { ok: false, error: `${name} already exists` } : { ok: true };
  }
  return o.exists ? { ok: true } : { ok: false, error: `no such account: ${name}` };
}

/**
 * The key that signs sessions — per instance, drawn once, persisted.
 *
 * NOT derived from SHADOK_GUI_PASSWORD, and never exported into an agent's
 * environment. The password reaches every agent's env today (measured on three
 * production agents, 2026-08-23); signing with it would let any agent mint a
 * cookie for any user. Untidy becomes impersonation the moment accounts exist.
 */
export function sessionSecret(): Buffer {
  const f = path.join(os.homedir(), ".shadok-ai", "users", instanceKey() + ".key");
  try {
    const hex = fs.readFileSync(f, "utf8").trim();
    if (hex.length >= 32) return Buffer.from(hex, "hex");
  } catch {
    /* first run, or unreadable: draw a new one below */
  }
  const secret = randomBytes(32);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, secret.toString("hex"), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return secret;
}

/** `<user base64url>.<issuedAt>.<hmac>` — the name is encoded so a dot in it
 *  cannot shift the fields. The ROLE is deliberately absent: it is re-read from
 *  the account file at use time, so a demotion takes effect immediately instead
 *  of riding in a stale cookie. */
export function signSession(user: string, issuedAt: number, secret: Buffer): string {
  const u = Buffer.from(user, "utf8").toString("base64url");
  const body = `${u}.${issuedAt}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function readSession(
  token: string,
  secret: Buffer,
  now: number,
  maxAgeMs: number,
): string | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [u, at, mac] = parts;
  const issuedAt = Number(at);
  if (!at || !Number.isFinite(issuedAt)) return null;
  const want = createHmac("sha256", secret).update(`${u}.${at}`).digest("hex");
  if (mac.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  if (now - issuedAt > maxAgeMs) return null;
  try {
    return Buffer.from(u, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

/** A week: long enough to hand the link over by another channel, short enough
 *  that a forgotten one stops working. */
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export function newInvite(now: number): { token: string; expiresAt: number } {
  return { token: randomBytes(24).toString("base64url"), expiresAt: now + INVITE_TTL_MS };
}

/**
 * Whether this link may still be redeemed.
 *
 * Each refusal names its own reason: "expired" tells the holder to ask for a
 * new link, "already redeemed" tells them the account is live, and "invalid" is
 * a real mismatch. One generic error would send all three to the wrong place.
 */
export function inviteVerdict(
  account: Account | undefined,
  token: string,
  now: number,
): { ok: true } | { ok: false; error: string } {
  if (!account) return { ok: false, error: "unknown invitation" };
  if (!account.invite)
    return { ok: false, error: "this invitation was already redeemed — sign in instead" };
  if (account.invite.token !== token) return { ok: false, error: "invalid invitation" };
  if (now > account.invite.expiresAt)
    return { ok: false, error: "this invitation has expired — ask for a new link" };
  return { ok: true };
}
