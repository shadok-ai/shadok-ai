/**
 * Auto-reload: apply a pending "reload to apply" by itself, at a moment that
 * cuts nothing.
 *
 * The cockpit already KNOWS when a running agent is behind what a fresh spawn
 * would give it (`stalenessReasons`: prompt/guardrails/skills/secrets changed,
 * auth cookie past its week, Claude Code binary updated — plus a profile change
 * stored "at next reload"). Until now it only painted a ↻ badge and waited for a
 * human to click it, so a profile edit or a shadok update sat unapplied on every
 * agent nobody happened to look at.
 *
 * A reload is a `--resume`: the conversation survives, but the PROCESS does not.
 * Everything that lives only in that process dies with it — a turn in flight, a
 * question on screen, text typed in the TUI's input box, a background shell or
 * monitor, a parent notification waiting to be delivered. So the rule is not
 * "reload when idle" but "reload when there is provably nothing to lose", and
 * every condition below names one of those losses.
 *
 * The quiet window is the soft half: an agent that JUST finished is the one a
 * human is most likely about to answer. Waiting a couple of minutes past the
 * last activity keeps the reload out of a live exchange. (A prompt that arrives
 * anyway while the respawn runs is held until it is ready — see the prompt
 * handler — so the worst case is a few seconds of delay, never a lost message.)
 *
 * The backoff is the safety net: if the reasons survive a reload (a fingerprint
 * that is not deterministic, a version probe that flaps), reloading again every
 * two minutes would be a respawn loop. One automatic attempt per window, then
 * the badge stays for a human to look at.
 */

export interface AutoReloadInput {
  /** Is the feature on for this instance? */
  enabled: boolean;
  /** How many reasons the agent is behind (staleness + a stored profile gap). */
  pendingReasons: number;
  /** A turn is running, or the server is driving one (`busy`). */
  busy: boolean;
  /** The pane itself shows work (spinner) — covers a turn nobody started from here. */
  working: boolean;
  /** A prompt is being typed into the TUI right now. */
  submitting: boolean;
  /** A restart is already swapping this agent's process. */
  restarting: boolean;
  /** The pilot's process has exited (nothing to reload; the resume path owns it). */
  exited: boolean;
  /** A question/permission dialog is on screen, waiting for an answer. */
  dialogOpen: boolean;
  /** What the TUI input box holds — text a respawn would discard. */
  inputBox: string;
  /** Background shells / monitors the pane reports running. */
  shells: number;
  monitors: number;
  /** Child-agent notifications queued for this agent as a parent. */
  inboxPending: number;
  /** An auto-retry of a failed turn is scheduled. */
  retryPending: boolean;
  /** Milliseconds since the last thing that happened on this agent. */
  idleMs: number;
  /** How long it must have been quiet. */
  quietMs: number;
  /** Milliseconds since the last AUTOMATIC reload of this agent (Infinity if never). */
  sinceLastAutoMs: number;
  /** Minimum gap between two automatic reloads of the same agent. */
  backoffMs: number;
}

export type AutoReloadVerdict = { reload: true } | { reload: false; why: string };

/** Pure: may this agent be reloaded right now without cutting anything? */
export function autoReloadVerdict(i: AutoReloadInput): AutoReloadVerdict {
  const no = (why: string): AutoReloadVerdict => ({ reload: false, why });
  if (!i.enabled) return no("disabled");
  if (i.pendingReasons <= 0) return no("up to date");
  if (i.exited) return no("process exited");
  if (i.restarting) return no("already restarting");
  if (i.busy || i.working) return no("working");
  if (i.submitting) return no("a prompt is being typed");
  if (i.dialogOpen) return no("waiting on a question");
  if (i.inputBox.trim()) return no("text in the input box");
  if (i.shells > 0 || i.monitors > 0) return no("background task running");
  if (i.inboxPending > 0) return no("notifications queued");
  if (i.retryPending) return no("auto-retry scheduled");
  if (i.idleMs < i.quietMs) return no("recently active");
  if (i.sinceLastAutoMs < i.backoffMs) return no("auto-reloaded recently");
  return { reload: true };
}

/** `SHADOK_AUTO_RELOAD=0` turns it off; anything else (or unset) leaves it on. */
export function autoReloadEnabled(env: string | undefined): boolean {
  return env === undefined || !/^(0|false|off|no)$/i.test(env.trim());
}
