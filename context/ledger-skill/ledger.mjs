#!/usr/bin/env node
// shadok-ledger CLI — a tiny state table so agents verify a status before they
// assert or act on it, and record what they resolve/decide.
//
// Store: ONE ledger table per instance, owned by the server. On an instance,
// `record`/`check`/`list` go THROUGH the server (POST /ledger/record, GET
// /ledger), authenticated with the per-session key — exactly like the
// `shadok-secrets` skill reaches the vault. The server stamps the row's
// AUTHORING GROUP from the session (never from here) and filters reads to that
// group ∪ public, so a group's private rows never leak and no write crosses the
// OS-user wall (the file lives 0600 in the server HOME).
//
// FALLBACK: with no server reachable (a hand-run CLI, or a mono-tenant instance
// with no port/key), it reads and writes the local file directly —
// SHADOK_LEDGER_FILE if the server handed one, else the legacy global file.
// Nothing about the single-group / off-server case changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { upsertEntry, searchEntries, ageDays, resolveId, normEntity, rowKind, KINDS, LABEL_MAX } from "./ledger-core.mjs";

const PORT = (process.env.SHADOK_PORT || "").trim();
const KEY = (process.env.SHADOK_SESSION_KEY || "").trim();
const AUTH = (process.env.SHADOK_AUTH || "").trim();
// On-server: a port AND a session key. The key is what proves WHICH agent calls,
// and it is what the server scopes the authoring group by — without it there is
// no identity, so we fall back to the local file.
const useServer = !!PORT && !!KEY;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 15_000;

const FILE =
  (process.env.SHADOK_LEDGER_FILE || "").trim() ||
  path.join(os.homedir(), ".shadok-ai", "ledger.json");

function loadFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return []; // absent or unreadable → empty table, never a crash
  }
}

function saveFile(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic: a concurrent reader never sees half a file
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

/** Call the server. Exits with a clear message on a transport/HTTP failure —
 *  the same shape as the secrets skill. */
async function api(method, p, body) {
  let res;
  try {
    res = await fetch(BASE + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(AUTH ? { Cookie: AUTH } : {}),
        // The durable credential: the cookie in the env expires after a week,
        // the session key does not (invariant 33).
        ...(KEY ? { "x-shadok-session-key": KEY } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.error(`cannot reach the cockpit on ${BASE}: ${e.message}`);
    process.exit(1);
  }
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try {
      msg = JSON.parse(raw).error ?? msg;
    } catch {
      /* non-JSON body — keep the raw slice */
    }
    console.error(`ledger API error ${res.status}: ${msg}`);
    process.exit(1);
  }
  return raw ? JSON.parse(raw) : {};
}

/** Flags that take NO value, listed rather than guessed: inferring "the next arg
 *  starts with -- so this one is a boolean" would misread `--note "--foo"`. */
const BOOL_FLAGS = new Set(["verified", "public"]);

/** `--key value` pairs → object. Values may be quoted by the shell already. */
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    out[key] = BOOL_FLAGS.has(key) ? true : (args[++i] ?? "");
  }
  return out;
}

function fmt(e, now) {
  const age = ageDays(e, now);
  const when = age <= 0 ? "today" : age === 1 ? "1d ago" : `${age}d ago`;
  const kind = rowKind(e);
  // Say "verified" wherever the two clocks have parted company — and always for
  // a fact, whose whole state IS its freshness. A bare age next to a row last
  // confirmed a month ago but reworded yesterday is the lie this removes.
  const parted = e.verifiedAt && e.updatedAt && e.verifiedAt !== e.updatedAt;
  const stamp = kind === "fact" || parted ? `verified ${when}` : when;
  // `task` is the default and the overwhelming majority: tagging it would be
  // noise on every line. The two that change how a status must be READ are named.
  const tag = kind === "task" ? "" : ` · ${kind}`;
  const handle = e.id ? `[${e.id}] ` : "";
  const pub = e.scope === "public" ? " · public" : "";
  const head = `• ${handle}${e.entity} — ${e.status}${tag}${pub} (${stamp}${e.source ? ` · ${e.source}` : ""})`;
  return e.note ? `${head}\n    ${e.note}` : head;
}

/** The rows a read works over: on-server, the server-scoped table (own group ∪
 *  public); off-server, the local file. */
async function visibleRows() {
  if (useServer) return (await api("GET", "/ledger")).entries ?? [];
  return loadFile(FILE);
}

