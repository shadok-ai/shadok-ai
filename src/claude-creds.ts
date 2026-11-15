import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * When the Claude OAuth credentials expire — read from the SAME store the CLI
 * keeps refreshed, and never a token value, only the two timestamps.
 *
 * `accessExpiresAt` is the short-lived access token (hours; the CLI rotates it
 * on its own, so it is not a deadline a human acts on). `tokenExpiresAt` is the
 * REFRESH token's expiry — the real "this account must sign in again" moment,
 * which is what the cockpit surfaces beside the account login. An env-only
 * instance (CLAUDE_CODE_OAUTH_TOKEN) has neither: that token is not a JSON blob
 * and carries no expiry we can read, so we show none rather than guess.
 */
export interface TokenExpiry {
  /** Refresh-token expiry (ms epoch) — when a full re-login is needed, or null. */
  tokenExpiresAt: number | null;
  /** Access-token expiry (ms epoch) — short-lived, auto-refreshed, or null. */
  accessExpiresAt: number | null;
}

const NONE: TokenExpiry = { tokenExpiresAt: null, accessExpiresAt: null };

/** Pure: the expiry timestamps from a credentials JSON blob. Never a token. */
export function parseCredsExpiry(raw: string): TokenExpiry {
  try {
    const j = JSON.parse(raw);
    const o = (j && typeof j === "object" ? (j.claudeAiOauth ?? j) : {}) as Record<string, unknown>;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    return {
      tokenExpiresAt: num(o.refreshTokenExpiresAt),
      accessExpiresAt: num(o.expiresAt),
    };
  } catch {
    return NONE;
  }
}

/**
 * The expiry from the live store, read in the SAME order as usage.ts reads the
 * token: the credentials file first, then the macOS keychain. Swallows every
 * error and returns {null, null} when nothing is found — surfacing the expiry
 * must never be able to break the endpoint it feeds.
 */
export function readTokenExpiry(): TokenExpiry {
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const e = parseCredsExpiry(fs.readFileSync(file, "utf8"));
    if (e.tokenExpiresAt || e.accessExpiresAt) return e;
  } catch {
    // fall through to the keychain
  }

  if (process.platform === "darwin") {
    for (const account of [process.env.USER ?? "", ""]) {
      try {
        const out = execFileSync(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", ...(account ? ["-a", account] : []), "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        if (!out) continue;
        const e = parseCredsExpiry(out);
        if (e.tokenExpiresAt || e.accessExpiresAt) return e;
      } catch {
        // try the next account form
      }
    }
  }

  return NONE;
}
