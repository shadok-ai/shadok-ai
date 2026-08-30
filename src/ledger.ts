import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Server side of the shared ledger. Two jobs the `shadok-ledger` skill's own
 * core (context/ledger-skill/ledger-core.mjs) does NOT do:
 *
 *  1. Locate the PER-INSTANCE ledger file. The skill writes it, the server reads
 *     it and hands agents its path; both key it by the launch dir, like channels
 *     and crons. (The skill runs inside an agent whose cwd is a worktree, so it
 *     cannot derive the launch dir itself — the server passes SHADOK_LEDGER_FILE
 *     at spawn.)
 *  2. Build the DELTA block pushed ahead of each human prompt: the rows changed
 *     since this agent last saw the ledger, so sibling agents learn what was
 *     resolved/decided in near-real-time without having to `check`. The block is
 *     prepended to the submitted text (like the ⟦platform⟧ prompt-meta header)
 *     and stripped from the display on replay — the agent sees it, the chat
 *     doesn't. Because a delta is usually empty, most prompts carry nothing.
 */

export interface LedgerRow {
  id?: string;
  entity: string;
  status: string;
  note?: string;
  source?: string;
  updatedAt?: number;
}

/** The per-instance ledger file, keyed by the launch dir (same encoding as
 *  channels/crons). Distinct launch dirs → distinct ledgers. */
export function ledgerFileFor(cwd: string): string {
  const enc = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".shadok-ai", "ledger", enc + ".json");
}

/** The legacy single-file ledger, before it was scoped per instance. */
export function legacyLedgerFile(): string {
  return path.join(os.homedir(), ".shadok-ai", "ledger.json");
}

