/**
 * Failed sign-in attempts, counted per address AND per account, in memory.
 *
 * `POST /login` used to accept guesses as fast as they came: with a password
 * set, the password is the door to a shell on the host, and nothing slowed a
 * guesser down. Two buckets, because each alone fails: per address alone lets
 * a guesser rotating addresses hammer one account; per account alone lets one
 * guesser lock every named user out. The account bucket is therefore the larger
 * one — it caps a distributed attack without making a lockout of someone else
 * cheap.
 *
 * A blocked attempt is refused BEFORE the hash is computed: a flood costs the
 * server nothing past the limit. Memory is bounded (`maxKeys`) because the
 * account key is whatever name the guesser typed. A restart forgets everything,
 * deliberately — a limiter that could lock the owner out across restarts would
 * be worse than one a restart resets. Pure over an injected clock — tested.
 */

export type LimitConfig = {
  windowMs: number;
  maxPerIp: number;
  maxPerAccount: number;
  maxKeys?: number;
};

export const LOGIN_LIMITS: LimitConfig = {
  windowMs: 15 * 60_000,
  maxPerIp: 10,
  maxPerAccount: 20,
  maxKeys: 10_000,
};

export type LimitVerdict = { ok: true } | { ok: false; retryAfterMs: number };

/** The buckets one attempt is charged to. A blank user IS the admin. */
export function loginKeys(address: string, user: string): string[] {
  return [`ip:${address}`, `acct:${user || "admin"}`];
}

export class AttemptLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private cfg: LimitConfig,
    private now: () => number = Date.now,
  ) {}

  private live(key: string): number[] {
    const cut = this.now() - this.cfg.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cut);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  private max(key: string): number {
    return key.startsWith("ip:") ? this.cfg.maxPerIp : this.cfg.maxPerAccount;
  }

  check(keys: string[]): LimitVerdict {
    let wait = 0;
    for (const k of keys) {
      const f = this.live(k);
      const max = this.max(k);
      if (f.length >= max) wait = Math.max(wait, f[f.length - max] + this.cfg.windowMs - this.now());
    }
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  fail(keys: string[]): void {
    const t = this.now();
    for (const k of keys) {
      const f = this.live(k);
      f.push(t);
      // Re-inserted at the end, so Map order is "least recently failed first".
      this.failures.delete(k);
      this.failures.set(k, f.slice(-this.max(k)));
    }
    this.bound();
  }

  /** A correct password clears the ACCOUNT's failures (whoever caused them),
   *  never the address's: a guesser holding one valid account must not be able
   *  to reset their own address bucket between guesses at another. */
  succeed(keys: string[]): void {
    for (const k of keys) if (!k.startsWith("ip:")) this.failures.delete(k);
  }

  size(): number {
    return this.failures.size;
  }

  private bound(): void {
    const cap = this.cfg.maxKeys ?? Infinity;
    if (this.failures.size <= cap) return;
    for (const k of [...this.failures.keys()]) this.live(k);
    while (this.failures.size > cap) this.failures.delete(this.failures.keys().next().value as string);
  }
}
