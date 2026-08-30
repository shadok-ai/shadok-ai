#!/usr/bin/env node
// schedule — manage the CURRENT shadok-ai channel's scheduled prompts (crons)
// through the local server API. Reads SHADOK_SESSION_ID / SHADOK_PORT /
// SHADOK_AUTH from the env (injected by shadok-ai into every agent).
//
// Node, not Python: shadok-ai IS a Node program, so the runtime is guaranteed
// present wherever a skill runs. The Dockerfile's python3 is there to build
// native npm modules, not for skills — trimming it would have broken this
// silently. See context/scheduler-skill/test/ for the tests that now guard it.

import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 15_000;

/** Exit the way the old `sys.exit("…")` did: message on stderr, code 1. */
function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

/** A misuse of the command line — argparse's own exit code, kept on purpose. */
class UsageError extends Error {}

function env() {
  const port = process.env.SHADOK_PORT;
  const sid = process.env.SHADOK_SESSION_ID;
  if (!port || !sid) die("Not inside a shadok-ai channel (SHADOK_PORT / SHADOK_SESSION_ID unset).");
  return { base: `http://127.0.0.1:${port}`, sid, auth: process.env.SHADOK_AUTH ?? "" , key: process.env.SHADOK_SESSION_KEY ?? "" };
}

