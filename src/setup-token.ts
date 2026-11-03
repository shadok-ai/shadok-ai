import pty from "node-pty";
import { claudeCommand } from "./claude-bin.js";

/**
 * In-cockpit provisioning of the long-lived subscription token
 * (`MT_CLAUDE_OAUTH_TOKEN`), the credential a multi-tenant instance injects into
 * its privilege-dropped group agents (they have no keychain). This module drives
 * `claude setup-token` and hands the minted token to a server-supplied store.
 *
 * Twin of `src/claude-auth.ts` (the sign-in flow) with ONE measured difference,
 * and it is load-bearing: `claude setup-token` is `isatty`-gated. Run with plain
 * pipes it prints NOTHING (verified 2026-11-03, v2.1.317) — so, unlike
 * `auth login`, it must be driven on a PTY. On a PTY it renders a small TUI: a
 * banner, "Browser didn't open? Use the url below…", the URL inside an OSC-8
 * hyperlink (`ESC ] 8 ; id=… ; <url> ST`), a "Paste code here if prompted >"
 * prompt, and — after a valid code — the token (`sk-ant-oat01-…`).
 *
 * The parsers below are pure and fed the accumulated PTY stream (CSI cursor
 * positioning + OSC-8 links). The token value must never be logged or returned;
 * the flow (added alongside) stores it server-side and reports only ok/err.
 *
 * See docs/superpowers/specs/2026-11-03-mt-token-provisioning-design.md.
 */

/**
 * Strip terminal escapes from a PTY chunk: OSC-8 hyperlinks (ST- or
 * BEL-terminated), other OSC sequences, CSI sequences (including the private
 * `?`/`<`/`>`/`=` parameter bytes this TUI uses), and the two-char escapes.
 * What remains is the visible text — which is what the parsers match on.
 */
export function stripTokenEscapes(s: string): string {
  return s
    // OSC-8 open (params ; url) and close (;;), ST or BEL terminated.
    .replace(/\x1b\]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Any other OSC (window title, etc.), ST or BEL terminated.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ <params 0x30-3f> <intermediates 0x20-2f> <final 0x40-7e>.
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    // Two-char escapes (ESC 7/8 save/restore, ESC =/> keypad, etc.).
    .replace(/\x1b[=>78MD]/g, "");
}

/**
 * Pure: the OAuth URL, pulled from the OSC-8 hyperlink TARGET (the URL is the
 * link target, not "visit:" prose as in `auth login`). Falls back to a bare
 * `https://` in the stripped visible text if no OSC-8 is present. Null until the
 * link has been printed.
 */
export function parseSetupTokenUrl(chunk: string): string | null {
  const osc = chunk.match(/\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+?)(?:\x07|\x1b\\)/);
  if (osc) return osc[1];
  const bare = stripTokenEscapes(chunk).match(/https:\/\/\S+/);
  return bare ? bare[0] : null;
}

/**
 * Pure: the refusal the CLI printed for a submitted code, if any. Like
 * `claude-auth.ts`, there is deliberately NO guessed success string — success is
 * the token appearing plus the child settling (see the flow).
 */
export function parseSetupTokenOutcome(chunk: string): "invalid-code" | null {
  return /Invalid code/i.test(stripTokenEscapes(chunk)) ? "invalid-code" : null;
}

/**
 * Pure: the minted token (`sk-ant-oat01-…`) from the stripped stream, or null.
 * Stripping first rejoins a token that the terminal split with cursor-move
 * escapes. The flow MUST spawn the PTY wide enough that the token never
 * line-wraps (a hard wrap inserts a real newline no strip can undo).
 */
