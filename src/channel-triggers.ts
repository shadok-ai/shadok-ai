/**
 * What goes away WITH a channel: the schedules and webhooks that target it.
 *
 * Both stores key their rows on a `sessionId`, and neither was told when the
 * channel behind that id was closed. A schedule then kept firing at a session
 * that no longer existed — every slot, a failure nobody was shown — and a
 * webhook kept a live URL and a valid token pointing at nothing.
 *
 * The one rule that makes this safe: the cleanup is keyed on the channel being
 * REMOVED, never on "no process is running". A dormant channel has no process
 * by definition, and waking it is exactly what a schedule or a webhook is for —
 * a liveness test here would delete the feature along with the bug. So nothing
 * in this file can see a session, a pilot or a registry: it filters by id, and
 * the caller decides WHEN (`endChannel`, on an explicit close).
 *
 * Pure, tested by `test/channel-triggers.test.ts`.
 */

/** Anything stored against a channel. */
interface Targeted {
  sessionId: string;
}

/**
 * Split a store into the rows that stay and the rows that target `sessionId`.
 * An empty id removes NOTHING: `"" === ""` must never be a way to match a
 * malformed row and wipe it on someone else's close.
 */
export function splitBySession<T extends Targeted>(list: readonly T[], sessionId: string): { kept: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const row of list) (sessionId && row.sessionId === sessionId ? removed : kept).push(row);
  return { kept, removed };
}

/** How many of each a close would delete. */
export interface TriggerCount {
  schedules: number;
  webhooks: number;
}

/**
 * Counts EVERY row, paused ones included: a paused schedule is deleted by the
 * close just the same, so a confirmation that counted only the enabled ones
 * would under-announce an irreversible act.
 */
export function triggerCount(
  sessionId: string,
  crons: readonly Targeted[],
  webhooks: readonly Targeted[],
): TriggerCount {
  return {
    schedules: splitBySession(crons, sessionId).removed.length,
    webhooks: splitBySession(webhooks, sessionId).removed.length,
  };
}

/** "2 schedules and 1 webhook" — or "" when there is nothing to name. */
export function triggerSummary(n: TriggerCount): string {
  const part = (count: number, noun: string) => (count ? `${count} ${noun}${count === 1 ? "" : "s"}` : "");
  return [part(n.schedules, "schedule"), part(n.webhooks, "webhook")].filter(Boolean).join(" and ");
}
