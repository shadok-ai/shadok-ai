import { chunk, isFreetextOption } from "./telegram.js";
import { guestNotice } from "./tg-guests.js";
import type { WaMedia } from "./wa-guests.js";
import { isSlashCommand } from "./promptmeta.js";

/**
 * What an agent's Markdown becomes in a WhatsApp chat, and the two things the
 * bridge does to text crossing it: neutralising a stranger's command, and
 * keeping a server path out of a stranger's chat. Pure, tested.
 *
 * WhatsApp has its own small formatting (`*bold*`, `_italic_`, `~strike~`,
 * `` `code` ``, ```` ``` ```` blocks, `> ` quotes, `- ` / `1. ` lists) and no
 * HTML at all, so nothing is ever produced that WhatsApp would read as markup
 * the agent did not write: headings become bold lines, links `text (url)`,
 * tables plain lines, and HTML stays literal text.
 */

const FENCE = /^\s{0,3}(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

// Private-use characters as placeholders: an agent's text cannot contain them
// by accident, and they never survive into the output.
const CODE_MARK = "";
const BOLD_OPEN = "";
const BOLD_CLOSE = "";

function inline(s: string): string {
  const codes: string[] = [];
  let out = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
  });
  // Images and links: the text, then the address — WhatsApp previews a bare URL.
  out = out.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => (!t || t === u ? u : `${t} (${u})`));
  // Bold before italic: `**x**` must not be read as two italics.
  out = out.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
  out = out.replace(/(^|[^\w])__(?!\s)([^_\n]+?)(?<!\s)__(?![\w])/g, `$1${BOLD_OPEN}$2${BOLD_CLOSE}`);
  out = out.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1_$2_");
  out = out.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "~$1~");
  out = out.replaceAll(BOLD_OPEN, "*").replaceAll(BOLD_CLOSE, "*");
  return out.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"), (_m, i: string) => `\`${codes[Number(i)]}\``);
}

/** Emphasis inside a line that becomes bold as a whole would nest markers. */
const plain = (s: string) => s.replace(/\*\*|__/g, "");

