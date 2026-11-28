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
  /**
   * When the teardown of this conversation BEGAN — absent on a live row.
   *
   * Written before the first destructive step and dropped with the row once
   * the account is gone, so a teardown that was interrupted (a crash, a
   * `userdel` refused because a process was still dying) is a fact on disk and
   * not a guess: the boot reconciler finishes it instead of re-provisioning the
   * account, and an admission waits for it instead of landing in the files the
   * operator asked to erase.
   */
  retiring?: number;
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
 * Mark a conversation's account as being torn down (new array). The first mark
 * wins: a retry must not make an old interrupted teardown look recent.
 */
export function withRetiring(
  rows: readonly ExternalUserRow[],
  user: string,
  now: number,
): ExternalUserRow[] {
  return rows.map((r) => (r.user === user && r.retiring == null ? { ...r, retiring: now } : r));
}

/**
 * Is this conversation still held by ANOTHER agent than the one being closed?
 *
 * A conversation's account is torn down with its LAST agent, and "last" is
 * read from the channel registry — the authority on which agents exist — never
 * assumed from "one conversation, one agent". That is true today; the day it
 * is not, an assumption here would `userdel` the account under a live agent.
 * `keyOf` is `guestConversationKey`, injected so this file stays free of the
 * bridges it would otherwise import.
 */
export function conversationHeld<C extends { sessionId: string; group?: string | null }>(
  channels: readonly C[],
  closed: { sessionId: string; group: string; conversation: string },
  keyOf: (c: C) => string | null,
): boolean {
  return channels.some(
    (c) => c.sessionId !== closed.sessionId && c.group === closed.group && keyOf(c) === closed.conversation,
  );
}

/**
 * The uids a LIVE process runs under — the four on the `Uid:` line of its
 * `/proc/<pid>/status` (real, effective, saved, fs) — or `[]` for a text that
 * carries none, and for a ZOMBIE.
 *
 * The zombie case is not a nicety. In a container pid 1 is the application,
 * not an init that reaps (the reason `src/lock.ts` reads the same state): a
 * killed process whose parent already exited stays in `/proc` under its uid
 * until something collects it, which may be never. Counted as alive, every
 * teardown would report "survived the kill" forever — measured on a real
 * container, three of three. It holds no file open and can write nothing, so
 * for an erasure it is gone.
 */
export function liveUidsOfProcStatus(status: string): number[] {
  if (/^State:\s+[ZX]\b/m.test(status)) return [];
  const m = /^Uid:\s+(.+)$/m.exec(status);
  if (!m) return [];
  return m[1].trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
}

export interface ConversationTeardownDeps {
  /** The account's numeric uid, or null when the account does not exist. */
  uidOf: (user: string) => number | null;
  /** The uid the server itself runs as — never a uid to kill or sweep. */
  selfUid: number;
  /** Kill every process running as this uid; resolves to how many are LEFT. */
  killProcesses: (uid: number) => Promise<number>;
  /** Delete what this uid owns OUTSIDE its home (temp directories). */
  sweepStray: (uid: number) => Promise<void>;
  /** Delete the conversation's media directory (server-owned, outside the home). */
  removeMedia: () => Promise<void> | void;
  /** `userdel --remove <user>`: the account, its home, its mail spool. */
  userdel: (user: string) => Promise<void>;
  /** Delete the home of an account that NO LONGER EXISTS (nothing left for
   *  `userdel` to do it). */
  removeHome: (user: string) => Promise<void>;
  /** Pause between two attempts at an account a dying process still holds. */
  wait?: (ms: number) => Promise<void>;
}

/** The only shape `osUserForUnit` gives a conversation's account. */
export const CONVERSATION_USER_RE = /^sk-x[0-9a-f]{27}$/;

/** How many times the kill → `userdel` pair is tried before giving up. */
export const TEARDOWN_ATTEMPTS = 3;

