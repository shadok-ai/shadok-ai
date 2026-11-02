import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MAIN_GROUP_ID } from "./groups.js";
import { rowKind, LABEL_MAX } from "../context/ledger-skill/ledger-core.mjs";

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
  /** `task` | `fact` | `decision` — absent on every row recorded before it
   *  existed, which `rowKind` reads rather than rewriting them. */
  kind?: string;
  note?: string;
  source?: string;
  /** When the row was last WRITTEN. */
  updatedAt?: number;
  /** When its claim was last CONFIRMED — the freshness, which an edit must not
   *  move. Absent on older rows; `ageDays` falls back to `updatedAt`. */
  verifiedAt?: number;
  /** `group` (default when absent) = the writer's own group only; `public` = the
   *  commons. Group-private by default: a row nobody marked can never leak. */
  scope?: "group" | "public";
  /** The AUTHORING group, stamped in memory by `visibleLedger` from the file a
   *  row was read out of — never stored (the file already is the group). */
  group?: string | null;
}

/** The per-instance ledger file, keyed by the launch dir (same encoding as
 *  channels/crons). Distinct launch dirs → distinct ledgers. */
export function ledgerFileFor(cwd: string, groupId?: string | null): string {
  const enc = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  // Main / no group / mono-tenant keep the historical file: nothing migrates.
  // Every other group gets a file of its OWN, which is the whole isolation — a
  // group's agent is handed this path and cannot even address another's rows.
  const g = !groupId || groupId === MAIN_GROUP_ID ? "" : ".g-" + groupId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.homedir(), ".shadok-ai", "ledger", enc + g + ".json");
}

/**
 * What a group's agent may see: its own file, plus the PUBLIC rows of the
 * commons (the Main file). For Main itself that is just the Main file — its own
 * private rows and the public ones mirrored in by `--public`. Rows are tagged
 * with the group they were read from so `deltaSince` can filter defensively.
 */
export function visibleLedger(cwd: string, groupId: string | null): LedgerRow[] {
  const g = groupId ?? MAIN_GROUP_ID;
  const own = readRows(ledgerFileFor(cwd, g)).map((r) => ({ ...r, group: g }));
  if (g === MAIN_GROUP_ID) return own;
  const seen = new Set(own.map((r) => r.entity.toLowerCase().replace(/\s+/g, " ").trim()));
  const pub = readRows(ledgerFileFor(cwd))
    .filter((r) => r.scope === "public")
    .filter((r) => !seen.has(r.entity.toLowerCase().replace(/\s+/g, " ").trim()))
    .map((r) => ({ ...r, group: MAIN_GROUP_ID }));
  return [...own, ...pub];
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
  /** When given, keep only what that group may see: public rows (if
   *  `includePublic`) and rows it authored. A row with no `scope` is `group`. */
  visibleScope?: { groupId: string | null; includePublic: boolean },
): { rows: LedgerRow[]; total: number } {
  const visible = (r: LedgerRow): boolean =>
    !visibleScope ||
    (visibleScope.includePublic && r.scope === "public") ||
    (r.group ?? null) === visibleScope.groupId;
  const changed = rows
    .filter(visible)
    .filter((r) => (r.updatedAt ?? 0) > watermark)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { rows: changed.slice(0, cap), total: changed.length };
}

