/**
 * What a reconnecting Telegram bridge missed, and what it is allowed to post.
 *
 * The two halves of the mirror did not have the same safety net, and the gap
 * between them is what a live instance reported: the agent's answers kept
 * landing in the topic while the operator's own web messages silently never
 * did, intermittently, for about ten minutes.
 *
 * The asymmetry is structural, not a flap.
 *
 *  - The agent's text lives in the transcript, and the tail persists its byte
 *    offset (`writePos`, invariant 7), so a gap is re-read and re-broadcast.
 *  - A `prompt-echo` is ONE live frame, broadcast at submit time. It is derived
 *    from nothing on disk, so if no bridge is attached at that instant it is
 *    gone — with no trace anywhere, since `broadcast` writes to a client set
 *    and a set that lacks the bridge looks exactly like one that has it.
 *
 * And a reattaching bridge deliberately replays NOTHING (`backfill` is set only
 * for a freshly created topic, "never on a reconnect/reboot") — which is right
 * against re-spamming the whole history on every auto-update, and is why the
 * one thing that could have recovered the frame did not.
 *
 * So the bridge gets the tail's cure, in the tail's shape: a resume point per
 * binding, and a reconnect that posts the gap and only the gap.
 *
 * Pure so the rule is unit-testable; the store is in `src/channels.ts` (beside
 * the other per-launch-dir Telegram state) and the wiring in `src/telegram.ts`.
 */

/** At most this many missed messages are posted on a reconnect. A gap can be a
 *  weekend long, and a topic that answers a reattach with two hundred messages
 *  is not a recovery, it is a second incident. What is older is COUNTED, so the
 *  line that says it is replaying also says what it gave up on. */
export const REPLAY_CAP = 20;

/** The resume point of one binding: what it has already delivered. */
export interface DeliveredMark {
  /**
   * How far this binding has delivered, in the transcript's clock where the
   * delivered item carried one (`HistoryTurn.at` / `TailEvent.at` — the same
   * source, so a replayed turn and a live one compare), and in the delivery
   * clock otherwise.
   */
  at: number;
  /**
   * The text of the last delivered item when it was a PROMPT ECHO. An echo is
   * marked with the instant we posted it, and Claude Code stamps that same
   * prompt into the transcript a moment LATER — so the one item we know landed
   * can still sit after the mark. Keeping its text is what lets the replay
   * recognise it instead of posting the operator's own sentence twice.
   */
  text?: string;
}

/** The shape `replayPlan` needs from a `history` turn — a subset of
 *  `HistoryTurn`, so the pure rule does not drag the transcript parser in. */
export interface ReplayTurn {
  role: string;
  text: string;
  at?: number;
  origin?: string;
  from?: string;
}

export interface ReplayPlan {
  /** To post, oldest first. */
  post: ReplayTurn[];
  /** In the gap, but older than the cap — counted, never posted. */
  dropped: number;
}

/**
 * Only these two are replayed. `bash` and `social-draft` are web-side cards
 * with no Telegram rendering at all — but a `file` turn is a STATED limit, not
 * an omission: a file delivered during the gap is not re-uploaded. Replaying it
 * means reading bytes off disk with the agent's rights, long after the fact, for
 * a path that may be gone; the text around it comes back and says there was one.
 */
const MIRRORED_ROLES = new Set(["user", "assistant"]);

/**
 * The messages a reattaching bridge should post, given what it had already
 * delivered.
 *
 * Three refusals carry the design:
 *
 *  - **No mark at all replays nothing.** A binding we have never delivered
 *    through is a NEW mirror, not one with an unbounded backlog — the same rule
 *    as the ledger's watermark, where no record means a fresh agent anchored to
 *    now rather than the whole table replayed into it.
 *  - **A turn with no `at` is never posted.** An older transcript has no
 *    timestamp, so the turn cannot be placed against the mark; posting it would
 *    re-spam history on every reconnect, which is the exact thing `backfill`
 *    exists to prevent.
 *  - **The mark's own echo at the head is dropped.** Same trade-off as
 *    `isStalePreface`: a duplicate in a topic is permanent, nothing ever comes
 *    to edit it away, while dropping this one costs at most the sentence the
 *    operator just typed and can still see in front of them.
 */
export function replayPlan(
  turns: readonly ReplayTurn[],
  mark: DeliveredMark | null | undefined,
  cap: number = REPLAY_CAP,
): ReplayPlan {
  if (!mark) return { post: [], dropped: 0 };
  const after = turns.filter(
    (t) =>
      MIRRORED_ROLES.has(t.role) && typeof t.at === "number" && t.at > mark.at && typeof t.text === "string" && !!t.text.trim(),
  );
  // Only at the HEAD: the same sentence sent again later is a real message and
  // must survive. Dropping every match would make a repeated prompt vanish.
  const head = after[0];
  const body =
    head && head.role === "user" && mark.text && head.text.trim() === mark.text.trim() ? after.slice(1) : after;
  const post = cap >= 0 ? body.slice(body.length - Math.min(cap, body.length)) : body;
  return { post, dropped: body.length - post.length };
}

/**
 * Move a binding's resume point forward — and only ever forward.
 *
 * The two clocks that feed it are different sources (a transcript timestamp and
 * our own delivery instant), so a later delivery can legitimately carry an
 * EARLIER number. Taking it would reopen a gap that is closed, and the next
 * reconnect would post into the topic again.
 */
export function advanceMark(prev: DeliveredMark | null | undefined, next: DeliveredMark): DeliveredMark {
  return { at: Math.max(prev?.at ?? 0, next.at), ...(next.text ? { text: next.text } : {}) };
}

/** The line that opens a replay, so nobody mistakes the gap for live traffic. */
export function replayHeader(posted: number, dropped: number): string {
  const what = `${posted} message${posted === 1 ? "" : "s"}`;
  const older = dropped ? ` (+${dropped} older not shown)` : "";
  return `— ${what} missed while this topic was disconnected${older} —`;
}
