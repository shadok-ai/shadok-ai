// The Claude sign-in's re-login clock, as pure logic shared by the browser and
// the tests — like public/notify.js and public/live-text.js. It knows nothing
// of the DOM: it is handed the `/auth` payload (what `GET /auth` returns) and
// decides the two user-facing things that depend on it — how to spell a
// deadline, and whether to nag that a re-login is due.
//
// The deadline we care about is `tokenExpiresAt`, the REFRESH token's expiry
// (~22 days) — the real "you must sign in again" moment. The short-lived access
// token (`accessExpiresAt`, ~6h) rotates on its own and is never what we warn
// about; see src/claude-creds.ts.

/** 48h before the deadline: when the cockpit starts nagging to re-login. */
export const EXPIRY_WARN_MS = 48 * 60 * 60 * 1000;

/** A future instant as "in 22 days" / "in 6 h" / "in 40 min" / "expired". */
export function fmtExpiry(ts, now = Date.now()) {
  const s = (ts - now) / 1000;
  if (s <= 0) return "expired";
  const h = s / 3600;
  if (h >= 48) return "in " + Math.round(h / 24) + " days";
  if (h >= 1.5) return "in " + Math.round(h) + " h";
  return "in " + Math.max(1, Math.round(s / 60)) + " min";
}

/**
 * Should the cockpit show the re-login reminder banner, and with what wording?
 *
 * Returns null when there is nothing to warn about, else `{ remainingMs, text,
 * expired }`. The rule is deliberately narrow:
 *  - only an account we KNOW is signed in — never `unknown` (a failed probe is
 *    not a reason to alarm) and never `signed-out` (the sign-in card owns that);
 *  - only when the re-login deadline is actually a number (an env-token
 *    instance carries none, so it is never nagged);
 *  - within 48h, INCLUDING already past it — a tab left open across the
 *    deadline must still nag, not fall silent.
 *
 * @param {{state?: string, loggedIn?: boolean, tokenExpiresAt?: number}|null} auth
 * @param {number} [now]
 * @returns {{remainingMs: number, text: string, expired: boolean}|null}
 */
export function expiryWarning(auth, now = Date.now()) {
  if (!auth) return null;
  // Agents on a long-lived token never use the interactive sign-in: its refresh
  // clock is irrelevant to them, so don't nag about it.
  if (auth.longLived) return null;
  if (auth.state === "unknown" || auth.state === "signed-out" || auth.loggedIn === false) return null;
  const ts = auth.tokenExpiresAt;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const remainingMs = ts - now;
  if (remainingMs >= EXPIRY_WARN_MS) return null;
  const expired = remainingMs <= 0;
  const text = expired
    ? "Your Claude sign-in has expired — re-login to keep your agents running."
    : "Your Claude sign-in expires " + fmtExpiry(ts, now) + " — re-login now to avoid interruptions.";
  return { remainingMs, text, expired };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * What the account panel shows as the token's expiry. On a long-lived-token
 * instance the token is opaque, so the date is an approximation (marked "≈");
 * otherwise the interactive sign-in's refresh clock, as before.
 *
 * @param {{longLived?: boolean, longLivedExpiresAt?: number|null, tokenExpiresAt?: number}|null} auth
 * @param {number} [now]
 * @returns {string|null} null when there is nothing to show
 */
export function accountExpiryLine(auth, now = Date.now()) {
  if (!auth) return null;
  if (auth.longLived) {
    const ts = auth.longLivedExpiresAt;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      const dt = new Date(ts);
      return "Long-lived token — expires ≈ " + MONTHS[dt.getMonth()] + " " + dt.getFullYear();
    }
    return "Long-lived token — no fixed expiry (re-mint via `claude setup-token`)";
  }
  if (typeof auth.tokenExpiresAt === "number") return fmtExpiry(auth.tokenExpiresAt, now);
  return null;
}

/** 5 days: the usage-gauge login is a month-long credential whose renewal needs
 *  the human's browser, so it gets more notice than the instance login. Kept in
 *  step with GAUGE_WARN_MS in src/gauge-login.ts (the server derives `state`). */
export const GAUGE_WARN_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * The reminder for the OPTIONAL usage-gauge login (`gauge` in the `/auth`
 * payload). Null unless a gauge login exists AND is within 5 days of its wall or
 * past it — an instance that never set one up is never nagged, and neither is
 * one on a platform where the row does not apply. The wall is the refresh
 * token's fixed ~1 month window: refreshing never extends it, so this reminder is
 * the whole mitigation.
 *
 * @param {{supported?: boolean, state?: string, refreshExpiresAt?: number|null}|null|undefined} gauge
 * @param {number} [now]
 * @returns {{remainingMs: number, text: string, expired: boolean}|null}
 */
export function gaugeWarning(gauge, now = Date.now()) {
  if (!gauge || gauge.supported === false) return null;
  if (gauge.state !== "expiring" && gauge.state !== "expired") return null;
  const ts = gauge.refreshExpiresAt;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const remainingMs = ts - now;
  const expired = remainingMs <= 0;
  const text = expired
    ? "The usage gauge login has expired — sign it in again to bring the 5h/7d gauges back."
    : "The usage gauge login expires " + fmtExpiry(ts, now) + " — sign it in again to keep the 5h/7d gauges.";
  return { remainingMs, text, expired };
}

/**
 * The version-menu line for the gauge login.
 *
 * @param {{supported?: boolean, state?: string, email?: string|null, refreshExpiresAt?: number|null, lastRefresh?: {ok: boolean, error?: string}|null}|null|undefined} gauge
 * @param {number} [now]
 * @returns {string|null} null when the row should be hidden
 */
export function gaugeLine(gauge, now = Date.now()) {
  if (!gauge || gauge.supported === false) return null;
  if (gauge.state === "none") return "not set up";
  if (gauge.state === "wrong-scope") return "signed in without usage access — sign in again";
  const who = gauge.email || "signed in";
  const until = typeof gauge.refreshExpiresAt === "number" ? " · " + (gauge.state === "expired" ? "expired" : "sign-in lasts " + fmtExpiry(gauge.refreshExpiresAt, now)) : "";
  const bad = gauge.lastRefresh && gauge.lastRefresh.ok === false ? " · refresh failing" : "";
  return who + until + bad;
}
