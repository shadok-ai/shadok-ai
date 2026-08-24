/**
 * A one-line context header prepended to a HUMAN prompt before it reaches the
 * TUI: the platform it came from, the time, and who sent it (when we know —
 * Telegram tells us, the web usually doesn't). The agent SEES it (useful
 * context — nothing else told it who is talking, or that a message arrived at
 * 3am), but the transcript display STRIPS it, the same way a cron mark is
 * hidden. Difference with the cron/agent marks: those hide the WHOLE message
 * (it is machine-written); here only the header line goes, the message stays.
 *
 * Not added for the terminal view (raw keystrokes bypass the prompt handler)
 * nor for cron/agent prompts (already marked, and not "someone speaking").
 *
 * The header is wrapped in ⟦ ⟧ (U+27E6/U+27E7 — rare in ordinary typing) and
 * always carries a " · " separator, so the strip almost never fires on a line a
 * user actually wrote. Same strict, opens-the-message rule as the other marks.
 */
export const META_OPEN = "⟦";
export const META_CLOSE = "⟧";

/** "2026-08-25 14:30" in the given IANA zone (machine zone when omitted). */
export function formatWhen(at: Date, timeZone?: string): string {
  try {
    // sv-SE renders ISO-like "YYYY-MM-DD HH:MM".
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Build the header line: ⟦platform · time [· who]⟧. */
export function promptMetaHeader(platform: string, at: Date, who?: string, timeZone?: string): string {
  const parts = [platform.trim() || "web", formatWhen(at, timeZone)];
  const w = (who ?? "").trim();
  if (w) parts.push(w);
  return `${META_OPEN}${parts.join(" · ")}${META_CLOSE}`;
}

/** Does this text already open with a context header? (idempotence + strip.) */
export function hasPromptMeta(text: string): boolean {
  if (typeof text !== "string") return false;
  const first = text.split("\n", 1)[0].trim();
  return first.startsWith(META_OPEN) && first.endsWith(META_CLOSE) && first.includes(" · ");
}

/** Prepend the header as its own first line. Idempotent. */
export function markPromptMeta(text: string, header: string): string {
  if (hasPromptMeta(text)) return text; // never double a header
  return `${header}\n${text}`;
}

/** Remove a leading context header (and only that line); a plain message is
 *  returned untouched. */
export function stripPromptMeta(text: string): string {
  if (!hasPromptMeta(text)) return text;
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(nl + 1) : "";
}
