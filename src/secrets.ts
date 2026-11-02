import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN_GROUP_ID } from "./groups.js";

/**
 * Central secret vault: named secrets stored OUTSIDE any repo at
 * ~/.shadok-ai/secrets.json (600) and injected as environment variables into an
 * agent's `claude` process at spawn — never written into the working directory.
 *
 * Per-GROUP: `{ groupId: { NAME: SecretEntry } }`. One server-owned file with
 * policy scoping (not one file per group). Names are unique PER GROUP, never
 * global. A group may SHARE a secret by reference (`sharedWith`), and `Main`
 * is the instance-wide fallback. A profile lists the NAMES it wants injected.
 */
export interface SecretEntry {
  value: string;
  ownerGroup: string;
  sharedWith: string[];
  profiles: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
export interface GroupVault {
  [name: string]: SecretEntry;
}
export type Vault = { [groupId: string]: GroupVault };

const FILE = path.join(os.homedir(), ".shadok-ai", "secrets.json");

// ── Pure core (unit-tested) ──────────────────────────────────────────────

/** Pure: lift today's flat NAME→value map into the Main group's slice. */
export function migrateFlatVault(
  flat: Record<string, string>,
  mainId: string,
  createdBy: string,
  now: number,
): Vault {
  const slice: GroupVault = {};
  for (const [name, value] of Object.entries(flat))
    slice[name] = { value, ownerGroup: mainId, sharedWith: [], profiles: [], createdBy, createdAt: now, updatedAt: now };
  return { [mainId]: slice };
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Pure: resolve the env for `names` as seen from `groupId`. Per name, first
 * match wins: the group's own secret → a secret another group shared with it →
 * Main's → absent. Nothing is pinned to a group globally: the same name can
 * live in several groups and each resolves on its own.
 */
export function resolveSecretValues(vault: Vault, groupId: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const own = vault[groupId]?.[name];
    if (own) { out[name] = own.value; continue; }
    let shared: SecretEntry | undefined;
    for (const [gid, gv] of Object.entries(vault)) {
      const e = gv[name];
      if (gid !== groupId && e && e.sharedWith.includes(groupId)) { shared = e; break; }
    }
    if (shared) { out[name] = shared.value; continue; }
    const main = vault[MAIN_GROUP_ID]?.[name];
    if (main) out[name] = main.value;
  }
  return out;
}

/**
 * Normalize a parsed secrets.json into the per-group vault. Accepts the current
 * nested shape (missing entry fields get safe defaults), today's flat
 * `{NAME: value}` map, and the oldest per-repo shape (`{repo: {NAME: value}}`);
 * the last two are migrated into Main (per-repo: last value wins on a collision).
 */
export function normalizeVault(raw: unknown, now: number = Date.now()): Vault {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Vault = {};
  const legacy: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") { legacy[k] = v; continue; }
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const slice: GroupVault = {};
    for (const [name, e] of Object.entries(v as Record<string, unknown>)) {
      if (typeof e === "string") { legacy[name] = e; continue; } // per-repo shape
      if (!e || typeof e !== "object" || typeof (e as any).value !== "string") continue;
      const o = e as Record<string, unknown>;
      slice[name] = {
        value: o.value as string,
        ownerGroup: typeof o.ownerGroup === "string" && o.ownerGroup ? o.ownerGroup : k,
        sharedWith: strList(o.sharedWith),
        profiles: strList(o.profiles),
        createdBy: typeof o.createdBy === "string" ? o.createdBy : "",
        createdAt: typeof o.createdAt === "number" ? o.createdAt : now,
        updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : now,
      };
    }
    if (Object.keys(slice).length) out[k] = slice;
  }
  if (Object.keys(legacy).length) {
    const m = migrateFlatVault(legacy, MAIN_GROUP_ID, "", now)[MAIN_GROUP_ID];
    out[MAIN_GROUP_ID] = { ...m, ...(out[MAIN_GROUP_ID] ?? {}) };
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

/** Secret names (never the values) in one group's own slice, sorted. */
export function secretNames(groupId: string = MAIN_GROUP_ID): string[] {
  return Object.keys(loadVault()[groupId] ?? {}).sort();
}

/** Create or update a secret in `groupId` (default Main); an update keeps its sharing and provenance. */
export function setSecret(name: string, value: string, groupId: string = MAIN_GROUP_ID, createdBy = ""): void {
  const v = loadVault();
  const now = Date.now();
  const prev = v[groupId]?.[name];
  (v[groupId] ??= {})[name] = prev
    ? { ...prev, value, updatedAt: now }
    : { value, ownerGroup: groupId, sharedWith: [], profiles: [], createdBy, createdAt: now, updatedAt: now };
  saveVault(v);
}

export function deleteSecret(name: string, groupId: string = MAIN_GROUP_ID): void {
  const v = loadVault();
  if (v[groupId] && name in v[groupId]) {
    delete v[groupId][name];
    if (!Object.keys(v[groupId]).length) delete v[groupId];
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

/**
 * The `{ NAME: value }` env for a set of referenced names (unknown ones skipped),
 * resolved from `groupId` (own → shared-in → Main). `groupId` defaults to Main,
 * which is every agent in a mono-tenant instance.
 */
export function secretsFor(names: string[] | undefined, groupId: string = MAIN_GROUP_ID): Record<string, string> {
  if (!names?.length) return {};
  return resolveSecretValues(loadVault(), groupId, names);
}
