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
function readOAuthToken(): string | null {
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

/**
 * Fetches the current 5-hour and 7-day usage. Cached for 60s and
 * de-duplicated across concurrent callers, so polling is cheap.
 * Returns null if no token is available or the request fails.
 */
export async function getUsage(): Promise<Usage | null> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const token = readOAuthToken();
    if (!token) return null;
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "shadok-ai",
        },
      });
      if (!res.ok) return cache; // keep last good snapshot on transient errors
      const j: any = await res.json();
      // The endpoint may nest the windows under rate_limits or expose them
      // at the top level depending on version — handle both.
      const src = j?.rate_limits ?? j ?? {};
      const usage: Usage = {
        fiveHour: parseWindow(src.five_hour),
        sevenDay: parseWindow(src.seven_day),
        fetchedAt: Date.now(),
      };
      cache = usage;
      return usage;
    } catch {
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
