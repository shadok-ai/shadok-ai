import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
