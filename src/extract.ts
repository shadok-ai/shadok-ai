import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newestTranscriptById, isNothingToShow, parseTimestamp } from "./tail.js";
import { isCronPrompt } from "./crons.js";
import { isAgentPrompt } from "./kinship.js";
import { stripPromptMeta } from "./promptmeta.js";
import { stripLedgerBlock } from "./ledger.js";

/**
 * Extracts the response: everything after the "❯ <prompt>" echo in the
 * transcript, minus the final input box and status lines.
 */
export function extractResponse(buffer: string, prompt: string): string {
  const lines = buffer.split("\n");
  const probe = prompt.slice(0, 15);
  let start = -1;
  // The prompt echo in the transcript starts with "❯ "; so does the (empty)
  // input box at the bottom — take the last occurrence containing the
  // beginning of the prompt.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯>]/.test(lines[i]) && lines[i].includes(probe)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return buffer.trim();
  // A long prompt echo spans several lines: the response starts at the
  // first "⏺" marker that follows, when there is one.
  for (let i = start; i < lines.length; i++) {
    if (/^\s*⏺/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const noise = (l: string) =>
    /^\s*✻/.test(l) || /·\s*\/effort\s*$/.test(l) || /esc to interrupt/i.test(l);
  // Cut the input area (─── separator followed by ❯) when present.
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^─{10,}/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start, end)
    .filter((l) => !noise(l))
    .join("\n")
    .trim();
}

export interface TuiDialogOption {
  n: number;
  label: string;
  hint: string;
  /** Multi-select only: state of the [ ] / [✔] checkbox. */
  checked?: boolean;
}

export interface TuiDialog {
  question: string;
  options: TuiDialogOption[];
  /**
   * True for multi-select questions: digits toggle checkboxes, submission
   * goes through Tab (Submit page) then Enter. In single-select mode,
   * pressing the digit selects and validates directly.
   */
  multi: boolean;
}

/**
 * The identity of a rendered dialog, to tell "still the same question" from
 * "a new one".
 *
 * The screen is re-read several times a second and a dialog's pixels move
 * constantly (footer clock, cursor, the ❯ travelling between options), so the
 * raw screen is useless as an identity. What must NOT change silently is the
 * question and the set of labels; the ❯ position and the checkbox states are
 * excluded on purpose — the user moving the cursor is not a new question.
 */
export function dialogKey(d: TuiDialog): string {
  return JSON.stringify([d.question, d.multi, d.options.map((o) => [o.n, o.label])]);
}

/**
 * The resume-from-summary prompt, which is auto-answered at startup and must
 * never reach a client (invariant 4). A stale copy would otherwise flash before
 * the auto-answer lands.
 */
export function isResumeSummaryDialog(d: TuiDialog): boolean {
  return d.options.some((o) => /full session/i.test(o.label)) && /resum|summary/i.test(d.question);
}

/**
 * Detects an interactive TUI dialog (multiple-choice question, permission
 * prompt…): numbered options, one of which carries the "❯" selector.
 */
export function detectDialog(screen: string): TuiDialog | null {
  // AskUserQuestion can render a preview (chart, code…) in a right-hand column
  // on the SAME lines as the options. Strip that column — a run of ≥2 spaces
  // followed by a box-drawing char — so option labels don't absorb it.
  const lines = screen
    .split("\n")
    .map((l) => l.replace(/\s{2,}[│┌└├┐┘┤┬┴┼─╭╮╰╯].*$/u, "").replace(/\s+$/, ""));
  const optionRe = /^\s*(❯\s*)?(\d+)\.\s+(?:\[( |✔|✓|x)\]\s*)?(.+)$/;
  // Options are collected into contiguous GROUPS, one per rendered dialog box.
  // A previous, already-answered AskUserQuestion can still be visible in the
  // xterm scrollback above the current one; scanning the whole screen as a
  // single list merged both option sets — corrupting the numbering, forcing
  // multi=true from a leftover checkbox, and surfacing the wrong question. We
  // keep only the group carrying the ❯ cursor: the dialog the user is on.
  interface Group {
    options: TuiDialogOption[];
    hasSelector: boolean;
    multi: boolean;
    firstLine: number;
  }
  const groups: Group[] = [];
  let group: Group | null = null;
  let current: TuiDialogOption | null = null;

  for (let i = 0; i < lines.length; i++) {
    // A blank line ends the current option's description run — but WITHOUT
    // closing the group, so a numbered option after it still joins. In the
    // preview (side-by-side) layout the stripped preview box leaves blank lines,
    // then footer chrome ("Notes: press n to add notes", "Chat about this")
    // indented under the column; without this, that chrome was glued onto the
    // last option's hint. Real descriptions sit flush under their option (no
    // blank between), so this never drops a genuine hint.
    if (lines[i].trim() === "") {
      current = null;
      continue;
    }
    const m = lines[i].match(optionRe);
    if (m) {
      if (!group) {
        group = { options: [], hasSelector: false, multi: false, firstLine: i };
        groups.push(group);
      }
      current = { n: Number(m[2]), label: m[4].trim(), hint: "" };
      if (m[1]) group.hasSelector = true;
      if (m[3] !== undefined) {
        group.multi = true;
        current.checked = m[3] !== " ";
      }
      group.options.push(current);
    } else if (
      current &&
      /^\s{2,}\S/.test(lines[i]) &&
      !/Enter to /i.test(lines[i]) &&
      !/^\s*Submit\s*$/.test(lines[i])
    ) {
      // Indented line under an option: the option's description.
      current.hint = (current.hint ? current.hint + " " : "") + lines[i].trim();
    } else if (lines[i].trim() !== "" && !/^\s*─+/.test(lines[i])) {
      // A content line (question text, tab bar, box border) ends the run — the
      // next options belong to a different dialog box.
      current = null;
      group = null;
    }
  }

  // The active dialog is the option group with the ❯ cursor (bottom-most wins if
  // two ever show one). A stale scrollback dialog has no cursor → it's dropped.
  const chosen = [...groups].reverse().find((g) => g.hasSelector);
  if (!chosen || chosen.options.length < 2) return null;
  const { options, multi, firstLine: firstOptionLine } = chosen;

  // The question: the text lines right above the first option (skipping
  // frames, separators and the "← ☐ … ✔ Submit →" tab bar).
  const questionLines: string[] = [];
  for (let i = firstOptionLine - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "" || /^[─═╭╮╰╯│□⏺←→]/.test(t) || /[☐☒]|✔\s*Submit/.test(t)) {
      if (questionLines.length) break;
      continue;
    }
    questionLines.unshift(t);
  }
  return { question: questionLines.join(" "), options, multi };
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
  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted")) return null;
  return text;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
  /**
   * When the turn was written (ms epoch), taken from the .jsonl line's
   * `timestamp`. Same source as `TailEvent.at`, so a replayed turn and the same
   * turn seen live show the SAME time. Absent on older transcripts.
   */
  at?: number;
  /**
   * A HIDDEN user prompt (a scheduled `cron` fire, or a parent notification)
   * ran between this assistant turn and the one before it. Both are dropped from
   * the replay, which would otherwise let this turn MERGE into the previous one
   * (they become adjacent) — a daily report gluing itself onto an unrelated
   * earlier answer under a single label. The client keeps this turn's own label
   * when the flag is set. Mirrors `TailEvent.afterInternal` for the live path.
   */
  afterInternal?: true;
}

