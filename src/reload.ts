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
  /** Delay between attempts (ms). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function deliverWithRetry(
  deliver: () => Promise<DeliverResult>,
  alive: () => boolean,
  { attempts = 6, delayMs = 3_000, sleep = realSleep }: RetryOptions = {},
): Promise<DeliverResult & { attempts: number; gone?: true }> {
  let last: DeliverResult = { ok: false, reason: "not attempted" };
  for (let i = 0; i < attempts; i++) {
    // A session that ended (the user closed it, it crashed) is not idle waiting
    // for a nudge — stop, don't keep knocking.
    if (!alive()) return { ok: false, reason: "gone", gone: true, attempts: i };
    last = await deliver();
    if (last.ok) return { ok: true, attempts: i + 1 };
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { ok: false, reason: last.reason, attempts };
}
