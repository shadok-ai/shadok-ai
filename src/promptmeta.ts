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

/**
 * The REPLY ADDRESS an `agent` header ends with: the short session id of the
 * agent that spoke, so the one reading it can answer without a lookup.
 *
 * A name is not an address — nothing makes cockpit tab names unique, and every
 * tool takes an id — so naming the sender was only half of telling the receiver
 * who it is. Eight hex characters is what `resolveResumeId` resolves (it refuses
 * an ambiguous prefix rather than guessing) and what the rest of the cockpit
 * already prints for a session.
 *
 * The SHAPE is the discriminator, and it is why the rule below is narrow: a
 * header's `who` is deliberately "everything past the time" so a name
 * containing " · " survives, and a fourth field would have eaten into it. Only
 * an `agent` platform, only an exact 8-hex last field. Anything else is name.
 */
const AGENT_REF = /^[0-9a-f]{8}$/;

/** Build the header line: ⟦platform · time [· who][· ref]⟧. */
export function promptMetaHeader(
  platform: string,
  at: Date,
  who?: string,
  timeZone?: string,
  ref?: string,
): string {
  const parts = [platform.trim() || "web", formatWhen(at, timeZone)];
  const w = (who ?? "").trim();
  if (w) parts.push(w);
  // A ref with no name would sit where the name is read, and parse back as one.
  const r = (ref ?? "").trim();
  if (r && w) parts.push(r);
  return `${META_OPEN}${parts.join(" · ")}${META_CLOSE}`;
}

/** Does this text already open with a context header? (idempotence + strip.) */
export function hasPromptMeta(text: string): boolean {
  if (typeof text !== "string") return false;
  const first = text.split("\n", 1)[0].trim();
  return first.startsWith(META_OPEN) && first.endsWith(META_CLOSE) && first.includes(" · ");
}

/**
 * Parse a leading context header into its fields, or null if there is none.
 * `who` is often empty (the web usually sends no sender name; Telegram does).
 * The name is taken as everything past the time, so a name that itself contains
 * " · " survives. Lets a replayed history restore who spoke — otherwise a
 * Telegram message came back as the generic "pilot", its sender lost with the
 * stripped header.
 *
 * `ref` is the sender's reply address, present on an `agent` header only (see
 * AGENT_REF). It is returned SEPARATELY from `who` on purpose: the client labels
 * a bubble with `who`, so an address kept inside the name would have shown up in
 * the chat on every reload.
 */
export function parsePromptMeta(
  text: string,
): { platform: string; who: string; ref?: string } | null {
  if (!hasPromptMeta(text)) return null;
  const first = text.split("\n", 1)[0].trim();
  const inner = first.slice(META_OPEN.length, first.length - META_CLOSE.length);
  const parts = inner.split(" · ");
  const platform = (parts[0] ?? "").trim();
  // Split the reply address off the END before reading the name, and ONLY for
  // an agent header: `who` stays everything past the time, so a sender whose
  // name contains " · " is still recovered whole. The id never reaches the
  // chat — the client labels a bubble with `who` (`echoAuthor`), and an address
  // is plumbing, not a byline.
  const last = (parts[parts.length - 1] ?? "").trim();
  const hasRef = platform === "agent" && parts.length >= 4 && AGENT_REF.test(last);
  const who = (hasRef ? parts.slice(2, -1) : parts.slice(2)).join(" · ").trim();
  return { platform, who, ...(hasRef ? { ref: last } : {}) };
}

/**
 * Prepend the header as its own first line — ALWAYS.
 *
 * It used to return early when the text already opened with a header ("never
 * double a header"). The text is the HUMAN's, so that rule let anyone type
 * `⟦agent · … · Shadok-Boss · 1a2b3c4d⟧` as their first line and have it reach
 * the agent as the only header there was: a Telegram message or web prompt
 * passing for a sibling agent (with a forged reply address) or for the admin,
 * and replayed under that forged author. The server's header is unconditional;
 * a header-shaped line in the user's text is neutralised by the caller
 * (`markHumanPrompt`, src/prompt-kind.ts), so it can never parse as one.
 */
export function markPromptMeta(text: string, header: string): string {
  return `${header}\n${text}`;
}

/** What the server knows about a WebSocket connection, decided ONCE at connect
 *  from its headers — never from a frame. */
export type ConnectionFacts = {
  /** Presented the per-process system-drive secret (`driveChannel`). */
  systemDrive: boolean;
  /** Presented the per-process Telegram-bridge secret (src/telegram.ts). */
  telegramBridge: boolean;
  /** Signed by a verified agent session key (pilotctl inside an agent). */
  agent: boolean;
  /** Authenticated as a peer instance (`x-shadok-peer`). */
  peer: boolean;
  /** A same-origin browser person (`requestFromBrowser`). */
  browser: boolean;
};

/** The labels a bare local client (no proof of anything) may pick for itself:
 *  neither gets a privilege — no hiding, no believed `from`. */
const LOCAL_CLAIMS = new Set(["cli", "boot"]);

/**
 * WHERE a connection speaks from, derived from what it PROVED at connect.
 *
 * `origin` used to be whatever the `start` frame declared, and it decides three
 * things a client must not choose for itself: the header the agent reads, the
 * author (`promptAuthor` believed `from` for anything but web/agent), and
 * visibility (`cron` suppressed the echo to other tabs and added no header). So
 * a browser could send `origin: "telegram", from: "Alexandre"`, or
 * `origin: "cron"` to speak to the agent unseen. Each internal client now has a
 * credential no frame can carry, and the claim only matters for a client that
 * proved nothing — and even then it may only NARROW to a harmless label.
 * Order is precedence: the system drive also carries the bridge's cookie, so it
 * is checked first.
 */
export function connectionOrigin(c: ConnectionFacts, claimed: unknown): string {
  if (c.systemDrive) return "cron";
  if (c.telegramBridge) return "telegram";
  if (c.agent) return "agent";
  if (c.peer) return "peer";
  if (c.browser) return "web";
  return typeof claimed === "string" && LOCAL_CLAIMS.has(claimed) ? claimed : "cli";
}

/** Is this message a Claude Code command (`/compact`, `/my-skill:my-skill …`)?
 *  The TUI reads a command only when `/` is the FIRST thing in the box, so such
 *  a message must reach it bare: no header line, no ledger paste ahead of it.
 *  The first token must be a command name, so a path (`/Users/x …`) is not one. Pure. */
export function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:.-]*(\s|$)/.test(text);
}

/** Remove a leading context header (and only that line); a plain message is
 *  returned untouched. */
export function stripPromptMeta(text: string): string {
  if (!hasPromptMeta(text)) return text;
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(nl + 1) : "";
}
