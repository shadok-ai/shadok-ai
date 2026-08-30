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
  // Redeeming DELETES the token, so a used link and a made-up one are
  // indistinguishable by then — and keeping consumed tokens around just to tell
  // them apart would be clutter with no payoff. Say what is true of both.
  if (!account)
    return { ok: false, error: "this link is no longer valid — it may already have been used. Ask for a new one" };
  if (!account.invite)
    return { ok: false, error: "this invitation was already redeemed — sign in instead" };
  if (account.invite.token !== token) return { ok: false, error: "invalid invitation" };
  if (now > account.invite.expiresAt)
    return { ok: false, error: "this invitation has expired — ask for a new link" };
  return { ok: true };
}

/**
 * Who a prompt is attributed to.
 *
 * The security property of the accounts feature, in one place: for a WEB client
 * the session decides and the frame's claim is discarded, because a browser can
 * put anything in `from`. The Telegram bridge is a trusted bridge that knows its
 * sender, so it keeps naming them; other origins (cli, cron) are the server's
 * own callers and keep whatever they supplied.
 */
export function promptAuthor(
  origin: string | undefined,
  sessionName: string | undefined,
  claimed: string | undefined,
): string | undefined {
  return origin === "web" ? sessionName : claimed;
}

/**
 * The per-session capability key handed to an agent as `SHADOK_SESSION_KEY`.
 *
 * DERIVED, never stored. It used to be a `randomUUID` kept in an in-memory Map,
 * which had a cliff nobody had noticed: the Map dies with the server, while a
 * tmux agent does not. So every auto-update left every surviving agent holding
 * a key the new process had never issued — `/reload` and `/profiles/prompt`
 * answered 403 from then on, and the agent could not repair itself either.
 *
 * An HMAC of the session id needs no state to survive a restart, and carrying
 * the id inside the key keeps the wire format one opaque string, so nothing
 * that presents a key had to learn a second field.
 *
 * It authenticates a LIVE session and nothing else: the id half is public
 * (`/live` lists every id), and only the MAC proves the holder was handed this
 * by the server at spawn. Same-user shell access still trumps it — soft
 * isolation, not a sandbox (invariant 26).
 */
export function signSessionKey(sessionId: string, secret: Buffer): string {
  const id = Buffer.from(sessionId, "utf8").toString("base64url");
  return `${id}.${createHmac("sha256", secret).update(`session:${id}`).digest("hex")}`;
}

/** Pure: the session id a key attests to, or null if it does not verify. */
export function readSessionKey(key: string, secret: Buffer): string | null {
  const parts = String(key ?? "").split(".");
  if (parts.length !== 2) return null;
  const [id, mac] = parts;
  if (!id || !mac) return null;
  const want = createHmac("sha256", secret).update(`session:${id}`).digest("hex");
  // Length first: timingSafeEqual THROWS on a mismatch rather than returning
  // false, so a short key would be a 500 instead of a refusal.
  if (mac.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    return Buffer.from(id, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}
