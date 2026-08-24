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
 * One step of the "is this turn over?" loop, shared by both pilots.
 *
 * A turn ends on an ABSENCE of change: the screen must stop showing work AND
 * stay byte-identical for `stableMs`. That is a proxy, and a deliberately
 * conservative one — a TUI can look calm for an instant between two tool calls,
 * and calling the turn there would cut it in half.
 *
 * `stableMs` is a parameter and not a constant because the bar is not always
 * the same. When the user pressed the interrupt key, the end state is not being
 * guessed at: we asked for it. The caller may then lower the window, and the
 * turn is released in a fraction of the time. What it may NOT do is excuse a
 * screen that still shows work — that check is here, above the window, so no
 * caller can shorten its way past it.
 *
 * Pure on purpose: the loop it replaces lived twice (both pilots) and could
 * only be exercised by spawning a real process.
 */
export function idleStep(
  screen: string,
  lastScreen: string,
  stableSince: number,
  now: number,
  stableMs: number,
): { done: boolean; stableSince: number; lastScreen: string } {
  if (screenShowsWork(screen) || screen !== lastScreen) {
    return { done: false, stableSince: 0, lastScreen: screen };
  }
  // 0 means "not stable yet": start the clock, but never settle on the spot —
  // one poll proves nothing about the next.
  const since = stableSince === 0 ? now : stableSince;
  return { done: now - since >= stableMs, stableSince: since, lastScreen };
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

/**
 * Why a screen refused a prompt — named, when the shape is recognisable.
 *
 * `submit` reports "the text never appeared in the input box", which describes
 * the SYMPTOM and points at the input box, where there is nothing to find. Three
 * agents were once wedged on Claude Code's first-run screen — no input box at
 * all, every prompt echoed into a masked field — and that message sent the
 * investigation towards session startup, twice, before anyone looked at the
 * pane. Naming what is actually on screen turns hours into seconds.
 *
 * Returns null when nothing is recognised: a vague message beats a confident
 * wrong one.
 */
export function describeStuckScreen(screen: string): string | null {
  if (/Welcome to Claude Code/i.test(screen))
    return "the agent is sitting on Claude Code's first-run screen, so it never reached a prompt — its onboarding state (~/.claude.json) was missing when it started";
  // A masked field echoes every pasted character as an asterisk, so the text is
  // physically on screen yet unreadable — and unreadable is what breaks submit.
  if (/\*{20,}/.test(screen))
    return "the screen is a masked input field (long runs of asterisks), so the pasted text is never readable back";
  if (/^\s*❯\s*\d+\.\s+\S/m.test(screen))
    return "the agent is waiting on a question, not on a prompt — answer it first";
  return null;
}

/**
 * How long to wait before reading a session's screen again.
 *
 * The screen watcher used to run at a flat 300 ms for EVERY session, which put
 * the cadence one consumer needs — a human watching the engine room — on all of
 * them at once, forever. Since `screen()` is a synchronous `tmux capture-pane`,
 * the cost lands on the server's event loop and grows with the number of agents
 * that EXIST rather than with what anyone is looking at: measured at 6 ms a
 * capture, twenty-one idle agents blocked 42% of the loop and every HTTP
 * request queued behind it for a second or more.
 *
 * An idle agent's screen is byte-identical for hours (measured: ten out of ten
 * unchanged over 1.2 s), so the watcher can back off and lose nothing. Anything
 * that could move the screen resets the streak to zero.
 */
export const SCREEN_FAST_MS = 300;
export const SCREEN_SLOW_MS = 2000;
/** Unchanged polls tolerated before backing off at all — a short burst of
 *  stillness is normal mid-turn and must not slow the mirror down. */
export const SCREEN_CALM_AFTER = 3;

export function nextScreenDelay(unchangedStreak: number, busy: boolean): number {
  // A running turn is watched closely: this is when the screen moves most, and
  // there is only ever a handful of busy sessions at once.
  if (busy) return SCREEN_FAST_MS;
  if (unchangedStreak < SCREEN_CALM_AFTER) return SCREEN_FAST_MS;
  const grown = SCREEN_FAST_MS * 2 ** (unchangedStreak - SCREEN_CALM_AFTER + 1);
  return Math.min(grown, SCREEN_SLOW_MS);
}
