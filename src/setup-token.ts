import { execFileSync } from "node:child_process";
import { claudeCommand } from "./claude-bin.js";
import { tmuxAvailable, tmuxHasSession, tmuxKillSession } from "./tmux.js";

/**
 * In-cockpit provisioning of the long-lived subscription token
 * (`MT_CLAUDE_OAUTH_TOKEN`), the credential a multi-tenant instance injects into
 * its privilege-dropped group agents (they have no keychain). This module drives
 * `claude setup-token` and hands the minted token to a server-supplied store.
 *
 * Driven inside a detached **tmux** session — the same engine as every agent
 * (`src/tmux.ts`, `TmuxPilot`). tmux owns a real terminal, so the `isatty` gate
 * `setup-token` enforces is satisfied, AND we read the terminal **already
 * rendered** (`capture-pane -p`) instead of reverse-engineering a raw
 * OSC-8/CSI escape stream. That removed an entire class of parsing fragility —
 * the exact class that made the first (node-pty) implementation silently miss
 * the minted token at the success screen.
 *
 * Behaviours measured live against the real CLI (v2.1.317, 2026-11-03), driving
 * it through tmux exactly as this module does:
 *   - The URL prints as plain text on its own line (pane set wide so it never
 *     wraps): "Browser didn't open? Use the url below…", then the authorize URL.
 *   - The code box is a MASKED field ("Paste code here if prompted > *****"), so
 *     we wait for the typed code to land before pressing Enter.
 *   - A bad code renders "OAuth error: Invalid code. Please make sure the full
 *     code was copied" followed by "Press Enter to retry" — the retry needs an
 *     explicit Enter to return to the paste prompt (it does not re-prompt alone).
 *
 * The token value must never be logged, returned, or surfaced in an error: the
 * flow stores it server-side and reports only ok/err.
 *
 * See docs/superpowers/specs/2026-11-03-mt-token-provisioning-design.md.
 */

// ─── Pure parsers (fed the rendered pane text) ───────────────────────────────

/**
 * Strip terminal escapes. `capture-pane -p` is already rendered plain text, so
 * this is a defensive no-op there — but it also lets the parsers accept a raw
 * stream (OSC-8 links, CSI cursor moves, two-char escapes) in tests and if a
 * caller ever feeds one.
 */
export function stripTokenEscapes(s: string): string {
  return s
    .replace(/\x1b\]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    .replace(/\x1b[=>78MD]/g, "");
}

/**
 * Pure: the OAuth URL. From the rendered pane it is a bare `https://` on its own
 * line; the OSC-8 target form is still accepted (a raw stream, or a future CLI
 * that emits a hyperlink). Null until the link has been printed.
 */
export function parseSetupTokenUrl(chunk: string): string | null {
  const osc = chunk.match(/\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+?)(?:\x07|\x1b\\)/);
  if (osc) return osc[1];
  const bare = stripTokenEscapes(chunk).match(/https:\/\/\S+/);
  return bare ? bare[0] : null;
}

/**
 * Pure: the refusal the CLI printed for a submitted code, if any. There is
 * deliberately NO guessed success string — success is the token appearing (see
 * the flow). The real wording is "OAuth error: Invalid code. …"; matching the
 * "Invalid code" substring is enough and robust to the surrounding text.
 */
export function parseSetupTokenOutcome(chunk: string): "invalid-code" | null {
  return /Invalid code/i.test(stripTokenEscapes(chunk)) ? "invalid-code" : null;
}

/**
 * Pure: the minted token (`sk-ant-oat01-…`) from the rendered text, or null.
 * Stripping first rejoins a token a raw stream split with cursor escapes; from a
 * `capture-pane` the text is already clean. The flow renders the pane wide
 * enough that the ~108-char token never line-wraps (a hard wrap inserts a real
 * newline no strip can undo).
 */
