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

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/** Pure: `claude auth status --json`. Anything unreadable reads as logged out. */
export function parseAuthStatus(stdout: string): AuthStatus {
  try {
    const j = JSON.parse(stdout);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { loggedIn: false };
    if (j.loggedIn !== true) return { loggedIn: false };
    return {
      loggedIn: true,
      ...(typeof j.authMethod === "string" ? { authMethod: j.authMethod } : {}),
      ...(typeof j.email === "string" ? { email: j.email } : {}),
      ...(typeof j.subscriptionType === "string" ? { subscriptionType: j.subscriptionType } : {}),
    };
  } catch {
    return { loggedIn: false };
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
