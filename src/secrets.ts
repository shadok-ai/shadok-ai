import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAIN_GROUP_ID, canWriteSecretGroup, spawnGroupFor, type Group, type Viewer } from "./groups.js";
import { unitConversation, unitGroup, type UnitId } from "./isolation-unit.js";
import { isGuestSlice } from "./guest-vault.js";

/**
 * Central secret vault: named secrets stored OUTSIDE any repo at
 * ~/.shadok-ai/secrets.json (600) and injected as environment variables into an
 * agent's `claude` process at spawn — never written into the working directory.
 *
 * Per ISOLATION UNIT: `{ unit: { NAME: SecretEntry } }`. One server-owned file
 * with policy scoping (not one file per unit). Names are unique PER UNIT, never
 * global. A group may SHARE a secret by reference (`sharedWith`), and `Main`
 * is the instance-wide fallback. A profile lists the NAMES it wants injected.
 *
 * The unit is a GROUP id for every group but an external one, byte for byte as
 * it always was — an existing instance's file is untouched by this. In an
 * EXTERNAL group it is `"<group>/<conversation>"` (`src/isolation-unit.ts`), so
 * a stranger gets a slice of their own, sealed from every other conversation:
 * see `src/guest-vault.ts` for the policy that seals it, and the design's
 * decisions 4 and 6.
 */
/**
 * In a secret's `profiles`: "every profile" — injected into EVERY agent the
 * secret resolves for (own group, shared-in, commons), with or without a
 * profile. Only a person may set it (`PUT /secrets/profiles`): it widens a
 * credential to agents nobody picked one by one.
 */
export const ANY_PROFILE = "*";

/**
 * May an AGENT overwrite this existing entry? Not one bound to `ANY_PROFILE`:
 * its value reaches every agent that resolves it (for a commons secret, every
 * agent on the instance), so replacing it is a person's act. Null = allowed.
 */
export function agentOverwriteRefusal(entry: Pick<SecretEntry, "profiles"> | undefined, isAgent: boolean): string | null {
  if (!isAgent || !entry || !entry.profiles.includes(ANY_PROFILE)) return null;
  return "This secret is given to every profile; only a person can change its value, from the web UI.";
}

/**
 * Why a NEW secret's name is refused, or null when it is usable. A secret
 * reaches an agent as an ENVIRONMENT VARIABLE named after it, so the name must
 * be a valid one: letters, digits and `_`, not starting with a digit. A name
 * with a space (or a dash, a dot…) was accepted, then broke at use — the
 * variable cannot be set or read by that name. Checked at CREATION only: an
 * existing odd name stays editable and deletable, so nobody is trapped with it.
 * Twin in `index.html` (the vault form), same message.
 */
export function secretNameRefusal(name: string): string | null {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const why = /\s/.test(name)
    ? "it contains a space"
    : /^[0-9]/.test(name)
      ? "it starts with a digit"
      : "it contains a character other than letters, digits and _";
  return `"${name}" cannot be a secret name: ${why}. A secret becomes an environment variable, so use only letters, digits and _ (not starting with a digit), e.g. ${suggestSecretName(name)}.`;
}

/** The nearest valid name, for the refusal's example: separators → `_`, other
 *  characters dropped, upper-cased, a leading digit prefixed. */
