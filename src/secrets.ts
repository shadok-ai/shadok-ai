import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Central secret vault: named secrets stored ONCE, referenced by profiles.
 * Stored OUTSIDE any repo at ~/.shadok-ai/secrets.json (600) and injected as
 * environment variables into an agent's `claude` process at spawn — never
 * written into the working directory. A flat `{ NAME: value }` map; a profile
 * lists the NAMES it wants injected (see profiles.ts).
 */
export type Vault = Record<string, string>;

const FILE = path.join(os.homedir(), ".shadok-ai", "secrets.json");

// ── Pure core (unit-tested) ──────────────────────────────────────────────

/**
 * Normalize a parsed secrets.json into a flat vault. Migrates the old per-repo
 * shape (`{ "<repo>": { NAME: value } }`) by flattening every repo's entries
 * into the single vault (last value wins on a name collision).
 */
export function normalizeVault(raw: unknown): Vault {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const nested = Object.values(obj).some((v) => v && typeof v === "object");
  const out: Vault = {};
  if (nested) {
    for (const perRepo of Object.values(obj)) {
      if (perRepo && typeof perRepo === "object")
        for (const [k, v] of Object.entries(perRepo as Record<string, unknown>))
          if (typeof v === "string") out[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

export type SecretWrite = "created" | "updated" | "refused";

/**
 * Pure: what a write to `name` should do. Overwriting is the only destructive
 * move the vault allows — it replaces a live credential and leaves no trace,
 * and the vault keeps no history to undo it. So it takes an explicit intent,
 * which the human surfaces carry and a machine does not.
 */
export function secretWriteVerdict(exists: boolean, overwrite: boolean): SecretWrite {
  if (!exists) return "created";
  return overwrite ? "updated" : "refused";
}

// ── Vault API ────────────────────────────────────────────────────────────

let migrated = false;
export function loadVault(): Vault {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
  const v = normalizeVault(raw);
  // Persist the flattened form once, so the old per-repo shape is retired.
  if (!migrated && JSON.stringify(raw) !== JSON.stringify(v)) {
    saveVault(v);
    migrated = true;
  }
  return v;
}

export function saveVault(v: Vault): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600); // enforce 600 even if the file pre-existed
}

/** All secret names (never the values), sorted. */
export function secretNames(): string[] {
  return Object.keys(loadVault()).sort();
}

export function setSecret(name: string, value: string): void {
  const v = loadVault();
  v[name] = value;
  saveVault(v);
}

export function deleteSecret(name: string): void {
  const v = loadVault();
  if (name in v) {
    delete v[name];
    saveVault(v);
  }
}

// ── Who created a secret ─────────────────────────────────────────────────

/**
 * Provenance, kept in a SIDECAR file rather than in the vault: the vault is a
 * flat `{ NAME: value }` map read by several paths (and migrated from an older
 * shape), and the one thing worse than losing provenance is corrupting the
 * credentials while adding it.
 *
 * It exists for exactly one decision — an agent may attach to its profile a
 * secret IT created, and nothing else (see `secretAttachVerdict`). So a missing
 * entry must read as "a human put this here", which is the safe answer: absence
 * denies, it never grants.
 */
export type SecretOrigin = { profile: string; at: number };
export type Origins = Record<string, SecretOrigin>;

const ORIGIN_FILE = path.join(os.homedir(), ".shadok-ai", "secret-origin.json");

export function normalizeOrigins(raw: unknown): Origins {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Origins = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const profile = typeof o.profile === "string" ? o.profile.trim() : "";
    // A blank creator is not a creator: it would match an agent whose own
    // profile is somehow blank, and hand it a secret it never held.
    if (!profile) continue;
    out[name] = { profile, at: typeof o.at === "number" ? o.at : 0 };
  }
  return out;
}

export function loadOrigins(): Origins {
  try {
    return normalizeOrigins(JSON.parse(fs.readFileSync(ORIGIN_FILE, "utf8")));
  } catch {
    return {};
  }
}

/** The profile that created this secret, or null — null means "a human did". */
export function originProfile(name: string): string | null {
  return loadOrigins()[name]?.profile ?? null;
}

/**
 * Record a creator. Called ONLY when a secret is created, never on an
 * overwrite: otherwise an agent could overwrite a human's secret with junk to
 * become its "creator", then attach the name. The value would be worthless,
 * but the laundering path should not exist at all.
 */
export function recordOrigin(name: string, profile: string): void {
  if (!profile.trim()) return;
  const all = loadOrigins();
  all[name] = { profile: profile.trim(), at: Date.now() };
  fs.mkdirSync(path.dirname(ORIGIN_FILE), { recursive: true });
  fs.writeFileSync(ORIGIN_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** The `{ NAME: value }` env for a set of referenced names (unknown ones skipped). */
export function secretsFor(names: string[] | undefined): Record<string, string> {
  if (!names?.length) return {};
  const v = loadVault();
  const out: Record<string, string> = {};
  for (const n of names) if (n in v) out[n] = v[n];
  return out;
}
