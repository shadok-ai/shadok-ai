import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeCommand } from "./claude-bin.js";
import { tmuxAvailable, tmuxHasSession, tmuxKillSession } from "./tmux.js";
import { dropArgv } from "./osusers.js";
import { parseSetupTokenUrl, parseSetupTokenOutcome } from "./setup-token.js";

/**
 * In-cockpit `claude auth login --claudeai` for a SINGLE OS user, in `login`
 * auth mode (`config.agentAuth === "login"`). Unlike `setup-token.ts` (which
 * mints the server-owned long-lived token and runs as the server user), this
 * drives an interactive subscription login AS a dropped user (`main`, or a
 * private group's `sk-*`), so the credential lands in THAT user's own
 * `~/.claude/.credentials.json` and that user's agents get the account's
 * claude.ai connectors.
 *
 * Why per-user and never shared across users: `claude` refreshes the on-disk
 * credential by write-new-then-rename, leaving it owned by the refresher in mode
 * 600 — so a credential shared between DIFFERENT OS users locks the others out on
 * the first refresh (measured, ledger `[45be]`/`[2d5c]`). Same-user agents share
 * one login natively (one uid, one real file); that is all we rely on.
 *
 * Mechanics mirror `setup-token.ts`: a detached tmux pane (a real TTY for the
 * CLI's `isatty` gate; `capture-pane -p` reads already-rendered text), the pane
 * set wide so the ~350-char URL never wraps, and the SAME OAuth screens — so the
 * URL and invalid-code parsers are reused from there. The difference is success
 * detection: there is no token on screen; success is the credential FILE
 * appearing in the user's home (an observed fact, invariant 27). The credential
 * value is never read for its contents, logged, or returned.
 *
 * Design: docs/superpowers/specs/2026-11-04-connectors-via-global-login-design.md
 */

/** The OAuth URL expires anyway; a child holding the session forever is worse. */
const FLOW_IDLE_MS = 10 * 60_000;
/** Wide enough that the ~350-char authorize URL never wraps. */
const PANE_COLS = 400;
const PANE_ROWS = 50;

/** One flow per OS user; the tmux session name is derived from the user. */
function sessionFor(user: string): string {
  return `sk-login-${user}`;
}

/** The credential file a login writes, under the user's own home. */
export function credPathForHome(home: string): string {
  return path.join(home, ".claude", ".credentials.json");
}

/**
 * Whether `home` holds a login, and when it lapses — the two facts the cockpit
 * needs for the per-user status row. NEVER returns the token value; reads only
 * `refreshToken` presence and `refreshTokenExpiresAt` (~1 month).
 */
export function agentLoginInfo(home: string): { loggedIn: boolean; expiresAt: number | null } {
  try {
    const d = JSON.parse(fs.readFileSync(credPathForHome(home), "utf8"));
    const o = d.claudeAiOauth ?? d;
    return {
      loggedIn: !!o.refreshToken,
      expiresAt: typeof o.refreshTokenExpiresAt === "number" ? o.refreshTokenExpiresAt : null,
    };
  } catch {
    return { loggedIn: false, expiresAt: null };
  }
}

interface Flow {
  user: string;
  home: string;
  url: string | null;
  ended: boolean;
  /** mtime (ms) of any pre-existing credential, so success = a NEWER file. */
  priorMtime: number;
  timer: ReturnType<typeof setTimeout>;
}

const flows = new Map<string, Flow>();