/**
 * Reads a session transcript back from its .jsonl file
 * (~/.claude/projects/<encoded cwd>/<session-id>.jsonl) so the history can
 * be replayed when resuming the session.
 */
export function loadHistory(cwd: string, sessionId: string): HistoryTurn[] {
  // Same drift-immunity as the tail: prefer the newest <id>.jsonl anywhere, so a
  // moved/renamed worktree's history still resolves (see sessionFilePath).
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const file =
    newestTranscriptById(sessionId) ??
    path.join(os.homedir(), ".claude", "projects", encoded, sessionId + ".jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const turns: HistoryTurn[] = [];
  // A hidden user prompt (cron / parent notification) was dropped and now
  // separates the next assistant turn from the previous one — so that turn must
  // NOT merge into it, and keeps its own label. Reset by any turn we actually
  // emit; a tool_result `continue` leaves it, since that sits mid-turn.
  let pendingHiddenPrompt = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isMeta || !e.message) continue;
    const at = parseTimestamp(e.timestamp);
    const when = at === null ? {} : { at };
    if (e.type === "user") {
      const text = userPromptText(e);
      if (text === null) continue; // tool result, system reminder, interruption
      // Machine-written user messages: a scheduled prompt and a notification
      // about a child agent. Neither is shown live, so neither may come back on
      // a reload or a topic backfill — but a dropped one still BROKE the turn,
      // so remember it to keep the next answer from merging onto the last.
      if (isCronPrompt(text) || isAgentPrompt(text)) {
        pendingHiddenPrompt = true;
        continue;
      }
      // A human prompt may open with a pushed ledger delta then a context header
      // (⟦platform · time · who⟧) the agent was given; strip both for display —
      // the ledger block first (its ⟦ledger⟧ line also looks like a header), then
      // the header — leaving the message itself.
      turns.push({ role: "user", text: stripPromptMeta(stripLedgerBlock(text)), ...when });
      pendingHiddenPrompt = false;
    } else if (e.type === "assistant" && Array.isArray(e.message.content)) {
      const text = e.message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        // Same block-by-block filter as the tail, otherwise the sentinel
        // reappears on a page reload though it was never streamed.
        .filter((t: any) => typeof t === "string" && !isNothingToShow(t))
        .join("\n")
        .trim();
      if (!text) continue;
      const last = turns[turns.length - 1];
      // Consecutive blocks merged into one turn: we KEEP the first one's time,
      // which is when the speaking started (and that is where the client shows
      // the group label). But a hidden prompt in between makes this a NEW turn:
      // don't merge, and flag it so the client keeps its own label.
      if (last && last.role === "assistant" && !pendingHiddenPrompt) last.text += "\n\n" + text;
      else turns.push({ role: "assistant", text, ...(pendingHiddenPrompt ? { afterInternal: true } : {}), ...when });
      pendingHiddenPrompt = false;
    }
  }
  return turns.slice(-100);
}

