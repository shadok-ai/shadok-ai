import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN_GROUP_ID, canWriteSecretGroup, spawnGroupFor, type Group, type Viewer } from "./groups.js";

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
/**
 * Own-property lookup. A bare `obj[key]` answers an inherited prototype member
 * for a name like `constructor` or `toString`: a function, truthy, with no
 * `.sharedWith`, so the scan below crashed and the agent spawned with NO
 * secrets. Anything not an own entry is ABSENT.
 */
const ownOf = <T>(obj: Record<string, T> | undefined, key: string): T | undefined =>
  obj && Object.hasOwn(obj, key) ? obj[key] : undefined;

/**
 * The ONE entry a `name` resolves to from `groupId` — own → shared-in → Main,
 * first match wins — or undefined. The single selection rule behind both the
 * value resolution and the profile-binding lookup, so they can never disagree.
 */
export function resolveSecretEntry(
  vault: Vault,
  groupId: string,
  name: string,
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): SecretEntry | undefined {
  const mine = ownOf(ownOf(vault, groupId), name);
  if (mine) return mine;
  // When two groups share the same name with the caller, the winner is
  // insertion-order-deterministic: the first such group in `Object.entries` order.
  for (const [gid, gv] of Object.entries(vault)) {
    const e = ownOf(gv, name);
    if (gid !== groupId && e && e.sharedWith.includes(groupId)) return e;
  }
  // The COMMONS tier: Main, plus every PUBLIC non-Main group — a public group is
  // visible-to-all (operator decision 2026-11-03: "public = commun"), so its
  // secrets resolve for EVERY agent, exactly like Main's. `commonsIds` is passed
  // by the server (it owns the group natures); it defaults to Main alone, so a
  // caller that does not know the natures keeps today's own→shared→Main behaviour.
  for (const cid of commonsIds) {
    if (cid === groupId) continue; // own already checked above
    const e = ownOf(ownOf(vault, cid), name);
    if (e) return e;
  }
  return undefined;
}

export function resolveSecretValues(
  vault: Vault,
  groupId: string,
  names: readonly string[],
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const e = resolveSecretEntry(vault, groupId, name, commonsIds);
    if (e) out[name] = e.value;
  }
  return out;
}

/**
 * The secret NAMES to inject into an agent running `profileName` in `groupId`.
 *
 * The binding lives on the SECRET (`entry.profiles`, set by the grouped panel's
 * "attach to profiles"), NOT on the profile — so injecting `profile.secrets`
 * alone (the legacy field, empty in grouped mode) delivered NOTHING to the agent.
 * This is the authoritative set: every vault name whose group-resolved entry
 * binds this profile, UNION the legacy `profileSecrets` (kept so a mono-tenant /
 * flat instance, where the binding still lives on the profile, is unchanged).
 */
