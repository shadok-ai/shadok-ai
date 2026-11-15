/**
 * Submit recovery: what to do when an agent's TUI stops taking input.
 *
 * The failure this answers is one we cannot prevent. A `claude` process stays
 * alive and healthy — pane up, no dialog, a transcript that ends on a clean
 * turn — while its TUI no longer consumes its terminal input. Nothing typed
 * reaches it, not even the Ctrl-U / Ctrl-C clears `typeIntoBox` falls back on,
 * so every later prompt fails with the pilot's own "the text never appeared in
 * the input box". It is an upstream bug class with no workaround; the only
 * thing that ends it is a new process.
 *
 * Before this module the cockpit reported that failure and did nothing else:
 * one log line, an error the sender could not act on ("send that again", which
 * could never work), no word to whoever operates the instance. An agent stayed
 * deaf for hours until a human happened to look and clicked "Reload agent" —
 * which fixed it at once. So the server now does that click itself, once, and
 * re-delivers the prompt that failed; and when even that does not work it stops
 * pretending and escalates.
 *
 * **Why the decision lives on the submit failure, and nowhere else.** From the
 * outside a wedged agent is indistinguishable from an idle one: same still
 * screen, same silent transcript. A periodic watchdog would have to guess, and
 * a wrong guess respawns a healthy agent. A prompt that provably did not go in
 * is the one reliable signal — so the recovery is reactive, and an agent nobody
 * writes to is never touched.
 *
 * A respawn is a `--resume`: the conversation survives, the PROCESS does not
 * (`src/auto-reload.ts` lists what dies with it). Every "no" below names a case
 * where that loss is not worth paying, or where a new process cannot help.
 *
 * Pure, with the facts handed in — tested without a server or a real TUI, like
 * `autoReloadVerdict`.
 */
import type { StuckKind, SubmitFailure } from "./detect.js";

/** One automatic respawn per agent per window. A wedge that comes back inside
 *  it is not the transient kind a respawn cures, and respawning again would be
 *  a loop that eats the agent's background work each time round. */
export const RECOVERY_COOLDOWN_MS = 10 * 60_000;

export interface SubmitRecoveryInput {
  /** Is the feature on for this instance? */
  enabled: boolean;
  /** Which half of `submit` gave up, or null when the error was something else
   *  entirely (the process exited mid-wait, a bug) — never ours to recover. */
  failure: SubmitFailure | null;
  /** The recognisable blocking state on screen, if any. */
  stuck: StuckKind | null;
  /** The pilot's process has exited: the resume path owns that, not this. */
  exited: boolean;
  /** The pane shows a turn running. */
  working: boolean;
  /** A question / permission dialog is on screen. */
  dialogOpen: boolean;
  /** A restart is already swapping this agent's process. */
  restarting: boolean;
  /** The transcript recorded a prompt AFTER this submit began: it went in after
   *  all, whatever the screen said. */
  promptLanded: boolean;
  /** Milliseconds since the last automatic recovery of this agent (Infinity if never). */
  sinceLastRecoveryMs: number;
  cooldownMs: number;
}

export type SubmitRecoveryVerdict =
  /** Not this class of failure: report the error as before, touch nothing. */
  | { action: "none"; why: string }
  /** Respawn the agent, then deliver the prompt again — once. */
  | { action: "restart" }
  /** The agent cannot take input and a respawn is not the answer (or was just
   *  tried): say so truthfully and alert whoever operates the instance. */
  | { action: "escalate"; why: string };

export function submitRecoveryVerdict(i: SubmitRecoveryInput): SubmitRecoveryVerdict {
  const none = (why: string): SubmitRecoveryVerdict => ({ action: "none", why });
  if (!i.enabled) return none("disabled");
  if (!i.failure) return none("not a submit failure");
  if (i.exited) return none("process exited");
  if (i.restarting) return none("already restarting");
  // The one case where acting would DUPLICATE the message: the screen read as
  // "not sent", the transcript says it was. Believe the transcript — it is the
  // source of truth for content everywhere else too.
  if (i.promptLanded) return none("the prompt landed");
  // A turn is running: the input is not dead, it is busy, and a respawn would
  // cut real work. Checked before anything that could say "restart".
  if (i.working) return none("a turn is running");
  // A question on screen is a state the PERSON resolves, and a respawn would
  // throw the question away. The submit error already tells them to answer it.
  if (i.dialogOpen || i.stuck === "question") return none("waiting on a question");
  // The first-run screen and a masked field are a sign-in / onboarding state:
  // a new process lands on the very same screen. Only a human can fix that, so
  // skip the pointless respawn and go straight to telling one.
  if (i.stuck === "first-run" || i.stuck === "masked")
    return { action: "escalate", why: "the agent is not signed in or not onboarded — a restart lands on the same screen" };
  if (i.sinceLastRecoveryMs < i.cooldownMs)
    return { action: "escalate", why: "it was already restarted automatically a moment ago and stopped taking input again" };
  return { action: "restart" };
}

