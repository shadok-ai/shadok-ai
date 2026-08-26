import fs from "node:fs";
import path from "node:path";

/**
 * Follow a session when Claude Code forks its transcript id mid-flight.
 *
 * A shadok channel keys the tail to a fixed session id. But when a session's
 * context overflows ("Prompt is too long"), the live `claude` can continue under
 * a NEW session id — a fresh `<newid>.jsonl` — leaving `<oldid>.jsonl` frozen.
 * The tail then reads the frozen file and the chat stops updating while the TUI
 * is fine.  See docs/superpowers/specs/2026-08-26-follow-forked-transcript-design.md.
 *
 * How the new file is identified — SAFELY, given agents can share a cwd (all of
 * them in one container's /workspace, so "the newest .jsonl in the cwd" would
 * adopt a SIBLING agent's transcript):
 *
 * Every Claude Code transcript record carries TWO ids. `sessionId` (camelCase)
 * is the file's OWN id (= its filename). `session_id` (snake_case) is the
 * lineage ROOT — the id of the FIRST session in a compaction/fork chain, and it
 * stays constant across every fork. So for the original session snake == own id;
 * for a fork, snake == the original's id while the own id is new. A SIBLING
 * agent's file has snake == its own id, which never equals our root. Matching on
 * that root is therefore the reliable, cross-platform link (no /proc, works on
 * macOS): the fork is the newest file in the same directory whose root matches
 * ours but whose own id differs from the one we tail.
 *
 * An earlier design read the file the pane's process held open via /proc. It was
 * abandoned: Claude Code opens-appends-closes the transcript per write rather
 * than holding it open, so a periodic fd scan almost always sees nothing.
 */

/** A `session_id` / `sessionId` value is a v4 UUID (36 chars). */
const UUID = "[0-9a-fA-F-]{36}";

/** Pure: the lineage-ROOT id from a chunk of transcript JSONL — Claude Code's
 *  snake_case `session_id`. Returns the first match, or null. */
export function rootIdFromChunk(chunk: string): string | null {
  const m = new RegExp(`"session_id"\\s*:\\s*"(${UUID})"`).exec(chunk);
  return m ? m[1] : null;
}

/** Pure: the session (own) id from a transcript FILENAME, or null. */
export function idFromTranscriptName(name: string): string | null {
  const m = new RegExp(`^(${UUID})\\.jsonl$`).exec(name);
  return m ? m[1] : null;
}

/** Pure: among transcript candidates `{id, mtime, root}`, the one to FOLLOW —
 *  the newest whose lineage `root` matches `myRoot` and whose own `id` differs
 *  from the id we currently tail — or null when none qualifies.
 *
 *  Same-lineage only (root match) so a sibling agent sharing the cwd is never
 *  adopted. Newest so a multi-step fork chain (A→B→C, all rooted at A) jumps
 *  straight to the live tip rather than to an intermediate frozen file. */
export function forkTarget(
  candidates: { id: string; mtime: number; root: string | null }[],
  tailId: string,
  myRoot: string,
): string | null {
  let best: string | null = null;
  let bestMtime = -Infinity;
  for (const c of candidates) {
    if (c.id === tailId || c.root !== myRoot) continue;
    if (c.mtime > bestMtime) {
      best = c.id;
      bestMtime = c.mtime;
    }
  }
  return best;
}

/** Read the lineage-root of a transcript file (bounded head read — the snake
 *  `session_id` appears on the early carried/user records). null on any error.
 *  Head-only because a live transcript can be many MB and we only need one id. */
export function rootIdOfFile(file: string, maxBytes = 1 << 20): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (len === 0) return null;
    const b = Buffer.alloc(len);
    const n = fs.readSync(fd, b, 0, len, 0);
    return rootIdFromChunk(b.toString("utf8", 0, n));
  } catch {
    return null;
  } finally {
    if (fd != null)
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
  }
}

/**
 * Scan the directory of `myFile` for a live fork of the session rooted at
 * `myRoot` that we currently tail as `tailId`. Returns the new id, or null.
 *
 * Only files strictly NEWER than `myFile` are parsed for their root: the fork
 * post-dates the freeze of the file we read, and while the agent works normally
 * ITS file is the newest, so the common no-fork case costs one readdir + a stat
 * per sibling and never opens a transcript. `[]`/no match → null.
 */
export function detectFork(
  myFile: string,
  tailId: string,
  myRoot: string,
  /** Ids we have already tailed and left. A dead transcript's mtime should never
   *  advance, but if it ever did (an external touch, a manual resume) we must not
   *  oscillate back onto it — so a followed id is excluded from then on. */
  seen: ReadonlySet<string> = new Set(),
): string | null {
  let myMtime: number;
  try {
    myMtime = fs.statSync(myFile).mtimeMs;
  } catch {
    return null; // our own file vanished — nothing to reason about
  }
  const dir = path.dirname(myFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates: { id: string; mtime: number; root: string | null }[] = [];
  for (const name of names) {
    const id = idFromTranscriptName(name);
    if (!id || id === tailId || seen.has(id)) continue;
    const f = path.join(dir, name);
    let mtime: number;
    try {
      mtime = fs.statSync(f).mtimeMs;
    } catch {
      continue; // vanished mid-scan
    }
    if (mtime <= myMtime) continue; // the fork is newer than the frozen file
    candidates.push({ id, mtime, root: rootIdOfFile(f) });
  }
  return forkTarget(candidates, tailId, myRoot);
}