async function api(ctx, method, path, body) {
  let res;
  try {
    res = await fetch(ctx.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(ctx.auth ? { Cookie: ctx.auth } : {}),
        // Durable half — see the note in pilotctl.mjs: the cookie is frozen
        // into this process's env at spawn and expires after a week.
        ...(ctx.key ? { "x-shadok-session-key": ctx.key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // The Python version had no branch for this and printed a traceback; a
    // stopped cockpit is a normal thing to hit, so it gets a sentence.
    die(`cannot reach the cockpit on ${ctx.base}: ${e.message}`);
  }
  const raw = await res.text();
  if (!res.ok) die(`API error ${res.status}: ${raw.slice(0, 200)}`);
  return raw ? JSON.parse(raw) : {};
}

/** `every:30m` · `every:2h` · `every:45` · `daily:09:00` · `once:2026-08-25T08:42`
 *  → the API's schedule. */
export function parseSchedule(spec) {
  const s = String(spec).trim().toLowerCase();
  const bad = () => {
    throw new UsageError(
      `bad schedule '${spec}' (use every:30m, every:2h, daily:09:00, or once:2026-08-25T08:42)`,
    );
  };
  if (s.startsWith("once:")) {
    // Sent as written: the instant depends on the cron's timezone, which only
    // the server knows. Parsing it here too would be a second truth, and the
    // server already answers with a precise message on an unreadable date.
    const at = s.slice(5).trim();
    if (!at) bad();
    return { kind: "once", at };
  }
  if (s.startsWith("every:")) {
    const m = /^(\d+)([hm]?)$/.exec(s.slice(6));
    // Python raised on a non-numeric value; JS would quietly make it NaN and
    // ship `everyMin: null` to the server, so the digits are checked here.
    if (!m) bad();
    const n = Number(m[1]);
    return { kind: "interval", everyMin: m[2] === "h" ? n * 60 : n };
  }
  if (s.startsWith("daily:")) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(s.slice(6));
    if (!m) bad();
    return { kind: "daily", hour: Number(m[1]), minute: Number(m[2]) };
  }
  return bad();
}

const pad = (n) => String(n).padStart(2, "0");

export function label(s, tz) {
  if (s.kind === "interval") return `every ${s.everyMin}m`;
  if (s.kind === "once") {
    // `at` comes back from the server as an absolute ms epoch, so it is read in
    // the cron's zone — otherwise "once 06:42" doesn't say 6:42 WHERE, the same
    // trap as a bare daily but worse, because a date does not come round again.
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || undefined,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(s.at));
    const f = Object.fromEntries(p.filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
    const hour = pad(Number(f.hour) % 24); // some ICU builds render midnight as "24"
    return `once ${f.year}-${f.month}-${f.day} ${hour}:${f.minute}` + (tz ? ` (${tz})` : "");
  }
  // The timezone is always shown: a bare "daily 09:00" doesn't say 9am WHERE,
  // and that is exactly what makes a UTC server look on time.
  return `daily ${pad(s.hour)}:${pad(s.minute)}` + (tz ? ` (${tz})` : "");
}

/**
 * The command line, kept byte-for-byte compatible with the argparse version:
 * a renamed option would break every cron already registered by an agent.
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const known = {
    add: { flags: ["--schedule", "--prompt", "--check", "--tz"], required: ["--schedule", "--prompt"], pos: 0 },
    list: { flags: [], required: [], pos: 0 },
    env: { flags: [], required: [], pos: 0 },
    tz: { flags: [], required: [], pos: 1 },
    del: { flags: [], required: [], pos: 1, posRequired: 1 },
  };
  if (!cmd || !(cmd in known)) {
    throw new UsageError(`usage: schedule {add,list,del,tz,env} …\ninvalid choice: '${cmd ?? ""}'`);
  }
  const spec = known[cmd];
  const opts = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
      if (!spec.flags.includes(name)) throw new UsageError(`schedule ${cmd}: unrecognized argument ${name}`);
      const v = inline ?? rest[++i];
      if (v === undefined) throw new UsageError(`schedule ${cmd}: ${name} expects a value`);
      opts[name.slice(2)] = v;
    } else pos.push(a);
  }
  for (const r of spec.required) {
    if (opts[r.slice(2)] === undefined) throw new UsageError(`schedule ${cmd}: the following arguments are required: ${r}`);
  }
  if (pos.length > spec.pos) throw new UsageError(`schedule ${cmd}: unrecognized arguments: ${pos.slice(spec.pos).join(" ")}`);
  if (pos.length < (spec.posRequired ?? 0)) throw new UsageError(`schedule ${cmd}: the following arguments are required: id`);
  return { cmd, opts, pos };
}

async function cmdAdd(ctx, opts) {
  const body = { sessionId: ctx.sid, prompt: opts.prompt, schedule: parseSchedule(opts.schedule), enabled: true };
  if (opts.check) body.check = opts.check;
  if (opts.tz) body.tz = opts.tz;
  const r = await api(ctx, "POST", "/crons", body);
  console.log(
    `scheduled [${String(r.id).slice(0, 8)}] ${label(r.schedule, r.timezone)}` +
      (opts.check ? " +guard (0 tokens on quiet runs)" : ""),
  );
}

async function cmdList(ctx) {
  const all = await api(ctx, "GET", "/crons");
  const mine = all.filter((c) => c.sessionId === ctx.sid);
  if (!mine.length) return console.log("(no schedule on this channel)");
  const tzinfo = await api(ctx, "GET", "/timezone");
  for (const c of mine) {
    // A spent one-shot is not "paused": it fired. Saying paused suggests that
    // resuming it would run it again.
    const spent = c.schedule?.kind === "once" && c.lastRun;
    const flags = (c.enabled ? "" : spent ? " (fired)" : " (paused)") + (c.check ? " +guard" : "");
    const tz = c.tz || tzinfo.timezone || tzinfo.system;
    console.log(`[${String(c.id).slice(0, 8)}] ${label(c.schedule, tz)}${flags}\n   ${String(c.prompt).slice(0, 100)}`);
  }
}

async function cmdTz(ctx, zone) {
  const r = zone
    ? await api(ctx, "POST", "/timezone", { timezone: zone === "-" ? "" : zone })
    : await api(ctx, "GET", "/timezone");
  const cur = r.timezone;
  console.log(
    `daily schedules run in: ${cur || r.system}` + (cur ? "" : " (machine default — set one to pin it)"),
  );
}

async function cmdEnv(ctx) {
  // A guard runs server-side, not in this agent's process: it gets the secrets
  // of the CHANNEL's profile, never whatever happens to sit in this shell.
  // Agents that can't see that list assume the worst and hardcode the value
  // into the check script — printing it is the fix.
  const channels = await api(ctx, "GET", "/channels");
  const ch = channels.find((c) => c.sessionId === ctx.sid);
  if (!ch) {
    console.log("this channel is not registered server-side: a guard would run from the");
    console.log("server's own directory, with no profile secrets at all.");
    return;
  }
  console.log(`guard cwd: ${ch.cwd || "(server default)"}`);
  const pname = ch.profile;
  if (!pname) {
    console.log("guard secrets: NONE — this channel has no profile.");
    console.log("  Secrets reach a guard only through the channel's profile; attach one");
    console.log("  (web UI, the agent's profile picker) that lists the names you need.");
    return;
  }
  const profiles = await api(ctx, "GET", "/profiles");
  const prof = profiles.find((p) => p.name === pname);
  if (!prof) {
    // Same end result as "no secrets", but a very different cause: say which
    // one, or the report reads as a working setup.
    console.log(`guard secrets: NONE — the channel points at profile '${pname}', which no longer exists.`);
    return;
  }
  const wanted = prof.secrets ?? [];
  if (!wanted.length) return console.log(`guard secrets: NONE — profile '${pname}' lists no secret.`);
  const vault = new Set((await api(ctx, "GET", "/secrets")).names ?? []);
  const present = wanted.filter((n) => vault.has(n));
  const missing = wanted.filter((n) => !vault.has(n));
  console.log(`guard secrets (profile '${pname}'): ${present.length ? present.join(", ") : "NONE"}`);
  // `secretsFor` skips an unknown name without a word, so a typo here looks
  // exactly like a working guard until the day it runs.
  if (missing.length) console.log(`  referenced but NOT in the vault, so absent at run time: ${missing.join(", ")}`);
}

async function cmdDel(ctx, id) {
  // `list` only prints 8 characters of an id: the server accepts that prefix.
  // Print WHAT IT deleted — an older version announced "deleted" without ever
  // deleting anything.
  const r = await api(ctx, "DELETE", `/crons?id=${encodeURIComponent(id)}`);
  console.log(`deleted ${String(r.id ?? id).slice(0, 8)}`);
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(e.message + "\n");
    process.exit(2);
  }
  const ctx = env();
  try {
    if (parsed.cmd === "add") await cmdAdd(ctx, parsed.opts);
    else if (parsed.cmd === "list") await cmdList(ctx);
    else if (parsed.cmd === "tz") await cmdTz(ctx, parsed.pos[0]);
    else if (parsed.cmd === "env") await cmdEnv(ctx);
    else if (parsed.cmd === "del") await cmdDel(ctx, parsed.pos[0]);
  } catch (e) {
    // A bad --schedule is a command-line mistake, not a server error.
    if (e instanceof UsageError) die(e.message);
    throw e;
  }
}

// Importable by the tests, executable by the agents: only run when invoked
// directly, or importing this file would exit on a missing SHADOK_PORT.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
