// Who a chat bubble is from, drawn as a round chip instead of a written name:
// initials for a person, the Shadok for the agent (and for the server's own
// messages). A pure decision, hence testable without a browser — loaded as is
// by the page (ESM) and imported by the tests, like echo-author.js.
//
// The full name is NOT lost: the page puts it in the chip's tooltip and
// aria-label. A photo can later replace the initials without changing callers:
// `avatarFor` is the one place that decides what a speaker looks like.

/** Labels that name a machine, not a person: drawn as the Shadok. */
const MACHINE = new Set(["claude", "shadok-ai", "auto-retry", "cron", "agent"]);

/**
 * The person part of a label: `echoAuthor` writes "Name · telegram" — the
 * platform after the dot is not part of who spoke.
 * @param {string} who
 */
export function speakerName(who) {
  return String(who ?? "").split(" · ")[0].trim();
}

/**
 * Up to two initials: first letter of the first and of the last word
 * ("Alexandre Cognard" → "AC", "ada" → "A"). Letters only, so an email-like
 * name ("ana@example.org") still reads "A", and digits/emoji never fill a chip.
 * @param {string} name
 */
export function initials(name) {
  const words = String(name ?? "")
    .split(/[\s@._-]+/)
    .map((w) => w.match(/\p{L}/u)?.[0] ?? "")
    .filter(Boolean);
  if (!words.length) return "?";
  const pick = name && /@/.test(name) ? [words[0]] : words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return pick.join("").toUpperCase();
}

/** The palette the agent tabs already use (index.html `AVATAR_COLORS`), so a
 *  person's chip and an agent's tab share one visual language. */
export const AVATAR_COLORS = ["#5b5fc7", "#0078d4", "#038387", "#498205", "#c4314b", "#ca5010", "#8764b8", "#986f0b", "#00727c", "#b146c2"];

/**
 * A stable colour per name, so the same person keeps it on every device and
 * every reload — never a random draw, never the list position. Same hash as
 * the tabs' `paintTabAvatar`.
 * @param {string} name
 */
export function colorFor(name) {
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/**
 * @param {string} who the label the bubble would have carried ("claude",
 *   "you", "Ada · telegram", "you · shell"…)
 * @param {{ role?: string, me?: string | null }} [ctx] `role` = the turn's role
 *   ("claude" for the agent's side); `me` = the signed-in account's name, which
 *   is what "you" stands for.
 * @returns {{ kind: "shadok" } | { kind: "initials", text: string, color: string }
 *   | { kind: "you" }}
 */
export function avatarFor(who, ctx = {}) {
  const name = speakerName(who);
  if (ctx.role === "claude" || MACHINE.has(name.toLowerCase())) return { kind: "shadok" };
  if (name === "you" || name === "") {
    const me = String(ctx.me ?? "").trim();
    // No account (a cockpit with no password) or `/me` still in flight: a
    // neutral silhouette rather than a made-up "Y".
    return me ? { kind: "initials", text: initials(me), color: colorFor(me) } : { kind: "you" };
  }
  return { kind: "initials", text: initials(name), color: colorFor(name) };
}
