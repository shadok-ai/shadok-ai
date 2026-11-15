import { isCronPrompt } from "./crons.js";
import { isWebhookPrompt } from "./webhooks.js";
import { isAgentPrompt } from "./kinship.js";
import { stripPromptMeta, parsePromptMeta, hasPromptMeta, markPromptMeta } from "./promptmeta.js";
import { stripLedgerBlock, hasLedgerBlock } from "./ledger.js";

/** What a neutralised line is prefixed with. A visible backslash rather than an
 *  invisible character: the agent and the person replaying it both see that
 *  the line was typed, not stamped by the server. */
export const FORGED_ESCAPE = "\\";

/** Would this line be read as something only the SERVER writes — a context
 *  header, a ledger block, a cron fire, a parent notification? */
function looksServerWritten(line: string): boolean {
  const l = line.trimStart();
  return hasPromptMeta(l) || hasLedgerBlock(l) || isCronPrompt(l) || isWebhookPrompt(l) || isAgentPrompt(l);
}

/**
 * Escape every line of HUMAN text that is shaped like a server-written mark, so
 * it reaches the agent (and the replay) as plain text and never as a header, a
 * ledger delta or a hiding mark. Every line, not only the first: the server's
 * header now always comes first, so a forged one can only sit lower — where the
 * parsers ignore it but an agent reading the prompt would not.
 *
 * Narrow on purpose: Telegram's own scaffolding (`⟦replying to …⟧ "…"`,
 * `⟦heard in the video⟧ …`) opens with ⟦ too, but is not header-shaped (it does
 * not END with ⟧ / carry " · "), so it is left alone. Pure.
 */
export function neutralizeForgedLines(text: string): string {
  return text
    .split("\n")
    .map((l) => (looksServerWritten(l) ? FORGED_ESCAPE + l : l))
    .join("\n");
}

/** A human prompt as the TUI receives it: the server's own header first, the
 *  person's text neutralised beneath it. The one way a header is put on. */
export function markHumanPrompt(text: string, header: string): string {
  return markPromptMeta(neutralizeForgedLines(text), header);
}

/**
 * The text of a transcript line IF it is a real human prompt, else null.
 *
 * A `type: "user"` line is not necessarily someone speaking: Claude Code also
 * writes tool results, system reminders (`<…>`) and interruptions there. The
 * rule was copied verbatim into `loadHistory` and `sessionPreview`; it lives
 * here so a third caller cannot re-derive it slightly wrong (one of them counts
 * turns, the other dated turns).
 */
export function userPromptText(e: any): string | null {
  if (!e || e.isMeta || e.type !== "user" || !e.message) return null;
  const c = e.message.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c))
    text = c
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  text = text.trim();
  // Claude Code wraps a LARGE pasted prompt as `<pasted_content id="…">…
  // </pasted_content>` in the transcript. The server-prepended ledger delta
  // (now on by default) routinely pushes an ordinary prompt over that paste
  // threshold, so the recorded message starts with `<pasted_content` — and the
  // bare `<`-guard below then dropped the WHOLE turn from the web history even
  // though the agent had answered it. Peel the wrapper tags (open + close, with
  // or without the echoed id) and keep the inner text; the ledger/meta headers
  // it now exposes are stripped downstream by loadHistory as usual.
  text = text.replace(/<\/?pasted_content(?:\s[^>]*)?>/g, "").trim();
  // A slash command is recorded as `<command-name>/x</command-name>` plus its
  // `<command-args>`, which the `<`-guard below would drop: the person's own
  // `/my-skill:my-skill …` then vanished from the chat on reload while the
  // answer stayed. Show it as typed.
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    text = args ? `${cmd[1].trim()} ${args}` : cmd[1].trim();
  }
  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted")) return null;
  return text;
}

/** What a `user` transcript line is, for DISPLAY (a shell-mode exchange is
 *  recognised before this and is not covered). */
export type UserLine =
  | { kind: "none" } // tool result, system reminder, interruption
  | { kind: "compaction"; text: string }
  | { kind: "hidden" } // a cron fire or a parent notification
  | { kind: "prompt"; text: string; from?: string; origin?: string };

/**
 * One rule for "is this a prompt a human sees in the chat", shared by the
 * replay (`loadHistory`) and the live tail — which needs it to tell the client
 * the transcript id of a prompt the server echoed before it was written. Two
 * copies would drift, and a drifted one stamps an id on the wrong bubble.
 */
export function classifyUserLine(e: any): UserLine {
  const text = userPromptText(e);
  if (text === null) return { kind: "none" };
  // A compaction summary is a (large) USER message Claude Code writes itself
  // on /compact or an auto-compaction. Real history, folded by the client.
  if (e.isCompactSummary) return { kind: "compaction", text };
  // A pushed ledger delta may ride ahead of ANY prompt — human, cron, or an
  // agent notification — so strip it BEFORE classifying: otherwise a cron /
  // agent prompt no longer starts with its hiding mark and would leak into
  // the display.
  const bare = stripLedgerBlock(text);
  if (isCronPrompt(bare) || isWebhookPrompt(bare) || isAgentPrompt(bare)) return { kind: "hidden" };
  // A human prompt may still open with a context header (⟦platform · time ·
  // who⟧) the agent was given; strip it for display — leaving the message —
  // but FIRST recover who spoke, so a replayed Telegram message shows its
  // sender instead of the generic "pilot".
  const meta = parsePromptMeta(bare);
  return {
    kind: "prompt",
    text: stripPromptMeta(bare),
    ...(meta?.who ? { from: meta.who } : {}),
    ...(meta?.platform ? { origin: meta.platform } : {}),
  };
}
