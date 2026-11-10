import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCommand } from "./claude-bin.js";
import { createLoginFlow, type LoginFlow } from "./claude-auth.js";
import { instanceKey } from "./paths.js";

/**
 * The usage-gauge login: an OPTIONAL, dedicated claude.ai sign-in used ONLY to
 * feed the 5h/7d gauge.
 *
 * Why it exists. `GET /api/oauth/usage` needs the `user:profile` scope. The
 * long-lived `setup-token` a multi-tenant instance runs its agents on is scoped
 * `user:inference` only, so it can authenticate agents and still never read the
 * gauge — a scope limit, not an endpoint one. An interactive `claude auth login
 * --claudeai` mints a credential that does carry `user:profile`, so we keep one
 * on the side, in a config dir of its own, and use ONLY its access token for the
 * usage request. Agents never see it.
 *
 * Three facts shape the module (see docs/superpowers/specs/2026-11-10-usage-gauge-login.md):
 *  - the login's REFRESH token has a fixed window (~1 month from sign-in) that a
 *    refresh does not extend, so a manual re-login is inherent — we remind, we
 *    cannot avoid it;
 *  - the refresh token ROTATES, so the store has exactly ONE owner (this module)
 *    and lives in its own `CLAUDE_CONFIG_DIR`, never the agents' or the
 *    instance's;
 *  - we reuse the CLI for both the login and the refresh and implement no OAuth
 *    client of our own (the client id and token endpoint are internal).
 *
 * Opt-in and additive: with no credential in the gauge dir, none of this runs
 * and `usageCandidates` is exactly the list it was before.
 */

/** Warn this long before the refresh token's hard wall. A month-long credential
 *  whose renewal needs the human's browser deserves more notice than the 48 h
 *  the instance login gets. */
export const GAUGE_WARN_MS = 5 * 24 * 60 * 60 * 1000;
/** Refresh once the access token has less than this left. Hours-long tokens, a
 *  15-min tick: this leaves several attempts before it actually lapses. */
export const REFRESH_LEAD_MS = 90 * 60 * 1000;
/** Do not retry a refresh sooner than this after an attempt (success or not). */
export const REFRESH_BACKOFF_MS = 10 * 60 * 1000;
/** An access token this close to its expiry is not offered as a Bearer. */
const ACCESS_SKEW_MS = 60 * 1000;
const KEEP_TICK_MS = 15 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 90_000;
const NEEDED_SCOPE = "user:profile";

/** The dedicated config dir: one per instance, away from every other store. */
export function gaugeConfigDir(home: string, key: string): string {
  return path.join(home, ".shadok-ai", "gauge", key, ".claude");
}

/** Credential-bearing variables that would override the stored login (the CLI
 *  prefers an env token), or leak the agents' identity into the gauge's. */
const SCRUBBED_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** Pure: the environment for any CLI child that must act on the gauge store. */
export function gaugeEnv(base: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of SCRUBBED_ENV) delete env[k];
  env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

export interface GaugeCreds {
  accessToken: string | null;
  hasRefreshToken: boolean;
  /** ms epoch, or null when the blob carries none. */
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  /** Null when the blob lists none (then the scope is not asserted either way). */
  scopes: string[] | null;
}

/** Pure: a `.credentials.json` blob → what we need. Unreadable → null. */
export function parseGaugeCreds(raw: string): GaugeCreds | null {
  try {
    const j = JSON.parse(raw);
    const o = (j && typeof j === "object" ? (j.claudeAiOauth ?? j) : null) as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return null;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === "string") : null;
    return {
      accessToken: str(o.accessToken),
      hasRefreshToken: !!str(o.refreshToken),
      accessExpiresAt: num(o.expiresAt),
      refreshExpiresAt: num(o.refreshTokenExpiresAt),
      scopes,
    };
  } catch {
    return null;
  }
}

