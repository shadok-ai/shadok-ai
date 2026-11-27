import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UnitId } from "./isolation-unit.js";
import { conversationUnit, unitConversation, unitGroup } from "./isolation-unit.js";

/**
 * The registry that binds a per-conversation Unix user to the conversation it
 * belongs to — `~/.shadok-ai/external-users.json`, root-owned like the vault.
 *
 * It exists because the NAME is a hash (`osUserForUnit`): a username is capped
 * at 32 characters and neither a UUID group id nor a phone number fits beside
 * the other, so the mapping is not reversible. Everything that has to go the
 * other way — tearing a conversation down, reconciling a missing account at
 * boot, telling an operator what that `sk-x…` row in `/etc/passwd` is — needs
 * it written down rather than derived and hoped for (design decision 2).
 *
 * The second reason is the one that makes it fail CLOSED: provisioning refuses
 * when the name it computed is already bound to a DIFFERENT conversation.
 * Two strangers sharing one Unix account is a silent cross-guest leak — the
 * exact thing the external nature exists to prevent — so a collision is loud
 * and stops the admission, and there is never a fallback to the group's user or
 * to the commons.
 *
 * The decisions here are pure (the store is injected by the caller), so the
 * whole rule is unit-tested with no filesystem and no root.
 */

export interface ExternalUserRow {
  /** The Unix account (`sk-x<hash>`). */
  user: string;
  /** The isolation unit it was minted for (`<group>/<conversation>`). */
  unit: UnitId;
  createdAt: number;
}

/**
 * What provisioning this conversation's user amounts to, against the registry.
 *
 * `known` — the same conversation came back, so the same name resolves to the
 * same account and nothing is written. This is what makes a returning guest
 * land in their own home again.
 *
 * `collision` — the name is bound to another unit. Refused, and never worked
 * around: renaming would hand this person a home the registry says belongs to
 * someone else, and reusing would put two strangers in one account.
 */
export function externalUserVerdict(
  rows: readonly ExternalUserRow[],
  want: { user: string; unit: UnitId },
  now: number,
):
  | { kind: "known"; row: ExternalUserRow }
  | { kind: "new"; row: ExternalUserRow }
  | { kind: "collision"; why: string } {
  const byName = rows.find((r) => r.user === want.user);
  if (byName) {
    if (byName.unit === want.unit) return { kind: "known", row: byName };
    return {
      kind: "collision",
      why:
        `the Unix account "${want.user}" is already bound to another conversation ` +
        `(group ${unitGroup(byName.unit)}) — refusing rather than letting two people share it`,
    };
  }
  // The same unit under a DIFFERENT name is just as broken, and in the harder
  // direction: it means the naming changed under a live conversation, so this
  // person has a home, a vault slice and a media directory under a name nothing
  // will resolve to again. Refuse and say which it was, rather than mint a
  // second account and silently abandon the first.
  const byUnit = rows.find((r) => r.unit === want.unit);
  if (byUnit)
    return {
      kind: "collision",
      why: `this conversation is already bound to the Unix account "${byUnit.user}", not to "${want.user}"`,
    };
  return { kind: "new", row: { user: want.user, unit: want.unit, createdAt: now } };
}

/** Append a row (new array, input untouched). */
export function withExternalUser(
  rows: readonly ExternalUserRow[],
  row: ExternalUserRow,
): ExternalUserRow[] {
  return [...rows, row];
}

/** Every conversation account of one group — what a group's teardown must
 *  remove, and what a boot reconciler must check. */
export function externalUsersOfGroup(
  rows: readonly ExternalUserRow[],
  groupId: string,
): ExternalUserRow[] {
  return rows.filter((r) => unitGroup(r.unit) === groupId);
}

/** The account minted for this conversation, or null. */
export function externalUserRow(
  rows: readonly ExternalUserRow[],
  groupId: string,
  conversation: string,
): ExternalUserRow | null {
  const unit = conversationUnit(groupId, conversation);
  return rows.find((r) => r.unit === unit) ?? null;
}

/** Drop rows (new array) — a torn-down conversation, or a deleted group's lot. */
export function withoutExternalUsers(
  rows: readonly ExternalUserRow[],
  users: readonly string[],
): ExternalUserRow[] {
  const gone = new Set(users);
  return rows.filter((r) => !gone.has(r.user));
}

/**
 * A stored registry, cleaned. A malformed row is DROPPED rather than repaired:
 * a row is a claim that an account belongs to one conversation, and a half-read
 * claim is worse than no claim — the collision refusal would then compare
 * against nonsense. A row whose unit names no conversation is malformed by
 * definition (a group-level user is not minted here).
 */
export function normalizeExternalUsers(raw: unknown): ExternalUserRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ExternalUserRow[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const user = typeof row.user === "string" ? row.user.trim() : "";
    const unit = typeof row.unit === "string" ? row.unit.trim() : "";
    if (!user || !unit || !unitConversation(unit)) continue;
    if (seen.has(user)) continue; // first wins: a duplicated name is unreadable
    seen.add(user);
    out.push({
      user,
      unit,
      createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    });
  }
  return out;
}

// ── The store ────────────────────────────────────────────────────────────
// Root-owned and 0600, beside the vault and for the same reason: it says which
// human a Unix account on this host belongs to. No route reads it.

const FILE = path.join(os.homedir(), ".shadok-ai", "external-users.json");

export function loadExternalUsers(): ExternalUserRow[] {
  try {
    return normalizeExternalUsers(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    // Absent or unreadable reads as EMPTY, and that is safe in the direction
    // that matters: an empty registry refuses nothing, and the provisioning it
    // then attempts is idempotent (`provisionGroupUser` reuses an existing
    // account). What it must never do is answer "no collision" from a file it
    // failed to parse — which is why `normalizeExternalUsers` drops malformed
    // rows one by one instead of giving up on the file.
    return [];
  }
}

export function saveExternalUsers(rows: readonly ExternalUserRow[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600); // enforce 600 even if the file pre-existed
}
