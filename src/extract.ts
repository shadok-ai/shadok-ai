import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newestTranscriptById, isNothingToShow, parseTimestamp } from "./tail.js";
import { isCronPrompt } from "./crons.js";

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
 * Le texte d'une ligne de transcript SI c'est un vrai prompt humain, sinon null.
 *
 * Une ligne `type: "user"` n'est pas forcément quelqu'un qui parle : Claude Code
 * y écrit aussi les résultats d'outils, les rappels système (`<…>`) et les
 * interruptions. La règle était recopiée à l'identique dans `loadHistory` et
 * `sessionPreview` ; elle vit ici pour qu'un troisième appelant ne la redérive
 * pas de travers (l'un d'eux compte les tours, l'autre datait les tours).
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
   * Moment où le tour a été écrit (ms epoch), repris du `timestamp` de la ligne
   * .jsonl. Même source que `TailEvent.at`, donc un tour rejoué et le même tour
   * vu en direct affichent la MÊME heure. Absent sur les vieux transcripts.
   */
  at?: number;
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
      if (text === null) continue; // résultat d'outil, rappel système, interruption
      // Prompt programmé : il n'est pas montré en direct, il ne doit pas
      // réapparaître à la relecture (rechargement web, backfill d'un topic).
      if (isCronPrompt(text)) continue;
      turns.push({ role: "user", text, ...when });
    } else if (e.type === "assistant" && Array.isArray(e.message.content)) {
      const text = e.message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        // Même filtre bloc à bloc que le tail, sinon la sentinelle réapparaît
        // au rechargement de la page alors qu'elle n'a jamais été streamée.
        .filter((t: any) => typeof t === "string" && !isNothingToShow(t))
        .join("\n")
        .trim();
      if (!text) continue;
      const last = turns[turns.length - 1];
      // Blocs consécutifs fusionnés en un seul tour : on GARDE l'heure du
      // premier, c'est celle du début de la prise de parole (et c'est là que le
      // client affiche le label du groupe).
      if (last && last.role === "assistant") last.text += "\n\n" + text;
      else turns.push({ role: "assistant", text, ...when });
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
 * Quand le dernier VRAI prompt de la session a été écrit (ms epoch), ou null.
 *
 * C'est l'origine du tour en cours : un tour commence par un prompt (humain,
 * cron, ou pilotage d'un autre client) et se termine quand l'agent se tait. On
 * ignore donc les lignes `user` techniques — un résultat d'outil arrive EN COURS
 * de tour et daterait l'origine quelques secondes avant maintenant.
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
  // À rebours : le dernier prompt est proche de la fin, inutile de tout relire.
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

/** Au-delà, on refuse de croire le transcript (cf. `resumedTurnStart`). */
export const MAX_RESUMED_TURN_MS = 6 * 60 * 60_000;

/**
 * Origine à afficher pour un tour que le serveur retrouve DÉJÀ EN COURS — après
 * un redémarrage (chaque auto-update), l'agent tmux ayant continué sans lui.
 *
 * `turnStartedAt` vit en mémoire : repartir de `now` remettait le chrono à zéro
 * alors que l'agent réfléchissait depuis dix minutes. Le transcript, lui, a
 * survécu — on reprend l'heure de son dernier prompt.
 *
 * Deux refus délibérés, parce qu'une durée fausse est pire qu'une durée remise à
 * zéro : un horodatage dans le FUTUR (horloge de la machine changée entre-temps)
 * et un prompt trop VIEUX — ce dernier cas signant un tour déjà terminé dont on
 * afficherait sinon l'âge, pas la durée.
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