export function readGaugeCreds(dir: string): GaugeCreds | null {
  try {
    return parseGaugeCreds(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The signed-in account's address, for the card (`.claude.json` of the gauge
 *  dir). Never throws. */
export function readGaugeEmail(dir: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
    const e = j?.oauthAccount?.emailAddress;
    return typeof e === "string" && e ? e : null;
  } catch {
    return null;
  }
}

export type GaugeState = "none" | "ok" | "expiring" | "expired" | "wrong-scope";

/** Pure: where the gauge login stands. `expiring` = inside GAUGE_WARN_MS of the
 *  refresh token's wall; `expired` = past it (or no way left to renew). */
export function gaugeState(c: GaugeCreds | null, now: number): GaugeState {
  if (!c || (!c.accessToken && !c.hasRefreshToken)) return "none";
  if (c.scopes && !c.scopes.includes(NEEDED_SCOPE)) return "wrong-scope";
  if (c.refreshExpiresAt !== null) {
    if (c.refreshExpiresAt <= now) return "expired";
    if (c.refreshExpiresAt - now < GAUGE_WARN_MS) return "expiring";
  }
  return "ok";
}

/** Pure: the Bearer to offer the usage endpoint, or null. A lapsed or
 *  wrong-scope token is not offered — `getUsage` would only burn a request on it
 *  before falling through. */
export function usableAccessToken(c: GaugeCreds | null, now: number): string | null {
  if (!c?.accessToken) return null;
  if (c.scopes && !c.scopes.includes(NEEDED_SCOPE)) return null;
  if (c.accessExpiresAt !== null && c.accessExpiresAt - now <= ACCESS_SKEW_MS) return null;
  return c.accessToken;
}

/** Pure: should the keeper refresh now? */
export function shouldRefresh(c: GaugeCreds | null, now: number, lastAttemptAt: number | null): boolean {
  if (!c || !c.hasRefreshToken) return false;
  // Past the wall nothing can renew it: a refresh would only fail, every tick.
  if (c.refreshExpiresAt !== null && c.refreshExpiresAt <= now) return false;
  if (lastAttemptAt !== null && now - lastAttemptAt < REFRESH_BACKOFF_MS) return false;
  // An unknown access expiry is treated as due: refreshing early costs one
  // minimal call, a stale token costs a blank gauge.
  return c.accessExpiresAt === null || c.accessExpiresAt - now < REFRESH_LEAD_MS;
}

/**
 * Pure: the usage Bearers in preference order. The gauge login first (the only
 * one guaranteed to carry `user:profile`), then the vault long-lived token (the
 * account the agents run on), then the CLI's live store / env. `getUsage` keeps
 * the first that REPORTS A WINDOW, so an absent or stale gauge login simply falls
 * through to today's behaviour.
 */
export function usageCandidates(c: {
  gauge: string | null;
  longLived: string | null;
  live: string | null;
}): Array<string | null> {
  return [c.gauge, c.longLived, c.live];
}

/** Pure: the CLI invocation that makes it refresh its own access token.
 *
 *  There is no `claude auth refresh` (checked on 2.1.322: "unknown command");
 *  the CLI refreshes lazily, before an authenticated request. So the cheapest
 *  honest trigger is the smallest request there is: one `-p` turn on the
 *  smallest model, no session kept. The OUTCOME is judged on the credentials
 *  file afterwards — never on what the command printed. */
export function refreshInvocation(): { command: string; args: string[] } {
  return {
    command: claudeCommand(),
    args: ["-p", "ok", "--model", "haiku", "--no-session-persistence", "--output-format", "text"],
  };
}

/** The shape of the last refresh attempt, shown on the card. Never a token. */
export interface RefreshOutcome {
  at: number;
  ok: boolean;
  error?: string;
}

/** What the cockpit shows (`GET /usage-gauge`, and `gauge` inside `GET /auth`). */
export interface GaugeView {
  /** False where the credential store is not a file (macOS keychain): the row is hidden. */
  supported: boolean;
  state: GaugeState;
  email: string | null;
  refreshExpiresAt: number | null;
  accessExpiresAt: number | null;
  lastRefresh: RefreshOutcome | null;
}

/** Pure: the view over already-read facts. */
export function gaugeView(
  c: GaugeCreds | null,
  email: string | null,
  lastRefresh: RefreshOutcome | null,
  now: number,
  supported = true,
): GaugeView {
  return {
    supported,
    state: gaugeState(c, now),
    email: c ? email : null,
    refreshExpiresAt: c?.refreshExpiresAt ?? null,
    accessExpiresAt: c?.accessExpiresAt ?? null,
    lastRefresh,
  };
}

export type ExecFn = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; timeout: number },
) => Promise<{ error: string | null }>;

const realExec: ExecFn = (command, args, opts) =>
  new Promise((resolve) => {
    try {
      const child = execFile(command, args, { ...opts, maxBuffer: 1 << 20 }, (err) =>
        resolve({ error: err ? String(err.message ?? err).split("\n")[0] : null }),
      );
      child.stdin?.end();
    } catch (e) {
      resolve({ error: String((e as Error)?.message ?? e) });
    }
  });

