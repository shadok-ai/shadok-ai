/**
 * The instance context: one short text per instance — what it is for, who it
 * serves, its working language — that every agent receives at spawn whatever
 * its profile. A role says HOW to work; nothing told an agent what the instance
 * it runs on is FOR, so every agent rediscovered it, or never did.
 *
 * Written ONCE by the lead agent at first run (after asking), then owned by the
 * humans who edit it in the cockpit. An agent never rewrites it afterwards — it
 * suggests — because an agent quietly changing the purpose every agent is told
 * is the failure to avoid (invariant 26's family).
 *
 * Design: docs/superpowers/specs/2026-11-09-instance-context-design.md
 */

export const INSTANCE_CONTEXT_MAX = 2000;
export const INSTANCE_CONTEXT_LABEL = "Instance context";

/** Trim; empty is allowed (it clears); over the cap is refused, never truncated. */
export function normalizeInstanceContext(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, text: "" };
  if (typeof raw !== "string") return { ok: false, error: "the instance context must be text" };
  const text = raw.trim();
  if (text.length > INSTANCE_CONTEXT_MAX)
    return { ok: false, error: `the instance context is limited to ${INSTANCE_CONTEXT_MAX} characters (got ${text.length})` };
  return { ok: true, text };
}

/** The lead's once-only write: null = allowed, else the reason it is refused. */
export function firstWriteVerdict(input: { isHome: boolean; current: string }): string | null {
  if (!input.isHome) return "only the instance's lead agent (its home channel) may write the instance context";
  if (input.current.trim())
    return "the instance context is already set — suggest the change in the chat; a human edits it from the cockpit menu";
  return null;
}

/** The section appended to every agent's system prompt, or null when there is none. */
export function instanceContextSection(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return "## This instance\n\nWhat this shadok instance is for, set by the people who run it. It applies to every agent here, whatever its role.\n\n" + t;
}

/** The spawn flags carrying it — nothing at all when it is empty. */
export function instanceContextArgs(text: string): string[] {
  const s = instanceContextSection(text);
  return s ? ["--append-system-prompt", s] : [];
}
