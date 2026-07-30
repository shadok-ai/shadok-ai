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
 * the moment we read it. La distinction compte : le tail reprend à son offset
 * persisté après un redémarrage (invariant #7), donc une rafale de blocs écrits
 * pendant l'arrêt arrive d'un coup — les horodater à la lecture les daterait
 * tous « maintenant ». Absent si la ligne n'en porte pas (fixtures, vieux
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
/** Au-delà de ce retard, on renonce à rattraper : un agent tmux qui a travaillé
 *  des heures sans serveur déverserait un mur de texte d'un coup. */
export const MAX_CATCHUP = 1024 * 1024;

/**
 * Où commencer à lire le transcript. Pure — c'est elle qui porte les tests.
 *
 * Démarrer à la fin (l'ancien comportement inconditionnel) faisait perdre en
 * SILENCE tout ce qu'un agent écrivait pendant qu'un serveur n'était pas là —
 * ce qui arrive à chaque auto-update, donc à chaque merge sur main. Le web s'en
 * remettait (il recharge l'historique) ; Telegram, non : le message n'existait
 * simplement jamais.
 */
export function startOffset(size: number, stored: number | null, maxCatchUp = MAX_CATCHUP): number {
  if (stored === null) return size; // session neuve : ne pas rejouer un transcript repris
  if (stored > size) return 0; // fichier tronqué ou remplacé : la position n'a plus de sens
  if (size - stored > maxCatchUp) return size; // trop de retard (cf. MAX_CATCHUP)
  return stored;
}

/** Position atteinte par le tail, une par session. L'id de session est un UUID :
 *  nom court et sans collision, là où encoder le chemin du transcript
 *  dépasserait la longueur maximale d'un composant de nom de fichier. */
const TAIL_POS_DIR = path.join(os.homedir(), ".shadok-ai", "tail");
const posFile = (file: string) => path.join(TAIL_POS_DIR, path.basename(file, ".jsonl") + ".pos");

function readPos(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(posFile(file), "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null; // jamais mémorisé, ou illisible : on repart de la fin
  }
}

function writePos(file: string, pos: number): void {
  try {
    fs.mkdirSync(TAIL_POS_DIR, { recursive: true });
    fs.writeFileSync(posFile(file), String(pos));
  } catch {
    // Perdre la reprise est un désagrément ; jamais de quoi casser le tail.
  }
}

/** Oublie la position d'une session terminée — elle n'a plus rien à reprendre. */
export function clearTailPos(file: string): void {
  try {
    fs.unlinkSync(posFile(file));
  } catch {
    // absente : rien à faire
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
        // Mémorisé à chaque lecture (donc seulement quand du contenu a été
        // consommé) : c'est ce qui permet de reprendre après un redémarrage.
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
 * Un agent DOIT répondre quelque chose : un cron qui n'a rien détecté n'a donc
 * aucun moyen de se taire. La convention `NOTHING TO SHOW` lui en donne un —
 * ce bloc n'est ni streamé ni rejoué (cf. `loadHistory`), donc rien n'apparaît
 * ni dans le web ni dans Telegram. Documentée dans `context/pilot-prompt.md`.
 *
 * Volontairement STRICT : la sentinelle doit constituer TOUT le bloc (emphase
 * et point final tolérés). Un agent qui explique la convention dans une phrase
 * ne se fait pas museler — l'invariant 2 rappelle ce qu'une heuristique trop
 * large a déjà coûté ici.
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
  // Spread : la clé reste ABSENTE quand la ligne n'a pas d'horodatage, plutôt
  // que présente à `undefined` (un consommateur ne peut pas confondre les deux).
  const at = parseTimestamp(e.timestamp);
  const when = at === null ? {} : { at };

  if (e.type === "assistant") {
    const usage = parseUsage(e.message);
    if (usage) out.push({ kind: "usage", messageId: e.message.id ?? e.uuid, usage });
    for (const block of e.message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        if (isNothingToShow(block.text)) continue; // rien à signaler : on n'affiche rien
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
 * ISO timestamp d'une ligne de transcript → ms epoch, ou null si absent /
 * illisible. Partagé avec `loadHistory` (extract.ts) pour que l'heure affichée
 * soit la même qu'on rejoue l'historique ou qu'on suive le direct.
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