const LEDGER_HEAD = "⟦ledger · ";
/* ------------------------------------------------------------------ *
 * The block is ONE LINE, and that is a correctness requirement, not a style.
 *
 * `pilot.submit` puts the text into the TUI as a bracketed PASTE, and Claude
 * Code collapses a paste past a threshold into a `<pasted_content>` wrapper —
 * which its own system prompt tells the model is material the user pasted from
 * somewhere else, to be acted on only where the user's own message asks. With a
 * multi-line block the human's message is INSIDE that wrapper, so it stops being
 * an instruction. Measured end to end: an agent answered "your last message
 * contained only pasted text, with no request of your own alongside it… I
 * haven't acted on that line", and refused a direct order.
 *
 * Both thresholds measured against a live agent and confirmed on 486 real human
 * prompts from this machine's transcripts:
 *
 *   lines  1–3 → 0 of 324 wrapped        chars  430 on one line → not wrapped
 *   lines  4+  → ~30% of 162 wrapped     chars  910 on one line → wrapped
 *
 * The old multi-line block spent 2+ lines and put EVERY non-empty delta over
 * the cliff: 85 real prompts, 24% of those carrying a block, had the human's
 * message neutralised this way.
 *
 * Since #261 the block travels as its OWN paste, so it is judged ALONE — and
 * the rule it is judged by is the binary's own, read out of it rather than
 * bisected: `body.length <= 800 && newlines <= 2` (`var xK=800`). Two things
 * follow, and they move the budget.
 *
 *   - The cliff for the block is 800, not the 430 measured when it still had
 *     to share a prompt with the user's message. That measurement was of the
 *     WHOLE prompt and does not bound this paste.
 *   - The rule is applied PER PASTE, and we choose how many pastes there are.
 *     So 800 is not a ceiling on what the delta may carry at all: it is the
 *     size of one CHUNK. Measured on a live agent, eight chunks plus the
 *     message carried 1272 characters over nine lines with nothing wrapped and
 *     the order obeyed — a payload no single paste can deliver in the clear by
 *     any formatting.
 *
 * So the block is a LIST of one-line chunks (`formatLedgerChunks`), and what
 * bounds it is no longer the wrapper but LATENCY: every chunk must be waited
 * for before the next is pasted, or two reach the pane as one paste event and
 * the whole split is undone. That is the budget `PRELUDE_MAX_CHUNKS` spends —
 * seconds between "send" and the message leaving, on the most fragile path
 * here — and it is why no row is ever dropped for size while the DETAIL is.
 * ------------------------------------------------------------------ */

/** Marks what follows the row, inline: "and here is what happened". */
const CONT_MARK = "↳";
/** Historical multi-line blocks, still replayed out of old transcripts. */
const CONT_LINE = /^\s*↳ /;
/**
 * How much of a note reaches the block. 120 cut the first sentence of a real
 * `decision` row at 126 characters — "aucune action directe déclenchée par…",
 * whose missing complement ("par un mail") carried the whole decision, so what
 * was left could be read as its opposite. 19% of this table's notes were cut at
 * 120, 13% at 160. It stops at 160 rather than going further because a headline
 * is only ever served WHOLE (see `formatLedgerBlock`): a larger cap does not buy
 * better headlines, it buys fewer of them — the long ones stop fitting the room
 * left after the labels and are dropped entirely.
 */
const HEADLINE_MAX = 160;
/** Below this, a sentence boundary is not believed — see `headline`. */
const HEADLINE_MIN = 24;
/**
 * How many rows the block carries a HEADLINE for. Every changed row is named
 * whatever happens (see `formatLedgerChunks`); this only bounds how many of
 * them also say what happened, because that detail is what the reader can get
 * back from `ledger list` in one call.
 */
const HEADLINE_ROWS = 3;
/**
 * One paste's character bound. Claude Code keeps a paste inline only below 800
 * characters AND 2 newlines (`xK` in the binary) — and applies that PER PASTE,
 * deciding each one as it is made. So the prelude is a LIST of pastes: measured
 * on a live agent, eight chunks plus the message carried 1272 characters over
 * nine lines with nothing wrapped, which no single paste can do by any
 * formatting. 760 leaves margin under 800; a chunk holds ONE line and its
 * trailing newline, well inside the 2 the rule allows.
 */
const PASTE_MAX = 760;
/**
 * The whole prelude's bound, across every chunk. Not a formatting limit — a
 * LATENCY one: each chunk must be waited for before the next is pasted, or two
 * reach the pane as one paste event and the split is undone. So every extra
 * chunk is roughly half a second between "send" and the message leaving, on the
 * most fragile path in this codebase (the one that delivered a header twice and
 * the text nowhere for nine days). Eight chunks is the ceiling; a delta that
 * large belongs to an agent coming back from days away, which is exactly when
 * the backlog is worth the wait.
 */
const PRELUDE_MAX_CHUNKS = 8;

/**
 * The one line of the note that says WHAT happened, DERIVED rather than asked
 * for. The block used to carry `[id] entity — status` and nothing else, so the
 * entity *label* was the whole payload — and a label written as a topic name
 * ("report regeneration, 15 test accounts") cannot say what changed about it.
 * That is how work finished on the 9th was still believed pending on the 12th.
 *
 * Derived, because the alternative — a mandatory `--headline` — asks every agent
 * for writing discipline (which nothing enforces) and covers none of the rows
 * already recorded. The note's first sentence needs neither.
 */