/** `SHADOK_SUBMIT_RECOVERY=0` turns it off; anything else (or unset) leaves it on. */
export function submitRecoveryEnabled(env: string | undefined): boolean {
  return env === undefined || !/^(0|false|off|no)$/i.test(env.trim());
}

/** The `code` on the `error` frame, so a client classifies it without matching
 *  on the sentence (as `busy` / `logged-out` already do). */
export const UNRESPONSIVE_CODE = "unresponsive";

/**
 * What the SENDER is told when the agent could not be brought back.
 *
 * Every clause is something we know: the message did not go in, sending it
 * again will hit the same wall, and an admin has been alerted (the report is
 * filed before this is sent). It does not say a restart was tried: on the
 * cooldown and sign-in branches none was. The line it replaces asked for a retry
 * that could not work.
 */
export const UNRESPONSIVE_MESSAGE =
  'This agent has stopped accepting input and could not be recovered automatically. Your message was NOT delivered, and sending it again will not help until the agent is repaired. The admins have been alerted — "Reload agent" is the manual fix.';

/** An error that carries its `code` to the `error` frame. */
export class UnresponsiveError extends Error {
  readonly code = UNRESPONSIVE_CODE;
  constructor() {
    super(UNRESPONSIVE_MESSAGE);
    this.name = "UnresponsiveError";
  }
}

/** The title of the operator report. CONSTANT on purpose: `fileReport` merges an
 *  open report from the same agent with the same title, so a wedge that keeps
 *  refusing prompts bumps one row (and re-notifies at most hourly) instead of
 *  filing one per message. */
export const UNRESPONSIVE_REPORT_TITLE = "Agent stopped accepting input — automatic recovery failed";

/** The report's body: what was tried and why it stopped, never the screen —
 *  a screen can hold whatever the conversation was about. */
export function unresponsiveReportBody(why: string, restarted: boolean): string {
  return [
    "A prompt could not be typed into this agent: its terminal no longer takes input, while the process itself is still running.",
    restarted
      ? `The server restarted it automatically and delivered the prompt again; that failed too (${why}).`
      : `No automatic restart was attempted: ${why}.`,
    "The sender was told their message was not delivered.",
    'Try "Reload agent". If the agent still refuses input, look at its screen in the engine room — the server log holds the screen captured at each failure.',
  ].join("\n");
}

/** What `submitWithRecovery` needs from the server — injected, so the ORDER of
 *  operations (the part that is easy to get wrong) is tested without a TUI. */
export interface RecoveryDeps {
  /** Type the prompt and send it. Called at most twice. */
  submit(): Promise<void>;
  /** Read the facts after a failed submit and decide. */
  assess(error: unknown): SubmitRecoveryVerdict;
  /** Respawn the agent through the enforced restart. Called at most once. */
  restart(): Promise<void>;
  /** File the operator report. Must not throw. */
  escalate(why: string, restarted: boolean): void;
  log?(line: string): void;
}

/**
 * Submit a prompt; on a failure of the "terminal stopped taking input" class,
 * restart the agent and submit it again — ONCE.
 *
 * - not this class → the original error, rethrown untouched;
 * - recovered → resolves, and the caller carries on as if nothing happened;
 * - not recoverable → `escalate`, THEN `UnresponsiveError`. In that order: the
 *   error's message tells the sender the admins have been alerted.
 *
 * There is no loop here on purpose. The second failure is not assessed again:
 * whatever it is, the one restart this prompt was allowed has been spent.
 */
export async function submitWithRecovery(d: RecoveryDeps): Promise<void> {
  const log = d.log ?? (() => {});
  let first: unknown;
  try {
    return await d.submit();
  } catch (e) {
    first = e;
  }
  const verdict = d.assess(first);
  if (verdict.action === "none") {
    log(`left alone — ${verdict.why}`);
    throw first;
  }
  if (verdict.action === "escalate") {
    log(`not restarted — ${verdict.why}`);
    d.escalate(verdict.why, false);
    throw new UnresponsiveError();
  }
  log("stopped taking input — restarting it and delivering the prompt again");
  let why: string;
  try {
    await d.restart();
    await d.submit();
    log("recovered — the prompt went in after the restart");
    return;
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  log(`still refuses input after the restart — ${why}`);
  d.escalate(why, true);
  throw new UnresponsiveError();
}