function readRows(file: string): LedgerRow[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** A short id: 4 hex chars, not already taken. The ledger is tiny per instance,
 *  so 16 bits is ample; a durable, quotable handle for update-by-id. */
export function mintLedgerId(taken: ReadonlySet<string>): string {
  for (let i = 0; i < 1000; i++) {
    const id = crypto.randomBytes(2).toString("hex");
    if (!taken.has(id)) return id;
  }
  // Astronomically unlikely for a table this size; widen rather than loop forever.
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Make sure THIS instance has its own ledger file, and that every row carries an
 * id (the durable handle). Called at boot. Seeds the scoped file from the legacy
 * single-file ledger the first time (so nothing already recorded is lost), then
 * backfills any id-less rows. Idempotent and best-effort — a failure here must
 * never break the boot.
 */
export function ensureLedgerFile(cwd: string): void {
  try {
    const file = ledgerFileFor(cwd);
    let rows: LedgerRow[];
    if (fs.existsSync(file)) {
      rows = readRows(file);
    } else {
      // Seed from the legacy global ledger if present (COPY, not move — a second
      // instance on the same machine seeds its own from the same source, then
      // the two diverge, which is the point of per-instance).
      rows = fs.existsSync(legacyLedgerFile()) ? readRows(legacyLedgerFile()) : [];
    }
    const taken = new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
    let changed = !fs.existsSync(file);
    for (const r of rows) {
      if (!r.id) {
        r.id = mintLedgerId(taken);
        taken.add(r.id);
        changed = true;
      }
    }
    if (changed) writeRows(file, rows);
  } catch {
    /* boot must not depend on the ledger */
  }
}

function writeRows(file: string, rows: LedgerRow[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read the rows of a ledger file (empty on any error). */
export function loadLedger(file: string): LedgerRow[] {
  return readRows(file);
}

/** The rows changed since `watermark`, newest-first, capped at `cap`. `total` is
 *  the full count of changed rows (may exceed `rows.length` when capped). */
export function deltaSince(
  rows: LedgerRow[],
  watermark: number,
  cap: number,
): { rows: LedgerRow[]; total: number } {
  const changed = rows
    .filter((r) => (r.updatedAt ?? 0) > watermark)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { rows: changed.slice(0, cap), total: changed.length };
}

const LEDGER_HEAD = "⟦ledger · ";

/** The delta block the agent sees ahead of a human prompt. English (it is
 *  written into the transcript — repo side). One line per row: `• [id] entity —
 *  status (source)`; an overflow line when capped. */
export function formatLedgerBlock(rows: LedgerRow[], total: number): string {
  const head = `${LEDGER_HEAD}${total} update${total === 1 ? "" : "s"} since your last message⟧`;
  const lines = rows.map((r) => {
    const handle = r.id ? `[${r.id}] ` : "";
    const src = r.source ? ` (${r.source})` : "";
    return `• ${handle}${r.entity} — ${r.status}${src}`;
  });
  if (rows.length < total) lines.push(`• (+${total - rows.length} more — run: ledger list)`);
  return [head, ...lines].join("\n");
}

/** Prepend the block as its own leading lines. Idempotent. */
export function markLedgerBlock(text: string, block: string): string {
  if (hasLedgerBlock(text)) return text;
  return `${block}\n${text}`;
}

/** Does this text open with a pushed ledger block? */
export function hasLedgerBlock(text: string): boolean {
  if (typeof text !== "string") return false;
  const first = text.split("\n", 1)[0];
  return first.startsWith(LEDGER_HEAD) && first.endsWith("⟧");
}

/** Remove a leading ledger block — its header line and the contiguous `• ` bullet
 *  lines that follow it — leaving whatever came after (e.g. the ⟦platform⟧ header
 *  and the user's message). A plain message is returned untouched. */
export function stripLedgerBlock(text: string): string {
  if (!hasLedgerBlock(text)) return text;
  const lines = text.split("\n");
  let i = 1; // drop the header line
  while (i < lines.length && lines[i].startsWith("• ")) i++;
  return lines.slice(i).join("\n");
}

/* ------------------------------------------------------------------ *
 * The per-agent watermark: "what had this agent already seen?"
 *
 * It used to live only in memory, on the `Live`, anchored to the attach
 * instant. A `Live` is rebuilt on every server restart — i.e. on every
 * auto-update — and again whenever a dormant channel is woken, so the
 * watermark jumped to "now" and the next delta came back EMPTY. Measured on a
 * real instance: of the pushes that were due, roughly two in three never
 * arrived, and the misses clustered exactly on merge times — a merge publishes,
 * the instance updates, every watermark resets, and the very burst of ledger
 * activity that merge produced is what gets swallowed.
 *
 * So it is written down, next to the table it tracks and keyed the same way.
 * An agent with no record is NEW and still anchors to now (no history flood);
 * an agent that has one gets its backlog, bounded by the push cap.
 * ------------------------------------------------------------------ */

/** Where this instance stores its agents' ledger watermarks. Beside the table,
 *  same launch-dir encoding, distinct name — writing one must never clobber the
 *  other. */
export function ledgerSeenFileFor(cwd: string): string {
  const enc = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".shadok-ai", "ledger", enc + "-seen.json");
}

function readSeenMap(file: string): Record<string, number> {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === "number" && isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * The moment this agent last saw the ledger, or `undefined` if it never has.
 * The two are DIFFERENT answers and the caller acts on the difference: no
 * record means a fresh agent, which anchors to now rather than replaying the
 * whole table (0 would do exactly that).
 */
export function seenFor(file: string, sessionId: string): number | undefined {
  const v = readSeenMap(file)[sessionId];
  return typeof v === "number" ? v : undefined;
}

/**
 * Keep the map bounded: drop agents that no longer exist (`keep` is the live
 * channel list), never drop the one being written — a spawn can race its own
 * channel upsert, and losing that entry would re-anchor it to now — and cap the
 * rest newest-first as a backstop when there is no list to compare against.
 * Pure.
 */
export function pruneSeen(
  map: Record<string, number>,
  keep: ReadonlySet<string> | undefined,
  current: string,
  cap: number,
): Record<string, number> {
  const kept = Object.entries(map).filter(([id]) => id === current || !keep || keep.has(id));
  kept.sort((a, b) => (a[0] === current ? -1 : b[0] === current ? 1 : b[1] - a[1]));
  return Object.fromEntries(kept.slice(0, cap));
}

/** Highest number of agent watermarks kept. Well above any plausible channel
 *  count; only a missing channel list can ever make it bite. */
const SEEN_CAP = 200;

/**
 * Write this agent's watermark. Best-effort and atomic: a lost write costs a
 * duplicated block on the next prompt, never a swallowed one, so it must never
 * be able to break a turn.
 */
export function recordSeen(
  file: string,
  sessionId: string,
  at: number,
  keep?: ReadonlySet<string>,
): void {
  try {
    const map = readSeenMap(file);
    map[sessionId] = at;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(pruneSeen(map, keep, sessionId, SEEN_CAP), null, 2), {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    /* a turn must never fail over a watermark */
  }
}