export function suggestSecretName(name: string): string {
  let s = name.trim().replace(/[\s.\-/]+/g, "_").replace(/[^A-Za-z0-9_]/g, "").toUpperCase();
  if (!s) return "MY_SECRET";
  if (/^[0-9]/.test(s)) s = "_" + s;
  return s;
}

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
  unit: UnitId,
  name: string,
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): SecretEntry | undefined {
  const mine = ownOf(ownOf(vault, unit), name);
  if (mine) return mine;
  // A GUEST CONVERSATION's slice resolves to ITSELF, then to its own EXTERNAL
  // GROUP's slice, and nothing else — no shared-in, no public commons, no Main.
  // The refusal lives here, in the one selection rule, so no caller can forget
  // it: every tier below hands a credential to an agent nobody chose to give it
  // to, and in an external group that agent is a stranger's.
  //
  // The group tier is the one exception, and it is an operator's deliberate
  // act (decision 2026-11-28, amending design decision 4): a secret a MEMBER
  // stores on the external group itself is for every conversation of that door
  // — a service key every guest's agent needs. Only a person can write there
  // (a guest's agent writes its own conversation, `secretOwnerGroup`), and
  // what it costs is said where it is written: every stranger's agent holds
  // the value, and a stranger can ask their agent to show it.
  if (isGuestSlice(unit)) return ownOf(ownOf(vault, unitGroup(unit)), name);
  // When two groups share the same name with the caller, the winner is
  // insertion-order-deterministic: the first such group in `Object.entries` order.
  for (const [gid, gv] of Object.entries(vault)) {
    const e = ownOf(gv, name);
    if (gid !== unit && e && e.sharedWith.includes(unit)) return e;
  }
  // The COMMONS tier: Main, plus every PUBLIC non-Main group — a public group is
  // visible-to-all (operator decision 2026-11-03: "public = commun"), so its
  // secrets resolve for EVERY agent, exactly like Main's. `commonsIds` is passed
  // by the server (it owns the group natures); it defaults to Main alone, so a
  // caller that does not know the natures keeps today's own→shared→Main behaviour.
  for (const cid of commonsIds) {
    if (cid === unit) continue; // own already checked above
    const e = ownOf(ownOf(vault, cid), name);
    if (e) return e;
  }
  return undefined;
}