export function parseSetupToken(chunk: string): string | null {
  const m = stripTokenEscapes(chunk).match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

// ─── The flow (impure, PTY-driven) ───────────────────────────────────────────

type IPty = ReturnType<typeof pty.spawn>;

/** The OAuth URL expires anyway; a child holding the PTY forever is worse. */
const FLOW_IDLE_MS = 10 * 60_000;
/** Wide enough that the ~100-char token never line-wraps (a hard wrap inserts a
 *  real newline no escape-strip can undo). */
const PTY_COLS = 400;

type Verdict =
  | { kind: "success"; token: string }
  | { kind: "invalid-code" }
  | { kind: "ended" }
  | { kind: "timeout" };

interface Flow {
  proc: IPty;
  /** The OAuth URL this child printed, once it has. */
  url: string | null;
  /** PTY output accumulated since the last code submission (reset per submit). */
  out: string;
  /** Resolver waiting on the verdict for the code we just wrote. */
  pending: ((v: Verdict) => void) | null;
  ended: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ONE flow at a time for the whole instance (the credential is machine-global),
 * shared by the web card and Telegram exactly like the sign-in flow — a code
 * pasted from either finishes the other's.
 */
let flow: Flow | null = null;

export function setupTokenPending(): boolean {
  return flow !== null && !flow.ended;
}

export function cancelSetupToken(): void {
  if (!flow) return;
  clearTimeout(flow.timer);
  try {
    flow.proc.kill();
  } catch {
    /* already gone */
  }
  flow = null;
}

/**
 * Start `claude setup-token` on a PTY and resolve its OAuth URL. Reuses a live
 * flow that already printed a URL (a reload or a second door must not kill the
 * link the operator is looking at — each flow carries its own PKCE challenge).
 */
export async function startSetupToken(): Promise<{ url: string } | { error: string }> {
  if (flow && !flow.ended && flow.url) return { url: flow.url };
  cancelSetupToken();
  let proc: IPty;
  try {
    proc = pty.spawn(claudeCommand(), ["setup-token"], {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: 40,
      cwd: process.cwd(),
      // Neutralise BROWSER so the CLI never opens a tab on the SERVER's machine.
      env: { ...process.env, BROWSER: "/usr/bin/true" },
    });
  } catch (e) {
    return { error: "could not start claude setup-token: " + (e instanceof Error ? e.message : String(e)) };
  }
  const f: Flow = {
    proc,
    url: null,
    out: "",
    pending: null,
    ended: false,
    timer: setTimeout(() => cancelSetupToken(), FLOW_IDLE_MS),
  };
  flow = f;

  const settle = (v: Verdict) => {
    const done = f.pending;
    f.pending = null;
    done?.(v);
  };
  // `all` accumulates ONLY until the URL is found (the URL can span PTY chunks),
  // then is dropped — so the later token never lands in a buffer we do not
  // scrub. The token flows solely into `f.out` (scrubbed on settle), and only
  // while `f.pending` is set, i.e. strictly after the URL and the code.
  let all = "";
  proc.onData((d: string) => {
    if (!f.url) {
      all += d;
      const u = parseSetupTokenUrl(all);
      if (u) {
        f.url = u;
        all = ""; // done with it — never hold the minted token here
      }
    }
    if (f.pending) {
      f.out += d;
      const tok = parseSetupToken(f.out);
      if (tok) {
        settle({ kind: "success", token: tok });
      } else if (parseSetupTokenOutcome(f.out) === "invalid-code") {
        settle({ kind: "invalid-code" });
      }
    }
  });
  proc.onExit(() => {
    f.ended = true;
    if (f.pending) {
      const tok = parseSetupToken(f.out);
      settle(tok ? { kind: "success", token: tok } : { kind: "ended" });
    }
  });

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      cancelSetupToken();
      resolve({ error: "claude setup-token printed no URL within 30s" });
    }, 30_000);
    const poll = setInterval(() => {
      if (f.url) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve({ url: f.url });
      } else if (flow !== f || f.ended) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve({ error: "the setup-token process ended before printing a URL" });
      }
    }, 100);
  });
}

/**
 * Submit the pasted code. Success = the token appears AND the child settles —
 * never a guessed success string (the invalid-code wording is the only one the
 * CLI gives us). On success the token is handed to `store` and the flow is torn
 * down; the token is NEVER returned, logged, or surfaced in an error.
 */
export async function submitSetupTokenCode(
  code: string,
  store: (token: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const f = flow;
  if (!f || f.ended) return { ok: false, error: "no setup-token flow is in progress — start one first" };
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "empty code" };

  clearTimeout(f.timer);
  f.timer = setTimeout(() => cancelSetupToken(), FLOW_IDLE_MS);
  // Forget prior output so a stale "Invalid code" is not read as THIS verdict.
  f.out = "";

  const verdict = await new Promise<Verdict>((resolve) => {
    const t = setTimeout(() => {
      f.pending = null;
      resolve({ kind: "timeout" });
    }, 30_000);
    f.pending = (v) => {
      clearTimeout(t);
      resolve(v);
    };
    // The "Paste code here >" prompt reads a line; a PTY submits on CR.
    f.proc.write(trimmed + "\r");
  });

  if (verdict.kind === "success") {
    try {
      store(verdict.token);
    } catch (e) {
      // Never leak the token in the error. The CLI prints the token then exits,
      // so there is no live flow to retry here — tear it down and scrub, and
      // tell the caller to start a fresh one.
      f.out = "";
      cancelSetupToken();
      return {
        ok: false,
        error: "storing the token failed — start a new one: " + (e instanceof Error ? e.message : "unknown"),
      };
    }
    f.out = ""; // scrub the buffer that held the token
    cancelSetupToken();
    return { ok: true };
  }
  if (verdict.kind === "invalid-code")
    return { ok: false, error: "Invalid code. Please make sure the full code was copied." };
  if (verdict.kind === "ended")
    return { ok: false, error: "the setup-token flow ended — start a new one and try again" };
  return { ok: false, error: "the CLI did not answer within 30s" };
}
