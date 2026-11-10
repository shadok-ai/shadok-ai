import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Usage of a rolling rate-limit window, as returned by Claude Code's own
 * `/usage` (endpoint GET /api/oauth/usage — a plain GET, it spends no quota).
 */
export interface Window {
  /** 0–100. */
  usedPercentage: number;
  /** Unix epoch seconds when the window resets, or null. */
  resetsAt: number | null;
}

export interface Usage {
  fiveHour: Window | null;
  sevenDay: Window | null;
  /** When this snapshot was fetched (ms since epoch). */
  fetchedAt: number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * Reads the Claude Code OAuth access token the same way the CLI does.
 *
 * Order matters: the LIVE stores (credentials file, then the macOS keychain)
 * come FIRST because the CLI keeps them refreshed, so usage self-heals. The env
 * var is the LAST resort — only for CI/headless where there's no live store.
 * (This is deliberate: a stale `CLAUDE_CODE_OAUTH_TOKEN` pinned into a long-
 * running server's env used to shadow the fresh keychain token, silently
 * emptying the usage gauges. Live-first prevents that.)
 * Returns null if none is found (usage simply won't be shown).
 */
export function readOAuthToken(): string | null {
  // Credentials file (Linux, and some macOS setups).
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const tok = j?.claudeAiOauth?.accessToken ?? j?.accessToken;
    if (typeof tok === "string" && tok) return tok;
  } catch {
    // fall through to keychain
  }

  // macOS keychain (default on macOS): the CLI stores the token under the
  // "Claude Code-credentials" generic-password service.
  if (process.platform === "darwin") {
    for (const account of [process.env.USER ?? "", ""]) {
      try {
        const out = execFileSync(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", ...(account ? ["-a", account] : []), "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        if (!out) continue;
        // The stored blob is JSON; pull the access token out of it.
        try {
          const j = JSON.parse(out);
          const tok = j?.claudeAiOauth?.accessToken ?? j?.accessToken;
          if (typeof tok === "string" && tok) return tok;
        } catch {
          if (out.startsWith("ey") || out.length > 40) return out; // raw token
        }
      } catch {
        // try next account form
      }
    }
  }

  // Last resort: an explicit env token (CI / headless, no live store).
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) return env;

  return null;
}

export function parseWindow(w: any): Window | null {
  if (!w) return null;
  // The endpoint returns `utilization` (0–100); older/statusline shapes use
  // `used_percentage`. `resets_at` is an ISO string here (epoch seconds
  // elsewhere).
  const pct =
    typeof w.utilization === "number"
      ? w.utilization
      : typeof w.used_percentage === "number"
        ? w.used_percentage
        : null;
  if (pct === null) return null;
  let resetsAt: number | null = null;
  if (typeof w.resets_at === "number") resetsAt = w.resets_at;
  else if (typeof w.resets_at === "string") {
    const t = Date.parse(w.resets_at);
    if (!Number.isNaN(t)) resetsAt = Math.floor(t / 1000);
  }
  return { usedPercentage: pct, resetsAt };
}

let cache: Usage | null = null;
let inflight: Promise<Usage | null> | null = null;
const TTL_MS = 60_000;

/** Drop the cached snapshot, so the next read goes to the network. Used when the
 *  token the gauge reads with just changed (a fresh gauge login), so the number
 *  on screen follows at once instead of lingering up to TTL_MS. */
export function resetUsageCache(): void {
  cache = null;
}

/** One usage fetch with a given Bearer. `null` on a failed request (non-2xx or a
 *  thrown fetch) — kept DISTINCT from a 200 whose windows are simply empty, so
 *  the caller can tell "this token errored" from "this token reports nothing". */
async function fetchUsage(token: string): Promise<Usage | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "shadok-ai",
      },
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    // The endpoint may nest the windows under rate_limits or expose them at the
    // top level depending on version — handle both.
    const src = j?.rate_limits ?? j ?? {};
    return {
      fiveHour: parseWindow(src.five_hour),
      sevenDay: parseWindow(src.seven_day),
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/** A snapshot is USEFUL only if it carries at least one window. A 200 with both
 *  windows null is a token the usage endpoint reports nothing for — a long-lived
 *  `setup-token` is exactly that: it authenticates and runs agents, but is not
 *  scoped for `/api/oauth/usage`. That is precisely when the next candidate must
 *  be tried. */
export function hasWindow(u: Usage | null): u is Usage {
  return !!u && (u.fiveHour !== null || u.sevenDay !== null);
}

/**
 * Pick a usage snapshot across candidate Bearers tried in PREFERENCE order: the
 * first that reports a window wins; failing that a 200-but-empty result (a real
 * answer, kept over a stale cache); failing that the last good snapshot.
 *
 * Pure over `fetchOne`, so the selection is tested without the module cache or
 * the network. This is the regression fix: preferring the vault long-lived token
 * (so the gauge follows the account the AGENTS run on) must NOT blank the gauge
 * when that token is a `setup-token` reporting nothing — the live store / env is
 * the next candidate and keeps a number on screen.
 */
export async function pickUsage(
  tokens: readonly string[],
  fetchOne: (token: string) => Promise<Usage | null>,
  lastGood: Usage | null,
): Promise<Usage | null> {
  let empty: Usage | null = null;
  for (const token of tokens) {
    const u = await fetchOne(token);
    if (hasWindow(u)) return u;
    if (u) empty = u; // 200 with no windows — remember, but keep trying
  }
  return empty ?? lastGood;
}

/**
 * Fetches the current 5-hour and 7-day usage. Cached for 60s and de-duplicated
 * across concurrent callers, so polling is cheap.
 *
 * `readTokens` yields the candidate Bearers in preference order; `pickUsage`
 * takes the first that actually reports a window. A multi-tenant instance puts
 * its long-lived vault token first and the live CLI store / env second, so the
 * gauge follows the agents' account when that token CAN report usage and falls
 * back instead of going dark when it cannot. Returns null only when no candidate
 * token exists at all. `readTokens` is injectable for tests; production callers
 * pass the server's resolver.
 */
export async function getUsage(
  readTokens: () => Array<string | null> = () => [readOAuthToken()],
): Promise<Usage | null> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  // Candidates are resolved BEFORE the promise exists, so a token-less call
  // creates no in-flight entry at all. Reading them inside the async IIFE (an
  // earlier "fix") re-created the very latch it meant to remove: with no `await`
  // on that path the IIFE settled synchronously, its `finally { inflight = null }`
  // ran first, and only THEN did `inflight = (...)()` store the resolved promise
  // — pinning every later call to it for the life of the process. Deduped and
  // trimmed; a blank is never sent as a Bearer.
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of readTokens()) {
    const s = t?.trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      tokens.push(s);
    }
  }
  if (tokens.length === 0) return null;
  const run = (async (): Promise<Usage | null> => {
    const chosen = await pickUsage(tokens, fetchUsage, cache);
    if (chosen) cache = chosen; // a fresh window/empty refreshes it; lastGood is a no-op
    return chosen;
  })();
  inflight = run;
  // Cleared from OUTSIDE, after the assignment: `.finally` always runs on a
  // later microtask, so even a body that settles synchronously can no longer
  // clear the guard before it is set. The identity check keeps it from
  // clearing a newer in-flight request.
  void run.finally(() => {
    if (inflight === run) inflight = null;
  });
  return run;
}