/**
 * One keep-fresh attempt. Success means the stored access expiry MOVED FORWARD:
 * an exit code of 0 proves a model answered, not that the store was rewritten.
 * Pure over `exec` and the file reads, so the shape is tested without a login.
 */
export async function refreshOnce(
  dir: string,
  now: () => number,
  exec: ExecFn = realExec,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<RefreshOutcome> {
  const before = readGaugeCreds(dir);
  const { command, args } = refreshInvocation();
  const { error } = await exec(command, args, {
    env: gaugeEnv(baseEnv, dir),
    cwd: dir,
    timeout: REFRESH_TIMEOUT_MS,
  });
  const after = readGaugeCreds(dir);
  const moved =
    !!after?.accessExpiresAt && (!before?.accessExpiresAt || after.accessExpiresAt > before.accessExpiresAt);
  if (moved) return { at: now(), ok: true };
  return { at: now(), ok: false, error: error ?? "the access token's expiry did not advance" };
}

/** Forget the gauge login (opt out). Refuses a path that is not ours. */
export function forgetGauge(dir: string): boolean {
  if (!dir.includes(`${path.sep}gauge${path.sep}`)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * The runtime half: owns the dir, the login flow and the keeper. Built once by
 * the server. `supported` is false on macOS, where the CLI keeps credentials in
 * the keychain rather than the file we read.
 */
export interface Gauge {
  readonly dir: string;
  readonly login: LoginFlow;
  /** The Bearer for the usage endpoint, or null. */
  token(): string | null;
  view(): GaugeView;
  /** Start the keep-fresh timer. Returns a stop function. */
  startKeeper(log?: (line: string) => void): () => void;
  forget(): boolean;
  /** One keep-fresh pass now; resolves when it settles. */
  tick(log?: (line: string) => void): Promise<void>;
}

export function createGauge(
  opts: {
    home?: string;
    key?: string;
    now?: () => number;
    exec?: ExecFn;
    platform?: NodeJS.Platform;
    onChange?: () => void;
  } = {},
): Gauge {
  const dir = gaugeConfigDir(opts.home ?? os.homedir(), opts.key ?? instanceKey());
  const now = opts.now ?? Date.now;
  const supported = (opts.platform ?? process.platform) !== "darwin";
  let last: RefreshOutcome | null = null;
  let lastAttempt: number | null = null;
  let running: Promise<void> | null = null;

  const login = createLoginFlow({
    // 0700 before the CLI writes anything: in multi-tenant the agents are other
    // OS users, and this store must stay unreadable to them.
    env: () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return gaugeEnv(process.env, dir);
    },
    onSuccess: () => opts.onChange?.(),
  });

  const tick = (log: (line: string) => void = () => {}): Promise<void> => {
    if (running) return running;
    const c = readGaugeCreds(dir);
    // A login in progress owns the store; refreshing under it would race it.
    if (login.pending() || !shouldRefresh(c, now(), lastAttempt)) return Promise.resolve();
    lastAttempt = now();
    running = (async () => {
      try {
        last = await refreshOnce(dir, now, opts.exec);
        const exp = readGaugeCreds(dir)?.accessExpiresAt;
        log(
          last.ok
            ? `gauge: access token refreshed${exp ? ` (valid until ${new Date(exp).toISOString()})` : ""}`
            : `gauge: refresh failed — ${last.error}`,
        );
        opts.onChange?.();
      } catch (e) {
        last = { at: now(), ok: false, error: String((e as Error)?.message ?? e) };
        log(`gauge: refresh failed — ${last.error}`);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    dir,
    login,
    token: () => (supported ? usableAccessToken(readGaugeCreds(dir), now()) : null),
    view: () => gaugeView(readGaugeCreds(dir), readGaugeEmail(dir), last, now(), supported),
    startKeeper(log) {
      if (!supported) return () => {};
      const first = setTimeout(() => void tick(log), 20_000);
      const timer = setInterval(() => void tick(log), KEEP_TICK_MS);
      first.unref();
      timer.unref();
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
    forget() {
      login.cancel();
      last = null;
      lastAttempt = null;
      const ok = forgetGauge(dir);
      opts.onChange?.();
      return ok;
    },
    tick,
  };
}
