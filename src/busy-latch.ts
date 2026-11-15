/**
 * When the server's "a turn is running" flag no longer has a turn behind it.
 *
 * `Live.busy` is a BELIEF, not an observation: it is raised when a prompt is
 * accepted and lowered in `finishTurn`'s `finally`. Every door into an agent
 * reads it first — a second prompt is refused `busy`, a cron slot is skipped,
 * the auto-reload stands down, a parent's notification is queued. So the flag
 * latching ON is not one lost message: it is an agent nobody can reach again,
 * for as long as the process lives.
 *
 * And it is invisible. The pane sits at an empty prompt, the transcript is
 * silent, `/live` reports `busy: true`, and nothing is logged — the shape of
 * every other silent-loss bug in this codebase (invariants 7 and 23).
 *
 * Measured on a live instance: a message arrived while that agent's TUI had
 * stopped taking input, the submit recovery respawned it and delivered the
 * message (`src/submit-recovery.ts`), the answer came back — and the flag
 * stayed up afterwards. Forty minutes later the turn stopwatch still read from
 * that message, every later one was refused, and the one thing that cleared it
 * was a human clicking "Reload agent".
 *
 * The TELEGRAM side made it look like a dead end rather than a bug. A `busy`
 * refusal there is answered with an Escape and a wait for `turn-done`
 * (`shouldPreempt`), so the sender is told "couldn't take the hand back — try
 * /stop, then send it again". But `/stop` is that same Escape, and an Escape
 * interrupts a turn; it cannot lower a flag no turn is holding. Every retry
 * therefore reproduced the message word for word, which is what someone
 * reports — not "an agent is wedged".
 *
 * So: rather than hunt every path that could leave the flag up (the one that
 * did has not been pinned, and the next will be somewhere else), make the flag
 * UNABLE to latch. `busy` is legitimately held by exactly four things, each of
 * which the server knows about — a `finishTurn` waiting for the turn to end, a
 * prompt being typed, a failed submit being recovered, a process being swapped.
 * When none of them holds it and the pane shows no work either, the flag is
 * stale by construction, whatever raised it.
 *
 * The grace window is what keeps that honest: the four facts are read off a
 * 300 ms timer, so a verdict taken on one poll would race the microsecond gaps
 * between them. Requiring the same answer for a continuous stretch means a
 * release only ever follows a state that has been true long enough to be real.
 *
 * Pure, with the facts handed in — tested without a server or a TUI, like
 * `submitRecoveryVerdict`.
 */

/** How long `busy` must be held by nobody before it is taken back. Long
 *  enough that no ordinary gap between two of the four holders can reach it,
 *  short enough that the person who just wrote is still waiting. */
export const BUSY_LATCH_GRACE_MS = 15_000;

export interface BusyLatchInput {
  /** The server believes a turn is running on this agent. */
  busy: boolean;
  /** A `finishTurn` is awaiting the end of that turn — the normal holder. */
  turnInFlight: boolean;
  /** A prompt is being typed into the TUI right now (`submitGuarded`). */
  submitting: boolean;
  /** A failed submit is being recovered: respawn + re-delivery. */
  recovering: boolean;
  /** The agent's process is being swapped (a restart/reload). */
  restarting: boolean;
  /** The pane shows a turn running. Last resort, and deliberately not the
   *  only term: `screenShowsWork` is the fragile heuristic of invariant 2, so
   *  it may only ever KEEP the flag up, never bring it down on its own. */
  working: boolean;
  /** When this state was first seen (ms epoch), or null if the previous poll
   *  did not see it. */
  since: number | null;
  now: number;
  graceMs: number;
}

export type BusyLatchVerdict =
  /** Someone is legitimately holding it: forget any window in progress. */
  | { action: "none" }
  /** Nobody is holding it, but not for long enough yet. */
  | { action: "watch"; since: number }
  /** Stale: hand the agent back. */
  | { action: "clear" };

export function busyLatchVerdict(i: BusyLatchInput): BusyLatchVerdict {
  if (!i.busy) return { action: "none" };
  if (i.turnInFlight || i.submitting || i.recovering || i.restarting) return { action: "none" };
  if (i.working) return { action: "none" };
  // First poll of a new window: the clock starts now, never at an earlier
  // instant we did not observe.
  const since = i.since ?? i.now;
  return i.now - since >= i.graceMs ? { action: "clear" } : { action: "watch", since };
}

/** The log line a release writes. Loud on purpose: a flag that had to be taken
 *  back is a bug upstream of here, and the only trace it leaves is this. */
export function busyLatchLog(id: string, heldMs: number): string {
  return `[sk-${id}] busy was held with no turn behind it for ${Math.round(heldMs / 1000)}s — taking it back (the agent was unreachable)`;
}
