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