export function parseSetupToken(chunk: string): string | null {
  const m = stripTokenEscapes(chunk).match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

// ─── The flow (impure, tmux-driven) ──────────────────────────────────────────

/** The OAuth URL expires anyway; a child holding the session forever is worse. */
const FLOW_IDLE_MS = 10 * 60_000;
/** Wide enough that neither the ~346-char URL nor the ~108-char token wraps (a
 *  hard wrap inserts a real newline no escape-strip can undo). */
const PANE_COLS = 400;
const PANE_ROWS = 50;
/** One flow at a time for the whole instance — the tmux session name is fixed. */
const SESSION = "sk-mttoken";

interface Flow {
  url: string | null;
  ended: boolean;
  timer: ReturnType<typeof setTimeout>;
}

let flow: Flow | null = null;

function tmux(args: string[], input?: string): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    input,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

/** The rendered pane. `scrollback` also pulls history, so a line that scrolled
 *  off the visible screen (e.g. the token above a trailing prompt) is caught. */
function capture(scrollback = false): string {
  try {
    const args = ["capture-pane", "-t", SESSION, "-p"];
    if (scrollback) args.push("-S", "-");
    return tmux(args);
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function setupTokenPending(): boolean {
  return flow !== null && !flow.ended && tmuxHasSession(SESSION);
}

export function cancelSetupToken(): void {
  if (flow) clearTimeout(flow.timer);
  tmuxKillSession(SESSION);
  flow = null;
}

/**
 * Start `claude setup-token` in a detached tmux session and resolve its OAuth
 * URL. Reuses a live flow that already printed a URL (a reload or a second door
 * must not kill the link the operator is looking at — each flow carries its own
 * PKCE challenge).
 */
export async function startSetupToken(): Promise<{ url: string } | { error: string }> {
  if (flow && !flow.ended && flow.url && tmuxHasSession(SESSION)) return { url: flow.url };
  cancelSetupToken();
  if (!tmuxAvailable()) return { error: "tmux is not available on this host — it is required to provision the token" };

  // Build the command the way TmuxPilot does: `env` — unsetting any inherited
  // CLAUDE*/CLAUDECODE/AI_AGENT vars (a parent session's token or child-session
  // marker must not reach this nested claude) — then the assignments and the
  // binary, each token single-quoted so values with specials are safe. BROWSER
  // is neutralised so the CLI never tries to open a tab on the SERVER's machine.
  const bin = claudeCommand();
  const unset = Object.keys(process.env)
    .filter((k) => /^(CLAUDE|CLAUDECODE|AI_AGENT)/.test(k))
    .flatMap((k) => ["-u", k]);
  const cmd = ["env", ...unset, "TERM=xterm-256color", "BROWSER=/usr/bin/true", bin, "setup-token"]
    .map((a) => `'${String(a).replace(/'/g, "'\\''")}'`)
    .join(" ");
  try {
    tmuxKillSession(SESSION); // clear any stale session of the same name
    tmux(["new-session", "-d", "-s", SESSION, "-x", String(PANE_COLS), "-y", String(PANE_ROWS), "-c", process.cwd(), cmd]);
  } catch (e) {
    return { error: "could not start claude setup-token: " + (e instanceof Error ? e.message : String(e)) };
  }
  const f: Flow = { url: null, ended: false, timer: setTimeout(() => cancelSetupToken(), FLOW_IDLE_MS) };
  flow = f;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (flow !== f || f.ended) return { error: "the setup-token process ended before printing a URL" };
    if (!tmuxHasSession(SESSION)) {
      cancelSetupToken();
      return { error: "the setup-token process ended before printing a URL" };
    }
    const url = parseSetupTokenUrl(capture());
    if (url) {
      f.url = url;
      return { url };
    }
    await sleep(300);
  }
  cancelSetupToken();
  return { error: "claude setup-token printed no URL within 30s" };
}

/**
 * Submit the pasted code. Types it into the masked box, waits for it to land,
 * presses Enter, then watches the rendered pane for the token or the
 * invalid-code refusal. Success = the token appears; it is handed to `store`
 * and the flow is torn down. The token is NEVER returned, logged, or surfaced
 * in an error.
 */
export async function submitSetupTokenCode(
  code: string,
  store: (token: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const f = flow;
  if (!f || f.ended || !tmuxHasSession(SESSION))
    return { ok: false, error: "no setup-token flow is in progress — start one first" };
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "empty code" };

  clearTimeout(f.timer);
  f.timer = setTimeout(() => cancelSetupToken(), FLOW_IDLE_MS);

  // Type the code (literal — the code may contain '#', '-', etc.), then WAIT for
  // it to appear in the masked box before Enter: a no-delay Enter submits an
  // empty field and nothing happens (measured).
  try {
    tmux(["send-keys", "-t", SESSION, "-l", "--", trimmed]);
  } catch {
    return { ok: false, error: "the setup-token flow ended — start a new one and try again" };
  }
  const entered = Date.now() + 4_000;
  while (Date.now() < entered) {
    // The prompt line gains masked chars (or the code) after the ">".
    const line = capture().split("\n").find((l) => /Paste code here/i.test(l)) ?? "";
    if (/Paste code here[^>]*>\s*\S/i.test(line)) break;
    await sleep(200);
  }
  try {
    tmux(["send-keys", "-t", SESSION, "Enter"]);
  } catch {
    return { ok: false, error: "the setup-token flow ended — start a new one and try again" };
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Scrollback included: on success the token may sit above a trailing line.
    // NB: this buffer can contain the token — it must never be logged.
    const screen = capture(true);
    const tok = parseSetupToken(screen);
    if (tok) {
      try {
        store(tok);
      } catch (e) {
        // Never leak the token in the error. Tear down (the token was already
        // printed; there is no live prompt to retry) and ask for a fresh flow.
        cancelSetupToken();
        return { ok: false, error: "storing the token failed — start a new one: " + (e instanceof Error ? e.message : "unknown") };
      }
      cancelSetupToken();
      return { ok: true };
    }
    if (parseSetupTokenOutcome(screen) === "invalid-code") {
      // The CLI shows "Press Enter to retry" → press Enter to return to the
      // paste prompt, keeping the flow (and its PKCE URL) alive for a retry.
      try {
        tmux(["send-keys", "-t", SESSION, "Enter"]);
      } catch {
        /* session gone — the next submit will report it */
      }
      return { ok: false, error: "Invalid code. Please make sure the full code was copied." };
    }
    if (!tmuxHasSession(SESSION)) {
      f.ended = true;
      cancelSetupToken();
      return { ok: false, error: "the setup-token flow ended — start a new one and try again" };
    }
    await sleep(300);
  }
  return { ok: false, error: "the CLI did not answer within 30s" };
}
