import type { WebSocket } from "ws";

/**
 * The subset of a `Live` that a handover reads and mutates. Kept structural so
 * the server's full `Live` satisfies it with no cast, and a test can build a
 * fake. It DELIBERATELY omits `pilot`, `cwd`, `id` and `transcriptHome`: the
 * handover must never be able to kill the agent or clear the shared tail
 * position, and leaving those fields out of the type makes that a compile-time
 * guarantee rather than a comment someone can regress past.
 */
export interface HandoverLive {
  clients: Set<WebSocket>;
  rawClients?: Set<WebSocket>;
  screenTimer: ReturnType<typeof setInterval> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  stopTail: (() => void) | null;
  rawOff?: (() => void) | null;
}

/**
 * Hand a superseded `Live`'s viewers onto the `Live` that replaced it, and quiet
 * the old one WITHOUT touching the agent. Returns how many viewers moved.
 *
 * The bug (shared-ledger [5d8d]): when a session's pilot has exited but the
 * channel still has web/Telegram viewers attached, a resume takes the
 * `createSession` path and `sessions.set(id, newLive)` REPLACES the registry
 * entry — leaving the old `Live`, with its clients, orphaned. Its tail keeps
 * running on the same transcript, so those clients still see the agent's
 * ANSWERS, but every `broadcast` now targets the new `Live`: they miss the other
 * interfaces' prompt echoes (the reported symptom: Telegram messages invisible
 * on the web until reload), dialogs, and working/turn-done. Two `Live` for one
 * agent; "server code correct in isolation", the split is the cause.
 *
 * The cure is one `Live` per agent: hand the viewers over and tear the old one
 * down. Teardown here is DELIBERATELY not `destroySession`. The new `Live` may
 * have adopted the very same tmux pane — a `hasExited` that latched on a single
 * transient probe (invariants 23/25) leaves the pane alive — so killing the old
 * pilot would kill the live agent, and clearing the shared tail position would
 * make the new tail replay the whole transcript from byte 0. So we stop the old
 * `Live`'s own tail and timers and detach its raw pipe, and nothing else. (The
 * type can't express `pilot.kill()` or `clearTailPos` anyway — see `HandoverLive`.)
 *
 * Raw terminal viewers are NOT re-wired onto the new pilot's pipe: the raw
 * subscription is per-pilot and is rebuilt when the engine room is next opened.
 * Moving the chat `clients` set is what the reported bug needs; the old raw pipe
 * is simply turned off so the retired `Live` goes fully quiet.
 */
export function supersedeSession(old: HandoverLive, next: HandoverLive): number {
  let moved = 0;
  for (const c of old.clients) {
    next.clients.add(c);
    moved++;
  }
  old.clients.clear();

  // Quiet the retired Live: its own tail (so one transcript is not tailed
  // twice — the "two tails share one pos file" side effect noted in [5d8d]),
  // its timers, and its raw pipe. Never the pilot, never the tail position.
  if (old.screenTimer) {
    clearInterval(old.screenTimer);
    old.screenTimer = null;
  }
  if (old.idleTimer) {
    clearTimeout(old.idleTimer);
    old.idleTimer = null;
  }
  if (old.retryTimer) {
    clearTimeout(old.retryTimer);
    old.retryTimer = null;
  }
  old.stopTail?.();
  old.stopTail = null;
  old.rawOff?.();
  old.rawOff = null;
  old.rawClients?.clear();

  return moved;
}