export interface SessionInfo {
  id: string;
  /** Last activity, in ms since epoch (file mtime). */
  mtime: number;
  /** First real user prompt of the session, truncated. */
  preview: string;
}

/**
 * Lists the resumable sessions of a directory (newest first), with the
 * first user prompt as a preview so a session can be recognized by more
 * than its id.
 */
export function listSessions(cwd: string): SessionInfo[] {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", encoded);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    sessions.push({
      id: f.replace(/\.jsonl$/, ""),
      mtime,
      preview: firstUserPrompt(file),
    });
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

/** Reads the beginning of a transcript and returns the first real user prompt. */
function firstUserPrompt(file: string): string {
  // Only the head of the file is needed — transcripts can be several MB.
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const text = userPromptText(e);
    if (text === null) continue;
    return text.replace(/\s+/g, " ").slice(0, 120);
  }
  return "";
}

/**
 * When the session's last REAL prompt was written (ms epoch), or null.
 *
 * That is the current turn's origin: a turn starts with a prompt (human, cron,
 * or another client driving it) and ends when the agent falls silent. So we
 * ignore technical `user` lines — a tool result arrives MID-turn and would date
 * the origin a few seconds before now.
 */
export function lastPromptAt(cwd: string, sessionId: string): number | null {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const file =
    newestTranscriptById(sessionId) ??
    path.join(os.homedir(), ".claude", "projects", encoded, sessionId + ".jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  // Backwards: the last prompt is near the end, no need to re-read it all.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let e: any;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (userPromptText(e) === null) continue;
    return parseTimestamp(e.timestamp);
  }
  return null;
}

/** Beyond this, we refuse to believe the transcript (see `resumedTurnStart`). */
export const MAX_RESUMED_TURN_MS = 6 * 60 * 60_000;

/**
 * The origin to display for a turn the server finds ALREADY RUNNING — after a
 * restart (i.e. every auto-update), the tmux agent having carried on without it.
 *
 * `turnStartedAt` lives in memory: restarting from `now` reset the stopwatch
 * while the agent had been thinking for ten minutes. The transcript, though,
 * survived — so we take its last prompt's time.
 *
 * Two deliberate refusals, because a wrong duration is worse than a reset one:
 * a timestamp in the FUTURE (the machine's clock changed in between) and a
 * prompt that is too OLD — the latter marking an already finished turn, whose
 * age we would otherwise display as a duration.
 */
export function resumedTurnStart(
  nowMs: number,
  promptAt: number | null,
  maxAgeMs = MAX_RESUMED_TURN_MS,
): number {
  if (promptAt === null) return nowMs;
  if (promptAt > nowMs) return nowMs;
  if (nowMs - promptAt > maxAgeMs) return nowMs;
  return promptAt;
}

/**
 * Finds the id of the most recent session of a directory: Claude Code
 * writes each session to ~/.claude/projects/<encoded cwd>/<session-id>.jsonl.
 */
export function findSessionId(cwd: string): string | null {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", encoded);
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? newest.f.replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}
