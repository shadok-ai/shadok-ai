// The cockpit's notification decision: which colour on the favicon, which
// prefix in the title, and whether to blink — see
// docs/superpowers/specs/2026-07-29-blinking-notifications-and-per-channel-mute-design.md
//
// Loaded as is by the browser (ESM) and imported by the node/tsx tests, like
// public/live-text.js and public/profile-card.js. The module knows nothing of
// the DOM or of tabs: it is handed a list of { mood, muted }.

/** An agent blocked on a question: something has to be DONE. */
const RED = "#e07a6a";
/** The blink's low phase — dark, but still visible. */
const RED_DIM = "#8a4034";
/** An answer that landed in a channel nobody is watching. */
const AMBER = "#f0a848";

/**
 * The blink period. Deliberately above one second: the browser throttles a
 * hidden tab's timers to ~1 Hz, and aiming shorter would only stack up skipped
 * ticks.
 */
export const BLINK_MS = 900;

/**
 * The channels' aggregated attention state.
 *
 * `away` = the user is not on the page. v1 read `document.hidden`, which does
 * NOT say "you are looking elsewhere": it stays false as long as the window is
 * displayed, even when another application has focus. And that is the cockpit's
 * normal use — window open on a screen, user in their terminal — so the blink
 * never fired where it was useful. The caller now composes visibility AND
 * focus.
 *
 * `phase` alternates 0/1 at the blink's rhythm. Both phases always return a
 * colour AND a badge: Chrome throttles a hidden tab's timers (down to one wake
 * per minute after ~5 min), and an on/off frozen on "off" would make the page
 * look perfectly calm while an agent waits. Here the worst case is a slow
 * blink.
 *
 * @param {Array<{mood?: string|null, muted?: boolean}>} channels
 * @param {{away: boolean, phase: number}} view
 * @returns {{color: string|null, badge: string, blink: boolean}}
 */
export function notifyState(channels, view) {
  const away = !!(view && view.away);
  const phase = view && view.phase ? 1 : 0;

  let blocked = false;
  let unread = false;
  let working = false;
  for (const c of channels || []) {
    if (!c || c.muted) continue; // a muted channel raises no global signal
    if (c.mood === "needs-answer") blocked = true;
    else if (c.mood === "unread") unread = true;
    else if (c.mood === "working") working = true;
  }

  // Priority: "there is something to do" (blocked) outranks "something
  // arrived" (unread), which outranks "it is working". `mode` tells the caller
  // which favicon to draw (the "working" mode is ANIMATED in the DOM).
  if (blocked) {
    // Only a blocked agent justifies blinking, and only when you are away.
    if (!away) return { color: RED, badge: "● ", blink: false, mode: "blocked" };
    return phase
      ? { color: RED_DIM, badge: "◉ ", blink: true, mode: "blocked" }
      : { color: RED, badge: "● ", blink: true, mode: "blocked" };
  }
  if (unread) return { color: AMBER, badge: "● ", blink: false, mode: "unread" };
  // "working" has neither pip colour nor badge: the caller animates the favicon
  // (the Shadok pumping) for as long as the mode is "working".
  if (working) return { color: null, badge: "", blink: false, mode: "working" };
  return { color: null, badge: "", blink: false, mode: null };
}
