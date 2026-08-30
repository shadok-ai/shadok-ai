/**
 * Retry a delivery until it lands (or the target is gone).
 *
 * The reload continue-nudge (server.ts `continueAfterReload`) is delivered the
 * moment `restartSession` resolves. But a `--resume` can still be finishing its
 * own resume turn (the session reads BUSY), or the freshly respawned TUI is not
 * yet accepting a paste — and a SINGLE refused delivery left the agent idle
 * forever, with nothing to try again. That was the bug: an agent reloaded fine,
 * then nothing happened.
 *
 * So the delivery retries, backing off, until it succeeds or the session no
 * longer exists. Kept here — pure, with `deliver` / `alive` / `sleep` injected —
 * so the retry policy is unit-tested without a server or a real TUI.
 */

export interface DeliverResult {
  ok: boolean;
  reason?: string;
}

export interface RetryOptions {
  /** Total attempts before giving up. */
  attempts?: number;
  /** Which refusals may be replayed. Defaults to the cron's own rule. */
  retryable?: (reason: string | undefined) => boolean;
  /** Delay between attempts (ms). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Replayable refusals — the same set `settleCron` uses, for the same reason:
 *  they delivered nothing, so sending again cannot duplicate anything. */
const isTransient = (reason: string | undefined): boolean =>
  reason === "busy" || reason === "pace-blocked" || reason === "ws-error" || reason === "exited";

export async function deliverWithRetry(
  deliver: () => Promise<DeliverResult>,
  alive: () => boolean,
  { attempts = 6, delayMs = 3_000, sleep = realSleep, retryable = isTransient }: RetryOptions = {},
): Promise<DeliverResult & { attempts: number; gone?: true }> {
  let last: DeliverResult = { ok: false, reason: "not attempted" };
  for (let i = 0; i < attempts; i++) {
    // A session that ended (the user closed it, it crashed) is not idle waiting
    // for a nudge — stop, don't keep knocking.
    if (!alive()) return { ok: false, reason: "gone", gone: true, attempts: i };
    last = await deliver();
    if (last.ok) return { ok: true, attempts: i + 1 };
    // NOT every refusal may be replayed, and this is the same rule the cron
    // retry already follows (invariant 15). A `timeout` does not mean the
    // delivery failed — it means the turn it started is STILL RUNNING, so
    // sending again stacks a second prompt on the first. `busy` / `pace-blocked`
    // / `ws-error` / `exited` are the ones that genuinely delivered nothing.
    if (!retryable(last.reason)) return { ...last, attempts: i + 1 };
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { ok: false, reason: last.reason, attempts };
}
