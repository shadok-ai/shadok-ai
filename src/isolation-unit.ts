import { createHash } from "node:crypto";
import type { Group } from "./groups.js";

/**
 * The ISOLATION UNIT: the thing shadok actually walls off.
 *
 * Until now that was always a group, so "group id" and "isolation unit" were
 * the same string and every per-group store keyed on it — the OS user
 * (`sk-<id>`), the HOME, the media subdirectory (`g-<id>`), the vault slice.
 * An EXTERNAL group moves the unit one level down: every question a restricted
 * group answers with "the group", an external group answers with "the
 * conversation" (design decision 1).
 *
 * Rather than teach each of those stores about conversations, the unit becomes
 * ONE string they all keep keying on:
 *
 * - `"<groupId>"` — a group, exactly as today. Nothing about an existing
 *   instance changes: same user, same home, same media directory, same slice.
 * - `"<groupId>/<conversation>"` — one conversation of an external group.
 *
 * The `/` is deliberate: it is not a legal username character and not a legal
 * media directory name, so every name built from a unit is forced down the
 * HASHED path instead of the readable one. A unit can never be mistaken for a
 * group id by code that was written before this existed.
 *
 * Pure and dependency-free (the `Group` import is type-only, erased at
 * runtime), like `groups.ts` and `osusers.ts`, so the whole wall is testable
 * with no server and no root.
 *
 * See docs/superpowers/specs/2026-11-26-external-groups-per-conversation-isolation-design.md,
 * decisions 1, 2 and 8.
 */

/** A group id, or a group id and one conversation inside it. */
export type UnitId = string;

const SEP = "/";

/** The unit of a whole group — what every non-external group isolates by. */
export function groupUnit(groupId: string): UnitId {
  return groupId;
}

/** The unit of ONE conversation inside an external group. */
export function conversationUnit(groupId: string, conversation: string): UnitId {
  return `${groupId}${SEP}${conversation}`;
}

/** The group a unit belongs to (a conversation's unit included). */
export function unitGroup(unit: UnitId): string {
  const i = unit.indexOf(SEP);
  return i < 0 ? unit : unit.slice(0, i);
}

/** The conversation a unit names, or null when the unit is a whole group. */
export function unitConversation(unit: UnitId): string | null {
  const i = unit.indexOf(SEP);
  return i < 0 ? null : unit.slice(i + 1) || null;
}

/**
 * The isolation unit of an agent (or any resource) of `g`, given the
 * conversation it belongs to — `null` for anything that is not a guest's
 * conversation.
 *
 * A REFUSAL, not a fallback, and that is the whole point. "There is never a
 * fallback to the group's user or to the commons: a resolution that does not
 * produce the intended isolation refuses to answer at all" (design decision 2).
 * An external group whose conversation we cannot name has no unit — because the
 * available answers would both be wrong: the group's own user puts two
 * strangers in one account, and the commons puts a stranger in the shared one.
 */
export function unitFor(
  g: Pick<Group, "id" | "nature">,
  conversation: string | null | undefined,
): { ok: true; unit: UnitId } | { ok: false; why: string } {
  if (g.nature !== "external") return { ok: true, unit: groupUnit(g.id) };
  if (!conversation)
    return {
      ok: false,
      why: "an external group isolates per conversation, and this one names none",
    };
  return { ok: true, unit: conversationUnit(g.id, conversation) };
}

/**
 * Does this unit have an OS user of its own, and what is it called?
 *
 * `null` for the commons (a public group shares the server's own user — there
 * is nothing to isolate from). A GROUP unit keeps today's readable
 * `sk-<group id>` byte for byte: an existing instance's users, homes and
 * `/etc/passwd` rows are untouched by this file existing.
 *
 * A CONVERSATION unit is HASHED, and it has to be: a username is capped at 32
 * characters, and neither a UUID group id nor a phone number fits beside the
 * other. The consequence is the reason `src/external-users.ts` exists — a hash
 * is not reversible, so the mapping has to be written down rather than derived
 * and hoped for.
 *
 * `sk-x` marks a conversation's user apart from a group's at a glance (`id -u`,
 * `/etc/passwd`, a stray file's owner), and 27 hex characters keep the whole
 * name at 31 — the same budget `sk-<28>` already used.
 */
export function osUserForUnit(unit: UnitId, nature: Group["nature"]): string | null {
  if (nature === "public") return null;
  const conv = unitConversation(unit);
  if (conv === null) {
    const s = String(unit).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 28);
    return "sk-" + (s || "x");
  }
  return "sk-x" + createHash("sha256").update(unit).digest("hex").slice(0, 27);
}
