import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Token counts of one assistant API message (`message.usage` in the .jsonl). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * A streamed piece of an assistant turn, read from the session .jsonl.
 *
 * `at` is the moment Claude Code WROTE the block (the line's `timestamp`), not
 * the moment we read it. The distinction matters: the tail resumes at its
 * persisted offset after a restart (invariant #7), so a burst of blocks written
 * while it was down arrives at once — timestamping them at read time would date
 * them all "now". Absent when the line carries none (fixtures, old
 * transcripts).
 */
export type TailEvent =
  | { kind: "text"; text: string; at?: number }
  // `id`/`toolUseId` let a consumer pair an output with the call that produced
  // it. Necessary because one assistant message may carry several tool_use
  // blocks (parallel calls) whose results come back batched and out of order.
  | { kind: "tool"; id: string; name: string; summary: string; at?: number }
  | { kind: "result"; toolUseId: string; text: string; isError: boolean; at?: number }
  | { kind: "usage"; messageId: string; usage: TokenUsage };

/** Max characters of a tool result to stream (long outputs are truncated). */
const MAX_RESULT = 4000;

/**
 * Path of the .jsonl transcript Claude Code writes for a session.
 *
 * The obvious path is `<encoded cwd>/<id>.jsonl`, but Claude derives the
 * encoded dir from the cwd it was LAUNCHED with. After a repo/worktree move
 * (or the shadok-ai rename) a still-running agent keeps writing under its
 * original encoded dir, which no longer matches the current cwd — so the tail
 * would watch a stale file and nothing streams. To be immune to that drift we
 * prefer the newest `<id>.jsonl` found anywhere under ~/.claude/projects; the
 * file being actively appended is always the newest. Falls back to the
 * cwd-derived path for a brand-new session whose file doesn't exist yet.
 */
export function sessionFilePath(cwd: string, sessionId: string): string {
  const newest = newestTranscriptById(sessionId);
  if (newest) return newest;
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded, sessionId + ".jsonl");
}

/** The most-recently-modified `<id>.jsonl` across all project dirs, or null. */
export function newestTranscriptById(sessionId: string): string | null {
  const root = path.join(os.homedir(), ".claude", "projects");
  let best: string | null = null;
  let bestMtime = -1;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(root, d, sessionId + ".jsonl");
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = f;
      }
    } catch {
      /* no such file in this dir */
    }
  }
  return best;
}