export function mdToWhatsApp(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of String(md ?? "").split("\n")) {
    if (FENCE.test(line)) {
      // The language tag would show as a literal word after the backticks.
      out.push("```");
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (TABLE_ROW.test(line)) {
      if (TABLE_RULE.test(line)) continue;
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
      out.push(cells.join(" · "));
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push(h[1] ? `*${inline(plain(h[1]))}*` : "");
      continue;
    }
    if (RULE.test(line)) {
      out.push("—");
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      // `* item` is read by WhatsApp as the start of bold: always `- `.
      out.push(`${b[1]}- ${inline(b[2])}`);
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      out.push(`> ${inline(q[1])}`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join("\n");
}

/** Readable in one screen, far below WhatsApp's own ceiling. */
export const WA_MSG_LIMIT = 4000;

/**
 * A long answer, cut at paragraph boundaries first (a WhatsApp message is
 * read as a unit; a cut mid-paragraph reads as a glitch), and at line
 * boundaries only for a paragraph that alone exceeds the limit.
 */
export function waChunks(text: string, max = WA_MSG_LIMIT): string[] {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const out: string[] = [];
  let cur = "";
  for (const para of t.split(/\n{2,}/)) {
    const next = cur ? `${cur}\n\n${para}` : para;
    if (next.length <= max) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    if (para.length <= max) cur = para;
    else {
      const pieces = chunk(para, max);
      cur = pieces.pop() ?? "";
      out.push(...pieces);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A stranger's message that starts with a command name, made into text.
 *
 * The server submits a message that is `isSlashCommand` BARE, so the terminal
 * runs it: `/clear` would erase the continuity this feature promises, `/login`
 * or `/model` are worse. Telegram guests are stopped by its dispatcher; this
 * bridge has none, so it rewrites the leading `/name` as `\/name` — visible,
 * plain ASCII the agent reads as an escaped slash, and no longer a command. The
 * server refuses a bare command from the `whatsapp` origin anyway: a bridge is
 * not where a guarantee should live.
 */
export function neutralizeCommand(text: string): string {
  const t = String(text ?? "");
  return isSlashCommand(t.trim()) ? `\\${t.trimStart()}` : t;
}

/**
 * The cockpit's attachment markers name a file on the SERVER (`[Attached
 * image: /root/.shadok-ai/media/…]`). Sending files is step 3; until then an
 * operator's message that carried one reaches the person with the kind of
 * file, never its path.
 */
export function stripAttachmentMarkers(text: string): string {
  return String(text ?? "").replace(/\[Attached (image|file|video): [^\]\n]+\]/g, "[$1]");
}

// ── step 3: media file names, questions ─────────────────────────────────────


const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

/**
 * The name a received medium is stored under. Built from untrusted input (the
 * message id, the sender's file name), so it is REBUILT from safe characters
 * — no separator, no `..` — like Telegram's `mediaFileName`, prefixed with the
 * id so the same message is the same file.
 */
export function waMediaFileName(id: string, media: WaMedia): string {
  const safeId = String(id ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "m";
  const raw = typeof media.fileName === "string" ? media.fileName : "";
  const base = raw.split(/[\\/]/).pop()!.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  if (base) return `wa-${safeId}-${base}`;
  const ext = media.mime ? MIME_EXT[media.mime.split(";")[0].trim().toLowerCase()] : undefined;
  return ext ? `wa-${safeId}.${ext}` : `wa-${safeId}`;
}

/** The slice of a server `dialog` frame a WhatsApp question needs. */
export interface WaDialog {
  question?: string;
  body?: string;
  multi?: boolean;
  options: { n: number; label: string; checked?: boolean }[];
}

/**
 * A question as WhatsApp can carry it: there are no reliable buttons on this
 * path, so it is a numbered list, followed by how to answer (`guestNotice`).
 */
export function dialogMessage(d: WaDialog): string {
  const head = [d.body?.trim(), (d.question || "").trim()].filter(Boolean).join("\n\n");
  const lines = d.options.map((o) => `${o.n}. ${d.multi && !isFreetextOption(o.label) ? (o.checked ? "☑ " : "☐ ") : ""}${o.label.trim()}`);
  const how = [guestNotice(d.multi ? "dialog-multi" : "dialog-single")];
  if (d.options.some((o) => isFreetextOption(o.label))) how.push(guestNotice("dialog-text"));
  return [head, lines.join("\n"), how.filter(Boolean).join(" ")].filter(Boolean).join("\n\n");
}

export type DialogReply =
  | { kind: "choose"; n: number }
  | { kind: "toggles"; toggles: number[] }
  | { kind: "freetext"; n: number; text: string }
  | { kind: "need-text"; n: number }
  | { kind: "invalid" };

/**
 * A person's reply to a question, as the frames Telegram's keyboard sends
 * (`choose` / `toggle` + `confirm` / `freetext`). Pure, tested.
 *
 * - single choice: the number (anything after it is ignored: "2 please");
 * - an own-answer option ("Type something"): its number then the words, or the
 *   number alone (the words come next), or straight a sentence when the
 *   question has exactly one such option;
 * - multiple choice: the numbers WANTED — the result is the toggles that turn
 *   what is checked into that set, so "1 3" means exactly 1 and 3 whatever was
 *   pre-ticked;
 * - anything else is `invalid`, and the person is told how to answer again.
 */
export function parseDialogReply(d: WaDialog, text: string): DialogReply {
  const t = String(text ?? "").trim();
  const byN = new Map(d.options.map((o) => [o.n, o]));
  const own = d.options.filter((o) => isFreetextOption(o.label));
  const sentence = (): DialogReply => (own.length === 1 && t ? { kind: "freetext", n: own[0].n, text: t } : { kind: "invalid" });
  if (d.multi) {
    if (!/^\d+([\s,;]+\d+)*[.]?$/.test(t)) {
      const m = /^(\d+)[.)]?\s+(.+)$/s.exec(t);
      if (m && own.some((o) => o.n === Number(m[1]))) return { kind: "freetext", n: Number(m[1]), text: m[2].trim() };
      return sentence();
    }
    const want = new Set(t.match(/\d+/g)!.map(Number));
    for (const n of want) if (!byN.has(n) || isFreetextOption(byN.get(n)!.label)) return { kind: "invalid" };
    const toggles = d.options
      .filter((o) => !isFreetextOption(o.label) && want.has(o.n) !== !!o.checked)
      .map((o) => o.n);
    return { kind: "toggles", toggles };
  }
  const m = /^(\d+)[.)]?(?:\s+(.*))?$/s.exec(t);
  if (m && byN.has(Number(m[1]))) {
    const n = Number(m[1]);
    const rest = (m[2] ?? "").trim();
    if (isFreetextOption(byN.get(n)!.label)) return rest ? { kind: "freetext", n, text: rest } : { kind: "need-text", n };
    return { kind: "choose", n };
  }
  return sentence();
}
