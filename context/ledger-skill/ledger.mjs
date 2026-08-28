#!/usr/bin/env node
// shadok-ledger CLI — a tiny state table so agents verify a status before they
// assert or act on it, and record what they resolve/decide.
//
// Store: the PER-INSTANCE ledger. The server hands each agent the exact path in
// SHADOK_LEDGER_FILE at spawn (an agent's own cwd is a worktree, not the launch
// dir, so it cannot derive it); a hand-run CLI with no env falls back to the
// legacy global file. See SKILL.md and the design spec. No server involved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { upsertEntry, findEntries, ageDays, resolveId, normEntity } from "./ledger-core.mjs";

const FILE =
  (process.env.SHADOK_LEDGER_FILE || "").trim() ||
  path.join(os.homedir(), ".shadok-ai", "ledger.json");

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return []; // absent or unreadable → empty table, never a crash
  }
}

function save(rows) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE); // atomic: a concurrent reader never sees half a file
}

/** A short, unique handle (4 hex): quotable from the pushed ledger block. */
function mintId(rows) {
  const taken = new Set(rows.map((r) => r.id).filter(Boolean));
  for (let i = 0; i < 1000; i++) {
    const id = crypto.randomBytes(2).toString("hex");
    if (!taken.has(id)) return id;
  }
  return crypto.randomBytes(4).toString("hex");
}

/** `--key value` pairs → object. Values may be quoted by the shell already. */
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) out[args[i].slice(2)] = args[++i] ?? "";
  }
  return out;
}

function fmt(e, now) {
  const age = ageDays(e, now);
  const when = age <= 0 ? "today" : age === 1 ? "1d ago" : `${age}d ago`;
  const handle = e.id ? `[${e.id}] ` : "";
  const head = `• ${handle}${e.entity} — ${e.status} (${when}${e.source ? ` · ${e.source}` : ""})`;
  return e.note ? `${head}\n    ${e.note}` : head;
}

const [cmd, ...rest] = process.argv.slice(2);
const now = Date.now();

if (cmd === "check") {
  const q = rest.join(" ").trim();
  if (!q) {
    console.error('usage: ledger check "<topic or entity>"');
    process.exit(2);
  }
  const hits = findEntries(load(), q);
  if (hits.length === 0) {
    // Nothing recorded is NOT "not done" — it's UNKNOWN. Tell the agent to hedge.
    console.log(`(nothing recorded for "${q}" — treat as UNKNOWN: ask or hedge, do not assert)`);
  } else {
    console.log(hits.map((e) => fmt(e, now)).join("\n"));
  }
} else if (cmd === "record") {
  const f = parseFlags(rest);
  // Two shapes: create/supersede by --entity (+ --status), or update an existing
  // row by its --id handle (change any of status/note/source; entity optional).
  const byId = f.id != null && String(f.id).trim();
  const idHasNoFields = f.status == null && f.note == null && f.source == null && f.entity == null;
  if (byId ? idHasNoFields : !f.entity || !f.status) {
    console.error(
      'usage: ledger record --entity "<name>" --status <resolved|open|in-progress|decided> [--note "<line>"] [--source "<ref>"]\n' +
        '   or: ledger record --id <handle> [--status <…>] [--note "<line>"] [--source "<ref>"]',
    );
    process.exit(2);
  }
  const rows0 = load();
  let rows;
  try {
    rows = upsertEntry(
      rows0,
      { id: f.id, entity: f.entity, status: f.status, note: f.note, source: f.source },
      now,
      mintId(rows0),
    );
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
  save(rows);
  const row = byId ? resolveId(rows, f.id) : rows.find((r) => normEntity(r.entity) === normEntity(f.entity));
  console.log(`recorded: ${row.entity} — ${row.status} [${row.id}]`);
} else if (cmd === "list") {
  const rows = findEntries(load(), "");
  console.log(rows.length ? rows.map((e) => fmt(e, now)).join("\n") : "(ledger empty)");
} else {
  console.error("usage: ledger <check|record|list> …");
  process.exit(2);
}
