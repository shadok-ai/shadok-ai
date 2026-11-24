import { chunk } from "./telegram.js";
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