/**
 * Erase ONE conversation's account and everything it owns on this host.
 *
 * The order is the design, and each step is there for a failure that would
 * otherwise be silent:
 *
 * 1. **Processes first.** Stopping the agent stops `claude`, not what it
 *    started, and `userdel` does NOT refuse an account with live processes
 *    (measured: it only looks at logins) — a background shell would simply run
 *    on, under a uid nothing names any more, rewriting what we delete.
 * 2. **Then what the uid owns outside its home**, while the uid is still known.
 *    `userdel --remove` only takes the home, and `useradd` hands out the lowest
 *    free uid above the others — so the NEXT stranger admitted can receive this
 *    very uid and, with it, every temp file left behind. That is the uid
 *    recycling the design names as an anti-goal, and it is exactly what
 *    "delete, then recreate" walks into.
 * 3. **The media directory**, which the server owns and no `userdel` knows of.
 * 4. **The account and its home, last** — so a failure before it leaves an
 *    account whose registry row still says whose it was.
 *
 * It never throws. `ok: false` means the account may still be there: the
 * caller keeps the registry row (marked `retiring`), which is what makes the
 * retry possible and what stops a later admission from inheriting the files.
 * An account that is already gone is a success once its home is gone too — the
 * retry after a crash between the `userdel` and the row's removal must
 * converge.
 */
export async function teardownConversationUser(
  user: string,
  deps: ConversationTeardownDeps,
): Promise<{ ok: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // Everything below kills by uid and deletes by uid, as root. The name comes
  // from a file and the uid from `/etc/passwd`, so both are checked against
  // what a conversation's account can possibly be before either is trusted:
  // one wrong row must not be able to aim this at root, at the server, or at a
  // group's account.
  if (!CONVERSATION_USER_RE.test(user))
    return { ok: false, warnings: [`"${user}" is not a conversation's account — refusing to tear it down`] };
  let ok = true;
  try {
    await deps.removeMedia();
  } catch (e) {
    ok = false;
    warnings.push(`removing the conversation's media failed: ${why(e)}`);
  }
  const uid = deps.uidOf(user);
  if (uid == null) {
    // No account does not mean no files. `/etc/passwd` is ephemeral in a
    // container while the homes sit on a volume, so after a recreate the
    // account is gone and its home is not — and the next `useradd
    // --create-home` under this name would adopt it as it stands.
    try {
      await deps.removeHome(user);
    } catch (e) {
      ok = false;
      warnings.push(`removing ${user}'s leftover home failed: ${why(e)}`);
    }
    return { ok, warnings };
  }
  if (uid === 0 || uid === deps.selfUid)
    return { ok: false, warnings: [...warnings, `${user} resolves to uid ${uid}, which is not a conversation's — refusing to tear it down`] };
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let gone = false;
  for (let attempt = 1; attempt <= TEARDOWN_ATTEMPTS && !gone; attempt++) {
    let left = 0;
    try {
      left = await deps.killProcesses(uid);
    } catch (e) {
      warnings.push(`killing ${user}'s processes failed: ${why(e)}`);
    }
    // A process that outlived the kill can still write: sweeping or deleting
    // under it would only race it. Wait and try again.
    if (left > 0) {
      if (attempt < TEARDOWN_ATTEMPTS) await wait(300 * attempt);
      else warnings.push(`${left} process(es) of ${user} survived the kill`);
      continue;
    }
    try {
      await deps.sweepStray(uid);
    } catch (e) {
      // As blocking as a failed `userdel`, and before it on purpose: once the
      // account is gone nothing names this uid any more, and a file left under
      // it is precisely what the next account to receive the uid inherits.
      if (attempt < TEARDOWN_ATTEMPTS) await wait(300 * attempt);
      else warnings.push(`sweeping ${user}'s temp files failed: ${why(e)}`);
      continue;
    }
    try {
      await deps.userdel(user);
      gone = true;
    } catch (e) {
      if (attempt < TEARDOWN_ATTEMPTS) await wait(300 * attempt);
      else warnings.push(`userdel --remove ${user} failed: ${why(e)}`);
    }
  }
  return { ok: ok && gone, warnings };
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
    const kept: ExternalUserRow = {
      user,
      unit,
      createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    };
    // ANY trace of the mark keeps it: a row that was being erased must never
    // read as live because its timestamp was mangled.
    if (row.retiring != null) kept.retiring = typeof row.retiring === "number" && Number.isFinite(row.retiring) ? row.retiring : 0;
    out.push(kept);
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