export function resolveSecretValues(
  vault: Vault,
  unit: UnitId,
  names: readonly string[],
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const e = resolveSecretEntry(vault, unit, name, commonsIds);
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
  unit: UnitId,
  profileName: string,
  profileSecrets: readonly string[] = [],
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): string[] {
  // A GUEST CONVERSATION: every name in its OWN slice, and nothing else.
  //
  // No profile binding, on purpose. `entry.profiles` exists to say WHICH agents
  // of a group receive a credential, and inside a conversation's slice that
  // question has one answer — the conversation's own agents, which is every
  // agent that can resolve this unit at all. A binding would only be a way to
  // get it wrong. The legacy `profileSecrets` list is dropped for the same
  // reason it must be: those names resolve from the profile, which is shared by
  // every stranger on the door, and an external door already refuses a profile
  // that carries secrets (`guestEnableRefusal`).
  //
  // Plus every name of its EXTERNAL GROUP's own slice (see `resolveSecretEntry`),
  // likewise without a binding: a group secret there is for every conversation
  // of the door, and the profile is the same one for all of them anyway.
  if (isGuestSlice(unit)) {
    const names = (slice: GroupVault | undefined) => Object.keys(slice ?? {}).filter((n) => Object.hasOwn(slice ?? {}, n));
    return filterReserved([...new Set([...names(vault[unit]), ...names(vault[unitGroup(unit)])])]);
  }
  const out = new Set<string>(profileSecrets.filter((n) => typeof n === "string" && n));
  const names = new Set<string>();
  for (const slice of Object.values(vault)) {
    if (!slice || typeof slice !== "object") continue;
    for (const n of Object.keys(slice)) if (Object.hasOwn(slice, n)) names.add(n);
  }
  for (const name of names) {
    const e = resolveSecretEntry(vault, unit, name, commonsIds);
    if (!e) continue;
    // `ANY_PROFILE` reaches an agent without a profile too: "any" is every agent
    // the secret resolves for, which is the only thing still gating it.
    if (e.profiles.includes(ANY_PROFILE) || (profileName && e.profiles.includes(profileName))) out.add(name);
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

export type SecretSource = "own" | "shared" | "main" | "guest";
export interface VisibleSecret {
  name: string;
  source: SecretSource;
  /** The group that OWNS the secret — omitted for a Main secret (`source:"main"`). */
  ownerGroup?: string;
  /** Only on `source:"guest"` — the conversation whose slice holds it, and the
   *  unit a write must target. The name is all a member ever sees of it. */
  conversation?: string;
  unit?: string;
  /** Audit fields — metadata only, never the value. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Only on a secret the caller OWNS: the groups it is lent to / the profiles it feeds. */
  sharedWith?: string[];
  profiles?: string[];
  /** A Main secret the caller may write (`mainWritable`): the panel edits it in "Public groups". */
  editable?: true;
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
export function visibleSecrets(
  vault: Vault,
  ownGroupIds: ReadonlySet<string>,
  mainWritable = false,
  ownUnit: UnitId | null = null,
): VisibleSecret[] {
  // A GUEST's own agent asking what it holds sees its OWN slice and nothing
  // else — not the group's, and above all not another conversation's. Its
  // viewer is a member of its group (`Viewer.onlySession`), so without this it
  // would come through `ownGroupIds` below and read every stranger's NAMES on
  // the door. A name is not a value, and it is still someone else's.
  // Its group's own slice is listed too, as lent to it (`shared`): those are
  // in its environment, and an agent told it holds nothing would ask the person
  // for a key it already has. The conversation's own entry wins a shared name,
  // as it does at resolution.
  if (ownUnit && isGuestSlice(ownUnit)) {
    const out = new Map<string, VisibleSecret>();
    const add = (slice: GroupVault | undefined, owner: string, source: "own" | "shared") => {
      for (const name of Object.keys(slice ?? {})) {
        if (!slice || !Object.hasOwn(slice, name) || RESERVED_SECRET_NAMES.has(name) || out.has(name)) continue;
        const e = slice[name];
        out.set(name, { name, source, ownerGroup: owner, createdBy: e.createdBy, createdAt: e.createdAt, updatedAt: e.updatedAt });
      }
    };
    add(vault[ownUnit], ownUnit, "own");
    add(vault[unitGroup(ownUnit)], unitGroup(ownUnit), "shared");
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  const rank: Record<SecretSource, number> = { own: 0, shared: 1, main: 2, guest: 3 };
  const chosen = new Map<string, VisibleSecret>();
  // Guest rows are collected apart and keyed by UNIT+name, never folded into
  // `chosen`: that map is keyed by name alone (one name resolves to one value
  // for a group), and a stranger who stores `GITHUB_TOKEN` must not displace —
  // or be displaced by — the group's own `GITHUB_TOKEN`. They are different
  // secrets in different slices and the panel lists them as such.
  const guests = new Map<string, VisibleSecret>();
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
      // A GUEST CONVERSATION's slice, seen by the GROUP's members: the names,
      // never the values — the vault's existing rule, applied to a stranger's
      // data because the operator is accountable for what their instance holds
      // (design decision 6). Not shared, not bindable, and not creatable by a
      // member: see `guestSliceWriteRefusal`.
      const conv = unitConversation(gid);
      if (conv !== null) {
        if (ownGroupIds.has(unitGroup(gid)))
          guests.set(`${gid}\u0000${name}`, { name, source: "guest", ownerGroup: unitGroup(gid), conversation: conv, unit: gid, ...audit });
        continue;
      }
      // Main stays tagged `main` (every view lists it as inherited), but a caller
      // who may WRITE Main gets its sharing/profiles too, so the "Public groups"
      // view can edit it: Main is the first public group, not a read-only tier.
      if (gid === MAIN_GROUP_ID)
        consider(
          mainWritable
            ? { name, source: "main", ownerGroup: MAIN_GROUP_ID, ...audit, sharedWith: [...e.sharedWith], profiles: [...e.profiles], editable: true }
            : { name, source: "main", ...audit },
        );
      else if (ownGroupIds.has(gid))
        consider({ name, source: "own", ownerGroup: gid, ...audit, sharedWith: [...e.sharedWith], profiles: [...e.profiles] });
      else if (e.sharedWith.some((g) => ownGroupIds.has(g)))
        consider({ name, source: "shared", ownerGroup: gid, ...audit });
    }
  }
  return [
    ...[...chosen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    // After the group's own, always: a member reads their own vault first, and
    // a busy door's conversations would otherwise bury it.
    ...[...guests.values()].sort((a, b) => (a.conversation ?? "").localeCompare(b.conversation ?? "") || a.name.localeCompare(b.name)),
  ];
}

/**
 * Pure: the units a secret may ACTUALLY be lent to, from what a caller asked.
 *
 * Its own owner is dropped because a secret is already resolvable by its owner.
 * A GUEST CONVERSATION is dropped because a conversation's slice resolves to
 * ITSELF only (`resolveSecretEntry`), so a row claiming to lend a secret to one
 * would be stored, listed as shared — and reach nobody: a grant that reads as
 * real and is not, which is the worst way for an access listing to be wrong.
 * The panel cannot even offer it (`shareTargets` lists groups), so this only
 * ever catches a hand-made call — which is exactly why it belongs in the data's
 * own rule rather than in the UI.
 */
export function shareableTargets(asked: readonly unknown[], owner: UnitId): string[] {
  return [...new Set(asked.filter((g): g is string => typeof g === "string" && !!g && g !== owner && !isGuestSlice(g)))];
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
 *   - an AGENT (`agentGroupId` present, even as null): its OWN channel's
 *     ISOLATION UNIT — its group, or its own conversation in an external group
 *     — or Main when it has none. A `requestedGroup` that differs is IGNORED —
 *     an agent must never aim another tenant's vault by naming it in the body;
 *     it writes only its own unit (Task 10's agent-own-group rule, private
 *     included, and now one stranger's conversation at a time).
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
  // The owner may be a whole group or ONE CONVERSATION of an external group
  // (`"<group>/<conversation>"`). The membership gate is the GROUP's either
  // way: who may touch a guest's slice is decided by the group they knocked on,
  // and the extra rule for a guest slice — rotate and delete, never create, and
  // never shared out — is `guestSliceWriteRefusal`, applied where the operation
  // is known.
  const aclGroup = unitGroup(ownerGroup);
  const g =
    input.groups.find((x) => x.id === aclGroup) ??
    (aclGroup === MAIN_GROUP_ID
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
    return { ok: false, error: `you are not entitled to write a secret in group ${aclGroup}` };
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

/** Secret names (never the values) in one unit's own slice, sorted. */
export function secretNames(unit: UnitId = MAIN_GROUP_ID): string[] {
  return filterReserved(Object.keys(loadVault()[unit] ?? {})).sort();
}

/**
 * Wipe a whole slice, returning the names it held.
 *
 * The one gesture behind "the slice dies with the agent" (design decision 7):
 * a guest's Unix user and HOME SURVIVE their agent's deletion on purpose — the
 * person comes back to their own folder — while the credentials they handed
 * over do not. Minimum retention, and no orphaned stranger credentials left on
 * the operator's disk.
 *
 * Returns the names so the caller can write one audit row: a credential that
 * disappears with no trace is the one vault move nobody could account for.
 */
export function deleteVaultSlice(unit: UnitId): string[] {
  const v = loadVault();
  const slice = v[unit];
  if (!slice) return [];
  const names = Object.keys(slice);
  delete v[unit];
  saveVault(v);
  return names;
}

/**
 * Every GUEST CONVERSATION slice of a group, with the names each holds — what
 * the vault panel lists for a member and what a group teardown has to sweep.
 * Names only, like every listing: the values never leave this module.
 */
export function guestSlicesOf(vault: Vault, groupId: string): { unit: UnitId; conversation: string; names: string[] }[] {
  const out: { unit: UnitId; conversation: string; names: string[] }[] = [];
  for (const [unit, slice] of Object.entries(vault)) {
    if (unitGroup(unit) !== groupId) continue;
    const conv = unitConversation(unit);
    if (conv === null || !slice || typeof slice !== "object") continue;
    out.push({ unit, conversation: conv, names: filterReserved(Object.keys(slice)).sort() });
  }
  return out.sort((a, b) => a.conversation.localeCompare(b.conversation));
}

/**
 * Create or update a secret in `groupId` (default Main); an update keeps its
 * sharing, provenance and profile binding. `profiles` applies to a CREATION
 * only — it is how an agent's create-and-attach lands in one write.
 */
export function setSecret(
  name: string,
  value: string,
  unit: UnitId = MAIN_GROUP_ID,
  createdBy = "",
  profiles: readonly string[] = [],
): void {
  const v = loadVault();
  const now = Date.now();
  const prev = v[unit]?.[name];
  (v[unit] ??= {})[name] = prev
    ? { ...prev, value, updatedAt: now }
    : { value, ownerGroup: unit, sharedWith: [], profiles: [...new Set(profiles)], createdBy, createdAt: now, updatedAt: now };
  saveVault(v);
}

export function deleteSecret(name: string, unit: UnitId = MAIN_GROUP_ID): void {
  const v = loadVault();
  if (v[unit] && name in v[unit]) {
    delete v[unit][name];
    if (!Object.keys(v[unit]).length) delete v[unit];
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
    sharedWith: shareableTargets(sharedWith, groupId),
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
 * The profile of the AGENT that created `entry`, or null — null means "a
 * person put it there", or a creator we can no longer resolve.
 *
 * It exists for exactly one decision: an agent may bind to its own profile a
 * secret IT created, and nothing else (see `secretAttachVerdict`). So it reads
 * the entry's own `createdBy` — stamped server-side at creation, kept on an
 * overwrite, and scoped to the entry's group — and fails closed on anything
 * else: absence denies, it never grants.
 *
 * It replaced a name-keyed sidecar (`secret-origin.json`) that could not be
 * trusted once groups existed: one name lives in several groups, so a creation
 * in one group re-stamped the "creator" of a same-named secret in another, and
 * a person who deleted and re-created a name inherited the old agent creator.
 */
export function creatorProfile(
  entry: Pick<SecretEntry, "createdBy"> | undefined,
  profileOfAgent: (agentId: string) => string | null,
): string | null {
  const m = /^agent:(.+)$/.exec(entry?.createdBy ?? "");
  if (!m) return null;
  const profile = profileOfAgent(m[1])?.trim();
  return profile || null;
}

/**
 * Pure: may a `PUT /secrets` that asked to bind the new secret to the caller's
 * own profile (`attach: true`) go ahead? Decided BEFORE anything is written, so
 * a refusal never leaves a stored-but-unbound secret behind.
 *
 * Only a CREATION may carry the bind: the value is the one the agent just
 * handed over, so binding it grants nothing it did not already hold. An
 * overwrite must not, or an agent could replace a person's secret and claim it.
 */
export function createAttachRefusal(opts: { verdict: SecretWrite; callerProfile: string | null }): string | null {
  if (opts.verdict !== "created")
    return "attach is only possible when creating a secret, never on an overwrite";
  if (!opts.callerProfile)
    return "this agent has no profile, so it has nothing to attach a secret to";
  return null;
}

/**
 * The `{ NAME: value }` env for a set of referenced names (unknown ones skipped),
 * resolved from `groupId` (own → shared-in → Main). `groupId` defaults to Main,
 * which is every agent in a mono-tenant instance.
 */
export function secretsFor(
  names: string[] | undefined,
  unit: UnitId = MAIN_GROUP_ID,
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): Record<string, string> {
  if (!names?.length) return {};
  return resolveSecretValues(loadVault(), unit, names, commonsIds);
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
  unit: UnitId = MAIN_GROUP_ID,
  commonsIds: readonly string[] = [MAIN_GROUP_ID],
): Record<string, string> {
  const vault = loadVault();
  const names = secretNamesForProfile(vault, unit, profileName ?? "", profileSecrets ?? [], commonsIds);
  return names.length ? resolveSecretValues(vault, unit, names, commonsIds) : {};
}
