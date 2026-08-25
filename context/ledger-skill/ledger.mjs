#!/usr/bin/env node
// shadok-ledger CLI — a tiny state table so agents verify a status before they
// assert or act on it. Store: ~/.shadok-ai/ledger.json (per instance, NOT the
// repo). See SKILL.md and the design spec. No server involved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertEntry, findEntries, ageDays } from "./ledger-core.mjs";

const FILE = path.join(os.homedir(), ".shadok-ai", "ledger.json");

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
  const head = `• ${e.entity} — ${e.status} (${when}${e.source ? ` · ${e.source}` : ""})`;
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
  if (!f.entity || !f.status) {
    console.error('usage: ledger record --entity "<name>" --status <resolved|open|in-progress|decided> [--note "<line>"] [--source "<ref>"]');
    process.exit(2);
  }
  const rows = upsertEntry(load(), { entity: f.entity, status: f.status, note: f.note, source: f.source }, now);
  save(rows);
  console.log(`recorded: ${f.entity} — ${f.status}`);
} else if (cmd === "list") {
  const rows = findEntries(load(), "");
  console.log(rows.length ? rows.map((e) => fmt(e, now)).join("\n") : "(ledger empty)");
} else {
  console.error("usage: ledger <check|record|list> …");
  process.exit(2);
}