export function secretNamesForProfile(
  vault: Vault,
  groupId: string,
  profileName: string,
  profileSecrets: readonly string[] = [],
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): string[] {
  const out = new Set<string>(profileSecrets.filter((n) => typeof n === "string" && n));
  if (profileName) {
    const names = new Set<string>();
    for (const slice of Object.values(vault)) {
      if (!slice || typeof slice !== "object") continue;
      for (const n of Object.keys(slice)) if (Object.hasOwn(slice, n)) names.add(n);
    }
    for (const name of names) {
      const e = resolveSecretEntry(vault, groupId, name, commonsIds);
      if (e && e.profiles.includes(profileName)) out.add(name);
    }
  }
  return [...out];
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

export type SecretSource = "own" | "shared" | "main";
export interface VisibleSecret {
  name: string;
  source: SecretSource;
  /** The group that OWNS the secret — omitted for a Main secret (`source:"main"`). */
  ownerGroup?: string;
  /** Audit fields — metadata only, never the value. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Only on a secret the caller OWNS: the groups it is lent to / the profiles it feeds. */
  sharedWith?: string[];
  profiles?: string[];
}

/**
 * Server-owned credentials. `MT_CLAUDE_OAUTH_TOKEN` is the instance's long-lived
 * subscription token: the server injects it into isolated-group agents as
 * `CLAUDE_CODE_OAUTH_TOKEN`, so it is never a user-managed secret. "Reserved"
 * hides it from the human-facing listings ONLY — `resolveSecretValues` /
 * `secretsFor` still resolve it, or the injection would stop working.
 */
/** The one spelling of the reserved long-lived token's vault name. */
export const MT_CLAUDE_OAUTH_TOKEN_NAME = "MT_CLAUDE_OAUTH_TOKEN";

export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([MT_CLAUDE_OAUTH_TOKEN_NAME]);

/** Pure: drop the server-owned reserved names from a listing. */
export function filterReserved(names: string[]): string[] {
  return names.filter((n) => !RESERVED_SECRET_NAMES.has(n));
}

/** Approximate lifetime of a `claude setup-token` token (the token itself is opaque). */
export const LONG_LIVED_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Pure: is this instance running agents on the long-lived token, and when does
 * that token roughly lapse? The token carries no readable expiry, so the date is
 * `updatedAt + 1 year` — a re-mint overwrites the secret and bumps `updatedAt`,
 * which restarts the window correctly.
 */
export function longLivedTokenInfo(
  vault: Vault,
  mode: "multi-tenant" | "mono-tenant",
): { longLived: boolean; longLivedExpiresAt: number | null } {
  const entry = mode === "multi-tenant" ? vault[MAIN_GROUP_ID]?.[MT_CLAUDE_OAUTH_TOKEN_NAME] : undefined;
  if (!entry) return { longLived: false, longLivedExpiresAt: null };
  const u = entry.updatedAt;
  const ok = typeof u === "number" && Number.isFinite(u) && u > 0;
  return { longLived: true, longLivedExpiresAt: ok ? u + LONG_LIVED_TOKEN_TTL_MS : null };
}

/**
 * Pure: the secret NAMES a caller may see, tagged by why — NEVER the values.
 * `ownGroupIds` is the set of groups whose secrets the caller sees in that
 * group's OWN section (from `groups.secretOwnGroupIds`): the groups they belong
 * to PLUS every public non-Main group (public = visible to all). A name is
 * visible when it is:
 *   - `own`    — owned by one of those groups;
 *   - `shared` — owned elsewhere but shared WITH one of those groups;
 *   - `main`   — in the instance-wide commons, visible to everyone.
 * Precedence on a name present several ways mirrors `resolveSecretValues`:
 * own > shared > main. In mono-tenant the caller resolves to Main only, so this
 * returns exactly today's Main names, all tagged `main` — unchanged behaviour.
 */
export function visibleSecrets(vault: Vault, ownGroupIds: ReadonlySet<string>): VisibleSecret[] {
  const rank: Record<SecretSource, number> = { own: 0, shared: 1, main: 2 };
  const chosen = new Map<string, VisibleSecret>();
  const consider = (cand: VisibleSecret) => {
    const prev = chosen.get(cand.name);
    if (!prev || rank[cand.source] < rank[prev.source]) chosen.set(cand.name, cand);
  };
  for (const [gid, slice] of Object.entries(vault)) {
    if (!slice || typeof slice !== "object") continue;
    for (const name of Object.keys(slice)) {
      if (!Object.hasOwn(slice, name)) continue;
      if (RESERVED_SECRET_NAMES.has(name)) continue;
      const e = slice[name];
      const audit = { createdBy: e.createdBy, createdAt: e.createdAt, updatedAt: e.updatedAt };
      if (gid === MAIN_GROUP_ID) consider({ name, source: "main", ...audit });
      else if (ownGroupIds.has(gid))
        consider({ name, source: "own", ownerGroup: gid, ...audit, sharedWith: [...e.sharedWith], profiles: [...e.profiles] });
      else if (e.sharedWith.some((g) => ownGroupIds.has(g)))
        consider({ name, source: "shared", ownerGroup: gid, ...audit });
    }
  }
  return [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * The group a secret WRITE lands in. For an agent this is derived SERVER-SIDE
 * from identity and is NON-NEGOTIABLE; for a browser it may be a client REQUEST
 * that the authorization gate (`secretWriteDecision`) still has to clear.
 *   - an AGENT (`agentGroupId` present, even as null): its OWN channel's group,
 *     or Main when it has none. A `requestedGroup` that differs is IGNORED — an
 *     agent must never aim another tenant's vault by naming it in the body; it writes only its own group
 *     (Task 10's agent-own-group rule, private included).
 *   - a BROWSER (`agentGroupId` undefined): the group it REQUESTED (the panel's
 *     selected group — a request, authorized separately), or, when omitted,
 *     `spawnGroupFor` — the same identity-derived "your one group or the
 *     commons" rule used at spawn (today's back-compat behaviour).
 * The requested group is never TRUSTED here: this only chooses the target, and
 * `secretWriteDecision` applies `canWriteSecretGroup` to it.
 */
export function secretOwnerGroup(input: {
  agentGroupId?: string | null;
  requestedGroup?: string | null;
  viewer: Viewer | null;
  groups: readonly Group[];
}): string {
  if (input.agentGroupId !== undefined) return input.agentGroupId ?? MAIN_GROUP_ID;
  if (typeof input.requestedGroup === "string" && input.requestedGroup.trim())
    return input.requestedGroup.trim();
  return spawnGroupFor(input.viewer, input.groups)?.id ?? MAIN_GROUP_ID;
}

/**
 * Whole decision for a secret mutation (`PUT`/`DELETE`/share/bind): resolve the
 * OWNER group (an optional browser-`requestedGroup` is a request, not a trusted
 * value — an agent's is ignored outright), then apply the owner-group membership
 * gate (`canWriteSecretGroup`) so the request must pass the SAME wall as any
 * write. Transport-free so the routes stay thin mappers and the gate is
 * unit-tested. A client-claimed owner/createdBy never reaches here.
 */
export function secretWriteDecision(input: {
  agentGroupId?: string | null;
  requestedGroup?: string | null;
  viewer: Viewer | null;
  groups: readonly Group[];
}): { ok: true; ownerGroup: string } | { ok: false; error: string } {
  const ownerGroup = secretOwnerGroup(input);
  const g =
    input.groups.find((x) => x.id === ownerGroup) ??
    (ownerGroup === MAIN_GROUP_ID
      ? ({ id: MAIN_GROUP_ID, name: "main", nature: "public", members: [], createdAt: 0 } as Group)
      : null);
  // An AGENT (its per-session key present → `agentGroupId` defined, possibly
  // null) writes into its OWN channel group, which `secretOwnerGroup` just
  // derived from its session id — the client cannot name another. That
  // derivation IS the authorization, so the write is legitimate for ANY nature,
  // INCLUDING a private group and the Main commons (whose person rule is
  // admin-only, while an agent is a member principal) — otherwise an agent could
  // not store a credential it obtained via the `shadok-secrets` skill. HUMAN (browser) writes stay governed by the
  // membership rules below. Still fail closed on an unresolvable group — we
  // never write into a group we cannot verify.
  if (input.agentGroupId !== undefined) {
    if (!g) return { ok: false, error: `cannot resolve the owner group ${ownerGroup}` };
    return { ok: true, ownerGroup };
  }
  if (!canWriteSecretGroup(g, input.viewer)) {
    return { ok: false, error: `you are not entitled to write a secret in group ${ownerGroup}` };
  }
  return { ok: true, ownerGroup };
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
  return filterReserved(Object.keys(loadVault()[groupId] ?? {})).sort();
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

/**
 * Replace a secret's `sharedWith` list (the groups it is lent to) — an
 * own-property write on the OWNER group's slice. Returns false when the secret
 * does not exist there (the owner-group gate lives at the route). The caller's
 * OWN group is never added: a secret is already resolvable by its owner.
 */
export function setSecretSharing(name: string, groupId: string, sharedWith: string[]): boolean {
  const v = loadVault();
  const slice = v[groupId];
  if (!slice || !Object.hasOwn(slice, name)) return false;
  slice[name] = {
    ...slice[name],
    sharedWith: [...new Set(sharedWith.filter((g) => typeof g === "string" && g && g !== groupId))],
    updatedAt: Date.now(),
  };
  saveVault(v);
  return true;
}

/**
 * Replace a secret's `profiles` binding (the profiles it is injected into) on
 * the OWNER group's slice. The name↔profile link lives here, on the secrets
 * side. Returns false when the secret does not exist in that group.
 */
export function setSecretProfiles(name: string, groupId: string, profiles: string[]): boolean {
  const v = loadVault();
  const slice = v[groupId];
  if (!slice || !Object.hasOwn(slice, name)) return false;
  slice[name] = {
    ...slice[name],
    profiles: [...new Set(profiles.filter((p) => typeof p === "string" && p))],
    updatedAt: Date.now(),
  };
  saveVault(v);
  return true;
}

// ── Who created a secret ─────────────────────────────────────────────────

/**
 * Provenance, kept in a SIDECAR file rather than in the vault: the vault is a
 * nested per-group `Vault` read by several paths (and migrated from an older
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
export function secretsFor(
  names: string[] | undefined,
  groupId: string = MAIN_GROUP_ID,
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): Record<string, string> {
  if (!names?.length) return {};
  return resolveSecretValues(loadVault(), groupId, names, commonsIds);
}

/**
 * The `{NAME: value}` env for an agent running `profileName` in `groupId` — the
 * authoritative injection: every secret bound to the profile (`entry.profiles`,
 * the grouped-panel binding) that resolves from the agent's group, PLUS the
 * legacy `profileSecrets` (so a flat/mono-tenant instance is unchanged). Reading
 * `profileSecrets` alone delivered nothing in grouped mode, where the binding
 * lives on the secret, not the profile.
 */
export function secretsForProfile(
  profileName: string | null | undefined,
  profileSecrets: string[] | undefined,
  groupId: string = MAIN_GROUP_ID,
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): Record<string, string> {
  const vault = loadVault();
  const names = secretNamesForProfile(vault, groupId, profileName ?? "", profileSecrets ?? [], commonsIds);
  return names.length ? resolveSecretValues(vault, groupId, names, commonsIds) : {};
}