async function doCheck(rest) {
  const q = rest.join(" ").trim();
  if (!q) {
    console.error('usage: ledger check "<topic or entity>"');
    process.exit(2);
  }
  const now = Date.now();
  // Two tiers, and the difference is the whole point: `strong` answers the
  // question, `weak` merely shares words with it. Collapsing them would make a
  // loosely-related row read as a status — the opposite of what this gates.
  const { strong, weak } = searchEntries(await visibleRows(), q);
  if (strong.length) {
    console.log(strong.map((e) => fmt(e, now)).join("\n"));
  } else {
    // Nothing recorded is NOT "not done" — it's UNKNOWN. Tell the agent to hedge.
    // This line comes FIRST and unchanged even when there are leads below it:
    // the reflex keys on it, and a lead must not quietly become an answer.
    console.log(`(nothing recorded for "${q}" — treat as UNKNOWN: ask or hedge, do not assert)`);
    if (weak.length) {
      console.log(`\nrelated rows — they may NOT answer your question, do not assert on them:`);
      console.log(weak.map((e) => fmt(e, now)).join("\n"));
    }
  }
}

async function doList() {
  const now = Date.now();
  const rows = searchEntries(await visibleRows(), "").strong;
  console.log(rows.length ? rows.map((e) => fmt(e, now)).join("\n") : "(ledger empty)");
}

async function doRecord(rest) {
  const f = parseFlags(rest);
  // Two shapes: create/supersede by --entity (+ --status), or update an existing
  // row by its --id handle (change any of status/note/source; entity optional).
  const byId = f.id != null && String(f.id).trim();
  const idHasNoFields =
    f.status == null && f.note == null && f.source == null && f.entity == null &&
    f.kind == null && f.verified == null && f.public == null;
  // A fact or a decision has no lifecycle, so `--kind` stands in for `--status`:
  // requiring one would only invite an invented word.
  const hasStatus = !!f.status || !!f.kind;
  if (byId ? idHasNoFields : !f.entity || !hasStatus) {
    console.error(
      'usage: ledger record --entity "<name>" --status <resolved|open|in-progress|decided> [--note "<line>"] [--source "<ref>"] [--public]\n' +
        `   or: ledger record --entity "<name>" --kind <${KINDS.join("|")}> [--note "<line>"] [--source "<ref>"]\n` +
        '   or: ledger record --id <handle> [--status <…>] [--kind <…>] [--note "<line>"] [--source "<ref>"] [--public]\n' +
        '   or: ledger record --id <handle> --verified     (still true/current — nothing else changed)',
    );
    process.exit(2);
  }

  const patch = {
    id: f.id,
    entity: f.entity,
    status: f.status,
    kind: f.kind,
    verified: f.verified === true,
    note: f.note,
    source: f.source,
    // Group-private unless asked: `--public` is the only way out.
    public: f.public === true ? true : undefined,
  };

  let row;
  if (useServer) {
    // The server stamps the authoring group (from the session) and scopes the
    // upsert to it, so a cross-group clobber is impossible by construction.
    row = (await api("POST", "/ledger/record", patch)).row;
  } else {
    // Off-server fallback: write the local file directly (mono-tenant / hand-run).
    const rows0 = loadFile(FILE);
    let next;
    try {
      next = upsertEntry(
        rows0,
        { ...patch, scope: patch.public === true ? "public" : undefined },
        Date.now(),
        mintId(rows0),
      );
    } catch (e) {
      console.error(String(e?.message ?? e));
      process.exit(2);
    }
    saveFile(FILE, next);
    row = byId ? resolveId(next, f.id) : next.find((r) => normEntity(r.entity) === normEntity(f.entity));
  }

  const k = rowKind(row);
  console.log(
    `recorded: ${row.entity} — ${row.status}${k === "task" ? "" : ` · ${k}`}${row.scope === "public" ? " · public" : ""} [${row.id}]`,
  );
  // Say it, don't enforce it: the row is already saved (a refused write is a
  // lost fact) and the full label stays in the table. But the delta pushed to
  // siblings only carries the first LABEL_MAX characters of it, and a label
  // that grew into a sentence is what makes a 9-row delta name one row.
  if (row.entity.length > LABEL_MAX) {
    console.log(
      `note: that label is ${row.entity.length} characters — a label NAMES the topic, the note says what happened. ` +
        `Only the first ${LABEL_MAX} reach the ⟦ledger⟧ block your siblings are pushed.`,
    );
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "check") {
  await doCheck(rest);
} else if (cmd === "record") {
  await doRecord(rest);
} else if (cmd === "list") {
  await doList();
} else {
  console.error("usage: ledger <check|record|list> …");
  process.exit(2);
}