export function headline(note: string | undefined, max: number = HEADLINE_MAX): string {
  const flat = String(note ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // A period ends a sentence only when whitespace follows it: this table is full
  // of "claude-code-2.1.285" and "PR#259 / v0.13.4", and splitting on a bare dot
  // would cut every one of them in half. And a boundary that would leave almost
  // nothing is not one — "e.g. the nightly job" is one sentence, not "e.g.".
  let first = flat;
  const bound = /[.!?](?=\s)/g;
  for (let m = bound.exec(flat); m; m = bound.exec(flat)) {
    if (m.index + 1 >= HEADLINE_MIN) {
      first = flat.slice(0, m.index + 1);
      break;
    }
  }
  first = first.trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  // Break on a word unless that would throw away most of the line.
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/** `• [id] entity — status (source)` — the part of a row the reader cannot
 *  reconstruct from anywhere else. The label is capped at render time, never in
 *  the table: `check` and `list` still print it whole, and the `[id]` stays the
 *  handle to quote (see `LABEL_MAX`). */
function bareRow(r: LedgerRow): string {
  const handle = r.id ? `[${r.id}] ` : "";
  const src = r.source ? ` (${r.source})` : "";
  // A `fact` has no lifecycle and a `decision` is not a phase of one, so the
  // reader must not take their status for a position in open → resolved.
  // `task` is the default and nearly the whole table: tagging it would be noise.
  const kind = rowKind(r);
  const tag = kind === "task" ? "" : ` · ${kind}`;
  const label =
    r.entity.length > LABEL_MAX ? r.entity.slice(0, LABEL_MAX - 1).trimEnd() + "…" : r.entity;
  return ` • ${handle}${label} — ${r.status}${tag}${src}`;
}

/**
 * What stands for the rows the budget could not name. It carries their IDS: an
 * id is the handle `record --id` takes and `check` resolves, so a reader that
 * recognises one can act on it, while `+8 more` leaves it with all of them or
 * none. The count and the list are kept HONEST apart, because the delta is
 * capped (`LEDGER_PUSH_CAP`) and `total` can exceed the rows we were handed —
 * announcing `+8 : <7 ids>` would quietly lose one.
 */
function overflowMark(rows: LedgerRow[], shown: number, total: number): string {
  const missing = total - shown;
  if (missing <= 0) return "";
  const ids = rows.slice(shown).map((r) => r.id).filter(Boolean);
  const tail = " — run: ledger list)";
  if (!ids.length) return ` • (+${missing} more${tail}`;
  if (ids.length === missing) return ` • (+${missing} : ${ids.join(" ")}${tail}`;
  return ` • (+${missing} more, ${ids.length} newest: ${ids.join(" ")}${tail}`;
}

/**
 * The delta the agent sees ahead of a prompt, as the LIST OF PASTES it travels
 * in. English (it is written into the transcript — repo side).
 *
 * The ordering rule is "never lose a row, lose the detail first", because the
 * two failures are not comparable: a row the reader is never told about is a
 * silo this feature exists to close, while a row named without its sentence is
 * one `ledger list` away. So the budget is spent in this order, and degrades in
 * the opposite one:
 *
 *   1. every changed row gets `• [id] entity — status (source)`;
 *   2. the newest `HEADLINE_ROWS` of them also get `↳ <what happened>`;
 *   3. only if even step 1 does not fit the chunk ceiling do the oldest rows
 *      collapse into the overflow mark, which still carries their IDS;
 *   4. and only when there are more of them than we hold does it fall back to
 *      a bare count.
 *
 * Each chunk is one line ending in a newline, under `PASTE_MAX`, so each is
 * judged on its own by the paste rule and stays in the clear.
 */
export function formatLedgerChunks(rows: LedgerRow[], total: number): string[] {
  const head = `${LEDGER_HEAD}${total} update${total === 1 ? "" : "s"}⟧`;
  // Step 1 + 2: what each row is worth saying. The headline is attached to the
  // newest few only — detail is the thing that degrades, and the newest rows
  // are the ones a sibling is most likely to be about to act on.
  const pieces = rows.map((r, i) => {
    const h = i < HEADLINE_ROWS ? headline(r.note) : "";
    return bareRow(r) + (h ? ` ${CONT_MARK} ${h}` : "");
  });
  // Pack greedily into one-line chunks. A row is never split across two pastes:
  // half a row in the clear and half in another reads as two rows.
  const pack = (n: number): string[] => {
    const parts = [...pieces.slice(0, n), overflowMark(rows, n, total)].filter(Boolean);
    const out: string[] = [];
    let line = head;
    for (const part of parts) {
      if (line !== head && line.length + part.length > PASTE_MAX) {
        out.push(line + "\n");
        line = "";
      }
      line += part;
    }
    if (line) out.push(line + "\n");
    return out;
  };
  // Step 3: how many rows fit at all. The ceiling is counted on the PACKED
  // result, never estimated from a character budget: greedy packing leaves a
  // chunk short whenever the next row does not fit, so the two do not agree —
  // and the quantity that costs (a wait per paste) is the chunk count.
  // Always carry at least one row: a block that announces a delta and names
  // nothing is worse than a long one.
  let kept = pieces.length;
  let chunks = pack(kept);
  while (kept > 1 && chunks.length > PRELUDE_MAX_CHUNKS) chunks = pack(--kept);
  return chunks;
}

/** The same delta as ONE string — what lands in the transcript, and what the
 *  display then strips. The pastes are concatenated by the TUI exactly like
 *  this, so this is the text, not a rendering of it. */
export function formatLedgerBlock(rows: LedgerRow[], total: number): string {
  return formatLedgerChunks(rows, total).join("").replace(/\n$/, "");
}

/** Prepend the block as its own leading line. Idempotent.
 *
 *  NOT how the block reaches a live agent any more — it goes in as a separate
 *  PASTE (`pilot.submit(text, prelude)`), which is what keeps the user's message
 *  out of the `<pasted_content>` wrapper. Kept because it is the exact shape of
 *  every transcript written before that change, which `stripLedgerBlock` must go
 *  on understanding and which the tests build from. */
export function markLedgerBlock(text: string, block: string): string {
  if (hasLedgerBlock(text)) return text;
  return `${block}\n${text}`;
}

/** Does this text open with a pushed ledger block?
 *
 *  `⟧` CLOSES the header, it no longer ENDS the line: a one-line block continues
 *  with its rows after it. Testing `endsWith` here was the first thing the
 *  one-line format broke, and it fails open — detection returns false, nothing
 *  is stripped, and the whole block is shown to the user in the chat. The old
 *  multi-line shape satisfies this test too, so replayed transcripts are
 *  unaffected. */
export function hasLedgerBlock(text: string): boolean {
  if (typeof text !== "string") return false;
  const first = text.split("\n", 1)[0];
  return first.startsWith(LEDGER_HEAD) && first.includes("⟧");
}

/** Remove a leading ledger block, leaving whatever came after (the ⟦platform⟧
 *  header and the user's message). A plain message is returned untouched.
 *
 *  The block is one line now, so that is usually all this drops — but it must
 *  keep understanding the HISTORICAL multi-line shape (header, `• ` bullets,
 *  indented `↳` headlines), because `loadHistory` replays transcripts written
 *  before the format changed and a block it fails to strip is a block the user
 *  reads in the chat. */
export function stripLedgerBlock(text: string): string {
  if (!hasLedgerBlock(text)) return text;
  const lines = text.split("\n");
  let i = 1; // drop the header line
  // A continuation chunk starts with the ` • ` of its first row, so the bullet
  // test is made on the TRIMMED line: the leading space is a separator between
  // rows, not indentation, and anchoring on it would leave every chunk but the
  // first sitting in the displayed message.
  while (i < lines.length && (lines[i].trimStart().startsWith("• ") || CONT_LINE.test(lines[i]))) i++;
  // …and the blank lines it leaves behind. The block now travels as its OWN
  // paste, so the transcript holds `</pasted_content>` and a blank line between
  // it and the ⟦platform⟧ header; `userPromptText` peels the tags but not the
  // gap. A leading blank line is not cosmetic here — `parsePromptMeta` reads the
  // FIRST line, so it would stop recognising the header, losing the sender and
  // leaving `⟦web · … · admin⟧` visible in the chat.
  return lines.slice(i).join("\n").replace(/^\n+/, "");
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
