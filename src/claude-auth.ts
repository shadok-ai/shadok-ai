import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Claude Code authentication: status, and the interactive login.
 *
 * The load-bearing finding behind this module (verified 2026-08-08 against
 * claude v2.1.226): `claude auth login --claudeai` needs NO PTY. Run with plain
 * pipes it prints the OAuth URL on stdout and reads the code from stdin. So the
 * login touches none of the screen heuristics — no `detectDialog`, no
 * `screenShowsWork`, nothing from the fragile family invariant nº 2 warns
 * about. It is a spawn, a stdout parser and one write to stdin.
 *
 * See docs/superpowers/specs/2026-08-08-claude-onboarding-design.md.
 */

/**
 * Three states, not two.
 *
 * "I observed that it is signed out" and "I could not look" are different
 * facts, and collapsing them was a real bug: `claude auth status` takes ~850ms
 * and can fail (timeout, truncated output, a busy machine), which produced an
 * empty stdout, which read as *signed out* — so the cockpit popped its sign-in
 * card and spawned a `claude auth login` child on an instance that was
 * perfectly signed in. Only `signed-out` is ever asserted; `unknown` is
 * reported as such and acted on conservatively but never announced to the user.
 */
export type AuthState = "signed-in" | "signed-out" | "unknown";

export interface AuthStatus {
  /** True only for `signed-in`. Kept for callers that just need a boolean. */
  loggedIn: boolean;
  state: AuthState;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/** Pure: `claude auth status --json`. Unreadable output is `unknown`, NOT signed out. */
export function parseAuthStatus(stdout: string): AuthStatus {
  try {
    const j = JSON.parse(stdout);
    if (!j || typeof j !== "object" || Array.isArray(j))
      return { loggedIn: false, state: "unknown" };
    if (j.loggedIn !== true) return { loggedIn: false, state: "signed-out" };
    return {
      loggedIn: true,
      state: "signed-in",
      ...(typeof j.authMethod === "string" ? { authMethod: j.authMethod } : {}),
      ...(typeof j.email === "string" ? { email: j.email } : {}),
      ...(typeof j.subscriptionType === "string" ? { subscriptionType: j.subscriptionType } : {}),
    };
  } catch {
    return { loggedIn: false, state: "unknown" };
  }
}

/**
 * Strip ANSI/OSC escape sequences.
 *
 * The login output wraps the URL in an OSC 8 hyperlink
 * (`ESC ] 8 ; ; <url> BEL <visible text> ESC ] 8 ; ; BEL`), so the URL is
 * physically present TWICE and a naive `visit:\s*(\S+)` captures the escape
 * plus a fragment of it. Stripping first makes the match trivial.
 */
function stripEscapes(s: string): string {
  return s
    // OSC 8 open (ESC ] 8 ; ; <url> BEL) and close (ESC ] 8 ; ; BEL).
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Ordinary CSI colour/cursor sequences.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Pure: the OAuth URL the CLI printed, or null if it hasn't printed one yet. */
export function parseLoginUrl(chunk: string): string | null {
  const m = stripEscapes(chunk).match(/visit:\s*(https:\/\/\S+)/);
  return m ? m[1] : null;
}

/**
 * Pure: the refusal the CLI printed for the code we submitted, if any.
 *
 * There is deliberately no "success" case. The invalid-code wording was
 * captured from the real CLI; a success wording never was, and a parser that
 * guessed one would produce a sign-in that silently never completes. Success is
 * the child exiting cleanly — see `startLogin`.
 */
export function parseLoginOutcome(chunk: string): "invalid-code" | null {
  return /Invalid code/i.test(stripEscapes(chunk)) ? "invalid-code" : null;
}

/** How long a status answer is reused. It is a spawn, and the card polls it. */
const STATUS_TTL_MS = 30_000;
/** The OAuth URL expires anyway; a child holding stdin open forever is worse. */
const FLOW_IDLE_MS = 10 * 60_000;

let cached: { at: number; status: AuthStatus } | null = null;

export function invalidateAuthStatus(): void {
  cached = null;
}

const probe = (): Promise<AuthStatus> =>
  new Promise((resolve) => {
    execFile("claude", ["auth", "status", "--json"], { timeout: 15_000 }, (_err, stdout) =>
      resolve(parseAuthStatus(stdout ?? "")),
    );
  });

export async function authStatus(force = false): Promise<AuthStatus> {
  if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  let status = await probe();
  // One retry, because the probe is a ~850ms process spawn and a busy machine
  // makes it flake. A single retry turns the common transient failure into a
  // definite answer instead of a wrong one.
  if (status.state === "unknown") status = await probe();
  // NEVER cache "unknown": holding a failed probe for 30s would keep the whole
  // instance in a doubtful state long after the cause passed.
  if (status.state !== "unknown") cached = { at: Date.now(), status };
  return status;
}

type Verdict = "success" | "invalid-code" | "ended" | "timeout";

interface Flow {
  child: ChildProcessWithoutNullStreams;
  /** The OAuth URL this child printed, once it has. */
  url: string | null;
  /** Everything the child has written since the last code was submitted. */
  out: string;
  /** Resolver waiting on the verdict for the code we just wrote. */
  pending: ((r: Verdict) => void) | null;
  /** The child has ended — a further code cannot be submitted to it. */
  ended: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ONE flow at a time for the whole instance: the credentials are machine-global,
 * so a second concurrent login would race the first for the same keychain
 * entry. The upside is free — the web card and Telegram share the same URL, and
 * a code pasted from either finishes the other's flow.
 */
let flow: Flow | null = null;

export function loginPending(): boolean {
  return flow !== null && !flow.ended;
}

export function cancelLogin(): void {
  if (!flow) return;
  clearTimeout(flow.timer);
  flow.child.kill();
  flow = null;
}

export async function startLogin(): Promise<
  { url: string } | { alreadySignedIn: true } | { error: string }
> {
  // Reuse a flow that already printed its URL instead of replacing it. Each
  // flow carries its own PKCE challenge, so restarting would silently kill the
  // link the user is already looking at — which a plain page reload, or a
  // second tab, would otherwise do.
  if (flow && !flow.ended && flow.url) return { url: flow.url };
  // Never spawn a sign-in on an instance that is already signed in. This is the
  // backstop for the whole class of "it launched for nothing": whatever led the
  // caller here, a forced re-check has the last word.
  if ((await authStatus(true)).state === "signed-in") return { alreadySignedIn: true };
  cancelLogin();
  const child = spawn("claude", ["auth", "login", "--claudeai"], {
    // BROWSER is neutralised: on a desktop host the CLI would otherwise open a
    // tab on the SERVER's machine, which is not where the user is.
    env: { ...process.env, BROWSER: "/usr/bin/true" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const f: Flow = {
    child,
    url: null,
    out: "",
    pending: null,
    ended: false,
    timer: setTimeout(() => cancelLogin(), FLOW_IDLE_MS),
  };
  flow = f;

  const settle = (v: Verdict) => {
    const done = f.pending;
    f.pending = null;
    done?.(v);
  };
  const onData = (d: Buffer) => {
    f.out += d.toString();
    if (parseLoginOutcome(f.out) === "invalid-code") settle("invalid-code");
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  // SUCCESS IS AN EXIT, NOT A STRING. The "Invalid code…" wording was captured
  // from the real CLI; the success wording never was, and inventing one would
  // produce a sign-in that silently never completes. A clean exit after a code
  // was submitted is the signal we can actually prove.
  child.on("exit", (code) => {
    f.ended = true;
    settle(code === 0 ? "success" : "ended");
  });
  // A `claude` that is not on PATH must not leave the caller hanging until the
  // 30s deadline with no explanation.
  child.on("error", () => {
    f.ended = true;
    settle("ended");
  });

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      cancelLogin();
      resolve({ error: "claude auth login printed no URL within 30s" });
    }, 30_000);
    const poll = setInterval(() => {
      const url = parseLoginUrl(f.out);
      if (url) {
        f.url = url;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve({ url });
      } else if (flow !== f || f.ended) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve({ error: "the login process ended before printing a URL" });
      }
    }, 100);
  });
}

export async function submitLoginCode(
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const f = flow;
  if (!f || f.ended) return { ok: false, error: "no sign-in is in progress — start one first" };
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "empty code" };

  // The user is clearly still here: push the idle deadline back.
  clearTimeout(f.timer);
  f.timer = setTimeout(() => cancelLogin(), FLOW_IDLE_MS);
  // Forget what came before, so a stale "Invalid code" from a previous attempt
  // is never mistaken for the verdict on THIS one.
  f.out = "";

  const verdict = await new Promise<Verdict>((resolve) => {
    const t = setTimeout(() => {
      f.pending = null;
      resolve("timeout");
    }, 30_000);
    f.pending = (r) => {
      clearTimeout(t);
      resolve(r);
    };
    f.child.stdin.write(trimmed + "\n");
  });

  if (verdict === "success") {
    cancelLogin();
    invalidateAuthStatus();
    return { ok: true };
  }
  if (verdict === "invalid-code")
    return { ok: false, error: "Invalid code. Please make sure the full code was copied." };
  if (verdict === "ended")
    return { ok: false, error: "the sign-in was refused — start a new one and try again" };
  return { ok: false, error: "the CLI did not answer within 30s" };
}
