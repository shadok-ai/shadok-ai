/**
 * Detection of transient API errors on the TUI screen, used by the server
 * to auto-retry a turn that died on one (529 Overloaded, 5xx, timeout…).
 * Pure functions, kept separate from server.ts so they can be tested.
 */

/** Auto-retry backoff: first, second and third attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000];

/**
 * A line worth retrying: "API Error" followed (same line) by a transient
 * cause — 5xx/429 status, overload, timeout or connection failure. Client
 * errors (400/401/403, invalid_request…) intentionally do not match.
 */
const TRANSIENT_ERROR =
  /API Error\b[^\n]*?(?:\b(?:5\d\d|429)\b|overloaded|timed? ?out|connection|ECONNRESET|ETIMEDOUT|fetch failed)/i;

/** The screen lines (trimmed) showing a transient API error. */
export function findTransientErrors(screen: string): string[] {
  return screen
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => TRANSIENT_ERROR.test(l));
}

/**
 * Multiset difference: the lines of `after` in excess of `before`. Used to
 * ignore an old error still visible on screen from a previous turn — only
 * a NEW occurrence triggers a retry.
 */
export function newTransientErrors(before: string[], after: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of before) counts.set(l, (counts.get(l) ?? 0) + 1);
  const fresh: string[] = [];
  for (const l of after) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else fresh.push(l);
  }
  return fresh;
}