/** One-line summary of a tool_use block (e.g. `Read auth.ts`, `Bash: npm test`). */
function toolSummary(input: any): string {
  if (!input || typeof input !== "object") return "";
  const v =
    input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? input.description;
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

/**
 * Tails a session .jsonl: watches for appended lines and yields the assistant
 * `text` and `tool_use` blocks as they are written — the authoritative,
 * untruncated content, streamed at message granularity.
 *
 * `onEvent` fires for each new block. Returns a stop() function.
 * Starts from the current end of file, so only NEW turns are streamed
 * (existing history is replayed separately via loadHistory).
 */
/** Beyond this backlog we give up catching up: a tmux agent that worked for
 *  hours with no server would dump a wall of text in one go. */
export const MAX_CATCHUP = 1024 * 1024;

/**
 * Where to start reading the transcript. Pure — this is what the tests pin.
 *
 * Starting at the end (the old unconditional behaviour) SILENTLY lost
 * everything an agent wrote while no server was up — which happens on every
 * auto-update, hence on every merge to main. The web recovered (it reloads
 * history); Telegram did not: the message simply never existed.
 */
export function startOffset(size: number, stored: number | null, maxCatchUp = MAX_CATCHUP): number {
  if (stored === null) return size; // brand-new session: do not replay a resumed transcript
  if (stored > size) return 0; // file truncated or replaced: the position is meaningless
  if (size - stored > maxCatchUp) return size; // too far behind (see MAX_CATCHUP)
  return stored;
}

/** How far the tail got, one per session. The session id is a UUID: a short,
 *  collision-free name, where encoding the transcript's path would exceed the
 *  maximum length of a filename component. */
const TAIL_POS_DIR = path.join(os.homedir(), ".shadok-ai", "tail");
const posFile = (file: string) => path.join(TAIL_POS_DIR, path.basename(file, ".jsonl") + ".pos");

function readPos(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(posFile(file), "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null; // never stored, or unreadable: start from the end
  }
}

function writePos(file: string, pos: number): void {
  try {
    fs.mkdirSync(TAIL_POS_DIR, { recursive: true });
    fs.writeFileSync(posFile(file), String(pos));
  } catch {
    // Losing the resume point is an annoyance; never a reason to break the tail.
  }
}

/** Forget a finished session's position — it has nothing left to resume. */
export function clearTailPos(file: string): void {
  try {
    fs.unlinkSync(posFile(file));
  } catch {
    // missing: nothing to do
  }
}

export function tailSession(
  file: string,
  onEvent: (e: TailEvent) => void,
  intervalMs = 250,
  /** Re-resolves the transcript path so the tail FOLLOWS the file if it moves
   *  to another project dir mid-session (an agent switching git worktree changes
   *  its cwd, and Claude Code re-homes the .jsonl). Without this the tail keeps
   *  watching the stale path and recent messages never reach the chat. */
  resolve?: () => string,
): () => void {
  let pos = 0;
  try {
    pos = startOffset(fs.statSync(file).size, readPos(file));
  } catch {
    pos = 0; // file not written yet (new session) — stream from the start
  }
  let buf = "";
  let stopped = false;
  let tick = 0;

  const read = () => {
    if (stopped) return;
    // Follow the transcript across a cwd change (~every 1s). The moved file is
    // the same transcript, longer — bytes up to `pos` are identical — so we keep
    // the offset and just keep reading appended lines from the new path.
    if (resolve && tick++ % 4 === 0) {
      try {
        const latest = resolve();
        if (latest && latest !== file) file = latest;
      } catch {
        /* transient — retry next tick */
      }
    }
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // file not there yet
    }
    if (size < pos) {
      // File shrank/rotated (rare) — reset.
      pos = 0;
      buf = "";
    }
    if (size === pos) return;
    let chunk = "";
    try {
      const fd = fs.openSync(file, "r");
      try {
        const b = Buffer.alloc(size - pos);
        const n = fs.readSync(fd, b, 0, b.length, pos);
        chunk = b.toString("utf8", 0, n);
        pos += n;
        // Stored on every read (so only once content has been consumed):
        // that is what makes resuming after a restart possible.
        writePos(file, pos);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      emitLine(line, onEvent);
    }
  };

  const timer = setInterval(read, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function emitLine(line: string, onEvent: (e: TailEvent) => void) {
  for (const ev of parseLine(line)) onEvent(ev);
}

/**
 * An agent MUST answer something, so a cron that detected nothing has no way to
 * stay silent. The `NOTHING TO SHOW` convention gives it one — that block is
 * neither streamed nor replayed (see `loadHistory`), so nothing shows up in the
 * web or in Telegram. Documented in `context/pilot-prompt.md`.
 *
 * Deliberately STRICT: the sentinel must be the WHOLE block (emphasis and a
 * trailing period tolerated). An agent explaining the convention in a sentence
 * does not get muzzled — invariant 2 is the reminder of what an over-broad
 * heuristic has already cost here.
 */
const NOTHING_TO_SHOW = /^[*_`\s]*nothing to show[*_`\s.!]*$/i;
export function isNothingToShow(text: string): boolean {
  return NOTHING_TO_SHOW.test(text);
}

/**
 * Pure parser for one transcript line → the events it yields. Exported for
 * tests; `tailSession` streams these live. Returns [] for anything that isn't
 * a streamable assistant/user event.
 */
export function parseLine(line: string): TailEvent[] {
  if (!line.trim()) return [];
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  if (e.isMeta || !Array.isArray(e.message?.content)) return [];
  const out: TailEvent[] = [];
  // Spread: the key stays ABSENT when the line has no timestamp, rather than
  // present as `undefined` (a consumer cannot confuse the two).
  const at = parseTimestamp(e.timestamp);
  const when = at === null ? {} : { at };

  if (e.type === "assistant") {
    const usage = parseUsage(e.message);
    if (usage) out.push({ kind: "usage", messageId: e.message.id ?? e.uuid, usage });
    for (const block of e.message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        if (isNothingToShow(block.text)) continue; // nothing to report: show nothing
        out.push({ kind: "text", text: block.text, ...when });
      } else if (block?.type === "tool_use" && typeof block.name === "string") {
        out.push({
          kind: "tool",
          id: typeof block.id === "string" ? block.id : "",
          name: block.name,
          summary: toolSummary(block.input),
          ...when,
        });
      }
      // `thinking` blocks are intentionally skipped.
    }
  } else if (e.type === "user") {
    // User events carry tool results (command output, file reads…). The real
    // user prompt is echoed by the server itself, so only results are emitted.
    for (const block of e.message.content) {
      if (block?.type !== "tool_result") continue;
      const text = resultText(block.content);
      if (text) {
        out.push({
          kind: "result",
          toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          text,
          isError: !!block.is_error,
          ...when,
        });
      }
    }
  }
  return out;
}

/**
 * ISO timestamp of a transcript line → ms epoch, or null when missing /
 * unreadable. Shared with `loadHistory` (extract.ts) so the displayed time is
 * the same whether history is replayed or the live stream is followed.
 */
export function parseTimestamp(v: any): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export function parseUsage(message: any): TokenUsage | null {
  const u = message?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

/**
 * Sums the token usage already written to a transcript, keyed by message id.
 * Streaming writes several records per message with the same id and growing
 * counts — keeping the last record per id yields each message's final usage.
 */
export function scanUsage(file: string): Map<string, TokenUsage> {
  const map = new Map<string, TokenUsage>();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return map; // new session: nothing written yet
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "assistant") continue;
    const usage = parseUsage(e.message);
    if (usage) map.set(e.message.id ?? e.uuid, usage);
  }
  return map;
}

/** Flattens a tool_result's content (string or block array) to display text. */
export function resultText(content: any): string {
  let s = "";
  if (typeof content === "string") s = content;
  else if (Array.isArray(content))
    s = content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  s = s.trimEnd();
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + "\n… (truncated)" : s;
}