function tmux(args: string[], input?: string): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    input,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function capture(session: string): string {
  try {
    // `-J` rejoins visually WRAPPED lines. The login OAuth URL (the full
    // claude.ai scope set) is long enough to wrap the pane, and without `-J`
    // `capture-pane` returns the wrap as two lines — so `parseSetupTokenUrl`'s
    // `\S+` stops at the newline and hands back a TRUNCATED URL (no `state`, no
    // `code_challenge_method`), which claude.com rejects as an invalid OAuth
    // request. Width alone is not a safe fix (a longer URL wraps again); `-J`
    // reassembles whatever the width.
    return tmux(["capture-pane", "-t", session, "-p", "-J"]);
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** mtime of the credential file in ms, or 0 if absent/unreadable. */
function credMtime(home: string): number {
  try {
    return fs.statSync(credPathForHome(home)).mtimeMs;
  } catch {
    return 0;
  }
}

export function agentLoginPending(user: string): boolean {
  const f = flows.get(user);
  return !!f && !f.ended && tmuxHasSession(sessionFor(user));
}

export function cancelAgentLogin(user: string): void {
  const f = flows.get(user);
  if (f) clearTimeout(f.timer);
  tmuxKillSession(sessionFor(user));
  flows.delete(user);
}

/**
 * Start `claude auth login --claudeai` as `user` (HOME `home`) in a detached
 * tmux pane and resolve the OAuth URL. Reuses a live flow that already printed a
 * URL (a reload must not kill the link the operator is looking at — each flow
 * carries its own PKCE challenge).
 */
export async function startAgentLogin(
  user: string,
  home: string,
): Promise<{ url: string } | { error: string }> {
  const session = sessionFor(user);
  const live = flows.get(user);
  if (live && !live.ended && live.url && tmuxHasSession(session)) return { url: live.url };
  cancelAgentLogin(user);
  if (!tmuxAvailable())
    return { error: "tmux is not available on this host — it is required to run the login" };

  // Drop to the target user (setpriv) and run the login. `env` unsets any
  // inherited CLAUDE*/CLAUDECODE/AI_AGENT vars (a parent token or child-session
  // marker must not reach this login) and sets the user's own HOME so the
  // credential lands in that home; BROWSER is neutralised so the CLI never opens
  // a tab on the server. Each token single-quoted for the shell tmux runs.
  const bin = claudeCommand();
  const drop = dropArgv(user, bin, ["auth", "login", "--claudeai"]);
  const unset = Object.keys(process.env)
    .filter((k) => /^(CLAUDE|CLAUDECODE|AI_AGENT)/.test(k))
    .flatMap((k) => ["-u", k]);
  const cmd = [
    "env",
    ...unset,
    `HOME=${home}`,
    `USER=${user}`,
    `LOGNAME=${user}`,
    "TERM=xterm-256color",
    "BROWSER=/usr/bin/true",
    drop.cmd,
    ...drop.argv,
  ]
    .map((a) => `'${String(a).replace(/'/g, "'\\''")}'`)
    .join(" ");

  try {
    tmuxKillSession(session);
    tmux(["new-session", "-d", "-s", session, "-x", String(PANE_COLS), "-y", String(PANE_ROWS), cmd]);
  } catch (e) {
    return { error: "could not start the login: " + (e instanceof Error ? e.message : String(e)) };
  }

  const f: Flow = {
    user,
    home,
    url: null,
    ended: false,
    priorMtime: credMtime(home),
    timer: setTimeout(() => cancelAgentLogin(user), FLOW_IDLE_MS),
  };
  flows.set(user, f);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (flows.get(user) !== f || f.ended) return { error: "the login ended before printing a URL" };
    if (!tmuxHasSession(session)) {
      cancelAgentLogin(user);
      return { error: "the login ended before printing a URL" };
    }
    const url = parseSetupTokenUrl(capture(session));
    if (url) {
      f.url = url;
      return { url };
    }
    await sleep(300);
  }
  cancelAgentLogin(user);
  return { error: "the login printed no URL within 30s" };
}

/**
 * Submit the pasted code for `user`'s login. Types it into the masked box, waits
 * for it to land, presses Enter, then watches for SUCCESS (a fresh credential
 * file in the user's home) or the invalid-code refusal. The credential is never
 * read for its contents, logged, or returned.
 */
export async function submitAgentLoginCode(
  user: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = sessionFor(user);
  const f = flows.get(user);
  if (!f || f.ended || !tmuxHasSession(session))
    return { ok: false, error: "no login is in progress for this user — start one first" };
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "empty code" };

  clearTimeout(f.timer);
  f.timer = setTimeout(() => cancelAgentLogin(user), FLOW_IDLE_MS);

  try {
    tmux(["send-keys", "-t", session, "-l", "--", trimmed]);
  } catch {
    return { ok: false, error: "the login ended — start a new one and try again" };
  }
  const entered = Date.now() + 4_000;
  while (Date.now() < entered) {
    const line = capture(session).split("\n").find((l) => /Paste code here/i.test(l)) ?? "";
    if (/Paste code here[^>]*>\s*\S/i.test(line)) break;
    await sleep(200);
  }
  try {
    tmux(["send-keys", "-t", session, "Enter"]);
  } catch {
    return { ok: false, error: "the login ended — start a new one and try again" };
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Success is the credential file appearing (or being rewritten) — a fresh
    // mtime beats the one captured at start. We never read its contents.
    if (credMtime(f.home) > f.priorMtime) {
      cancelAgentLogin(user);
      return { ok: true };
    }
    if (parseSetupTokenOutcome(capture(session)) === "invalid-code") {
      try {
        tmux(["send-keys", "-t", session, "Enter"]); // back to the paste prompt
      } catch {
        /* session gone — the next submit reports it */
      }
      return { ok: false, error: "Invalid code. Please make sure the full code was copied." };
    }
    if (!tmuxHasSession(session)) {
      f.ended = true;
      cancelAgentLogin(user);
      // The pane can exit right after writing the credential; re-check the file.
      return credMtime(f.home) > f.priorMtime
        ? { ok: true }
        : { ok: false, error: "the login ended — start a new one and try again" };
    }
    await sleep(300);
  }
  return { ok: false, error: "the login did not complete within 30s" };
}
