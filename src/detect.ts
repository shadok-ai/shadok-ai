/**
 * Detection of the "Claude is working" state from the rendered TUI screen.
 *
 * Kept free of any dependency so it can be unit-tested directly
 * (debug/detect.test.mjs) against captured screen fixtures.
 */

/**
 * Marker displayed by Claude Code TUIs while working. The genuine one always
 * sits in the status group, right after a "·" separator or an opening "(",
 * e.g. "(… · esc to interrupt)". Requiring that prefix means prose that merely
 * *mentions* the phrase — Claude explaining shadok-ai's own turn detection,
 * quoted or not — never reads as "working".
 */
const ESC_TO_INTERRUPT = /[·(]\s*esc to interrupt/i;

/**
 * Newer TUIs drop the "esc to interrupt" hint; the live spinner line is then
 * the only working signal: a glyph at column 0 followed by a status and an
 * "(<elapsed> · …)" group with the elapsed FIRST, e.g.
 *   ✽ Jitterbugging… (4m 26s · ↓ 7.1k tokens · …)
 * A finished turn renders past tense without parens ("✻ Baked for 8m 20s"),
 * and completion lines put the elapsed LAST ("(… · 5m 40s)"): no match.
 */
const SPINNER_STATUS =
  /^[^\s\w].{0,80}?\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·/m;

/** True when the screen indicates that Claude is currently working. */
export function screenShowsWork(screen: string): boolean {
  return ESC_TO_INTERRUPT.test(screen) || SPINNER_STATUS.test(screen);
}

/**
 * True while the text we just typed is still sitting in the input box (the
 * last "❯ …" line). Used to confirm a submit: before Enter the probe is in the
 * box; once Enter is accepted the box clears, so `!inputHasProbe` means "sent".
 * This is robust to a fast turn scrolling the echo out of the transcript —
 * unlike looking for the probe anywhere on screen, which false-negatived and
 * dumped the whole screen as an error.
 */
export function inputHasProbe(screen: string, probe: string): boolean {
  const promptLines = screen.split("\n").filter((l) => l.trimStart().startsWith("❯"));
  const inputLine = promptLines[promptLines.length - 1] ?? "";
  return inputLine.includes(probe);
}

/**
 * The current content of the input box (the last "❯ …" line), without the "❯".
 * Submit detection keys off this being non-empty (something is typed/pasted)
 * then empty again (sent) — content-agnostic, so it also works when the TUI
 * collapses a big paste into a "[Pasted text +N lines]" placeholder (the
 * literal text isn't on screen to look for).
 */
export function inputText(screen: string): string {
  // The input box is the "❯ …" line, or in shell mode the "! …" line at column
  // 0 — where the TUI pads the prompt with a NON-BREAKING space (U+00A0), not a
  // regular one, so match `\s` (which includes it), never a literal " ". (The
  // "  ! for shell mode" hint is indented, so requiring the bang at column 0
  // excludes it.)
  let inputLine = "";
  for (const l of screen.split("\n")) {
    if (l.trimStart().startsWith("❯") || /^!\s/.test(l)) inputLine = l;
  }
  return inputLine.replace(/^\s*[❯!]\s*/, "").trim();
}
