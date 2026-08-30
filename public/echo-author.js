// Who sent a prompt that came from ANOTHER client? A pure decision, hence
// testable without a browser — the same split as live-text.js, notify.js and
// profile-card.js: loaded as is by the page (ESM) and imported by the tests.
//
// The author label was frozen on "pilot (elsewhere)", which says neither who
// spoke nor from where. The Telegram bridge knows the sender's name; the crons
// know their origin. We may as well say so.

/**
 * @param {{from?: string, origin?: string, auto?: boolean}} msg a `prompt-echo`
 * @returns {string} the label to display above the bubble
 */
export function echoAuthor(msg) {
  // The pace guard's resume comes from nobody: it comes from the server.
  if (msg?.auto) return "auto-retry";
  const from = (msg?.from ?? "").trim();
  const origin = (msg?.origin ?? "").trim();
  // "web" teaches nothing: another tab of the same cockpit. We only show it for
  // want of a name, and even then through the generic wording.
  const place = origin && origin !== "web" ? origin : "";
  if (from) return place ? `${from} · ${place}` : from;
  // No name and nowhere worth naming (a web message, or none): it is the human
  // driving this cockpit — you. Shown for your own prompts and for a message
  // from another of your tabs; a single cockpit has one human.
  return place || "you";
}
