#!/usr/bin/env node
// Work in a Google account the person connected in the cockpit: calendar,
// Drive files the cockpit created, Docs, Sheets, Gmail drafts and sending.
//
// The OAuth token is never here: the server holds it and calls Google on the
// agent's behalf. This script only ever sends the session key and the request.
// Bodies (a mail body, a document's text, rows, an event description) are read
// from stdin so they never sit in argv.
import path from "node:path";

const USAGE = `usage: google.mjs <command>
  accounts
  calendar list   --account <id> [--from <date>] [--to <date>] [--calendar <id>] [--max <n>]
  calendar create --account <id> --title <t> --start <when> --end <when> [--tz <zone>] [--attendee <email>]... [--location <l>] [--calendar <id>] [--stdin]
  calendar update --account <id> --event <id> [--title <t>] [--start <when> --end <when>] [--tz <zone>] [--attendee <email>]... [--location <l>] [--calendar <id>] [--stdin]
  calendar delete --account <id> --event <id> [--calendar <id>]
  drive list      --account <id> [--max <n>]
  doc create      --account <id> --title <t> [--stdin]
  doc read        --account <id> --id <doc id>
  doc append      --account <id> --id <doc id> --stdin
  sheet create    --account <id> --title <t>
  sheet read      --account <id> --id <sheet id> [--range <A1 range>]
  sheet append    --account <id> --id <sheet id> [--range <A1 range>] --stdin      (stdin: JSON array of rows)
  gmail draft     --account <id> --to <email>... [--cc <email>]... [--bcc <email>]... --subject <s> [--attach <abs path>]... [--update <draft id>] --stdin
  gmail send      --account <id> --to <email>... [--cc <email>]... [--bcc <email>]... --subject <s> [--attach <abs path>]... --stdin`;
const die = (m) => { console.error(m); process.exit(1); };

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function connection() {
  const port = process.env.SHADOK_PORT;
  const key = process.env.SHADOK_SESSION_KEY;
  if (!port) die("Not inside a shadok-ai agent (SHADOK_PORT unset).");
  if (!key) die("SHADOK_SESSION_KEY is unset — ask the human to reload this agent.");
  return { port, key };
}

async function call(method, route, payload) {
  const { port, key } = connection();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { "content-type": "application/json", "x-shadok-session-key": key },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    die(`The cockpit did not answer (${e?.message ?? e}). It may be restarting — say so rather than working around it.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(body.error ?? `Refused (${res.status}): no reason given`);
  return body;
}

const day = (ms) => (typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : "none");

async function accounts() {
  const { accounts: list = [] } = await call("GET", "/social/accounts");
  const mine = list.filter((a) => a.provider === "google");
  if (!mine.length) {
    console.log("No Google account is available to this agent. Ask the person to connect one in Secrets → Connected accounts, or to share theirs with this agent's group.");
    return;
  }
  // Only these fields are ever printed, whatever else the server sent.
  for (const a of mine) {
    const areas = Array.isArray(a.areas) ? a.areas.join(",") : "";
    const p = a.policies ?? {};
    console.log(`${String(a.id).slice(0, 8)}  ${a.label}  areas=${areas || "none"}  mail=${p.mail ?? "approve"}  events=${p.calendar ?? "approve"}  reconnect-by=${day(a.expiresAt)}${a.status === "expired" ? "  EXPIRED" : ""}`);
  }
}

// Which flags each command takes: name → kind. "list" flags may repeat.
const FLAGS = {
  account: "one", from: "one", to: "list", calendar: "one", max: "num", title: "one", start: "one", end: "one", tz: "one",
  attendee: "list", location: "one", event: "one", id: "one", range: "one", cc: "list", bcc: "list", subject: "one",
  attach: "list", update: "one", stdin: "flag",
};

function parse(args, listTo) {
  const o = { stdin: false };
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z]+)$/.exec(args[i]);
    const kind = m && FLAGS[m[1]];
    if (!kind) die(USAGE);
    const k = m[1];
    if (kind === "flag") { o[k] = true; continue; }
    const v = args[++i];
    if (v === undefined) die(`--${k} needs a value.`);
    // `--to` is a recipient (repeatable) for gmail, a date for `calendar list`.
    if (kind === "list" && (k !== "to" || listTo)) (o[k] ??= []).push(v);
    else if (kind === "num") {
      o[k] = Number(v);
      if (!Number.isFinite(o[k])) die(`--${k} must be a number.`);
    } else o[k] = v;
  }
  if (!o.account) die("--account <id> is required (see `accounts`).");
  return o;
}

const ACTIONS = {
  "calendar list": "calendar.list", "calendar create": "calendar.create", "calendar update": "calendar.update", "calendar delete": "calendar.delete",
  "drive list": "drive.list", "doc create": "doc.create", "doc read": "doc.read", "doc append": "doc.append",
  "sheet create": "sheet.create", "sheet read": "sheet.read", "sheet append": "sheet.append", "gmail draft": "gmail.draft", "gmail send": "gmail.send",
};

function eventArgs(o, text) {
  return {
    ...(o.calendar ? { calendar: o.calendar } : {}),
    ...(o.event ? { event: o.event } : {}),
    ...(o.title !== undefined ? { title: o.title } : {}),
    ...(o.start !== undefined ? { start: o.start } : {}),
    ...(o.end !== undefined ? { end: o.end } : {}),
    ...(o.tz ? { timeZone: o.tz } : {}),
    ...(o.attendee ? { attendees: o.attendee } : {}),
    ...(o.location !== undefined ? { location: o.location } : {}),
    ...(text !== null ? { description: text } : {}),
  };
}

function print(action, out) {
  if (out.status === "pending") {
    const what = action === "gmail.send" ? "The email is a Gmail draft and" : "The calendar change";
    console.log(`${what} is waiting for approval in the cockpit (draft ${out.draftId}). Nothing has left the account. Do not say it is sent or done until you are told.`);
    return;
  }
  const r = out.result ?? {};
  if (action === "calendar.list") {
    if (!r.events?.length) return console.log("No event in that window.");
    for (const e of r.events) {
      console.log(`${e.id}  ${e.start} → ${e.end}${e.timeZone ? ` (${e.timeZone})` : ""}  ${e.title}${e.attendees?.length ? `  [${e.attendees.join(", ")}]` : ""}${e.location ? `  @ ${e.location}` : ""}`);
    }
  } else if (action === "drive.list") {
    if (!r.files?.length) return console.log("No file yet. Only files created through this cockpit are visible (not the person's whole Drive).");
    for (const f of r.files) console.log(`${f.id}  ${f.name}  ${f.mimeType}${f.modifiedTime ? `  ${f.modifiedTime}` : ""}`);
  } else if (action === "doc.read") {
    console.log(`# ${r.name}\n${r.text}`);
  } else if (action === "sheet.read") {
    console.log(JSON.stringify(r.rows ?? []));
  } else if (action === "doc.create" || action === "sheet.create") {
    console.log(`Created ${r.id}: ${r.link}`);
  } else if (action === "doc.append") {
    console.log("Appended.");
  } else if (action === "sheet.append") {
    console.log(`Appended${r.updatedRange ? ` at ${r.updatedRange}` : ""}.`);
  } else if (action === "gmail.draft") {
    console.log(`Draft ${r.draftId} is in the person's Gmail drafts. Nothing was sent.`);
  } else if (action === "gmail.send") {
    console.log("Sent.");
  } else if (action === "calendar.create" || action === "calendar.update") {
    console.log(`${r.status === "created" ? "Created" : "Updated"} event ${r.event?.id ?? ""}${r.event?.link ? `: ${r.event.link}` : ""}`);
  } else if (action === "calendar.delete") {
    console.log("Event deleted.");
  }
}

async function run(group, verb, rest) {
  const action = ACTIONS[`${group} ${verb}`];
  if (!action) die(USAGE);
  const mail = action.startsWith("gmail.");
  const o = parse(rest, mail);
  const needsStdin = mail || action === "doc.append" || action === "sheet.append";
  if (needsStdin && !o.stdin) die(`${group} ${verb} requires --stdin: the content is read from stdin so it never sits in argv.`);
  const text = o.stdin ? await readStdin() : null;
  for (const p of o.attach ?? []) if (!path.isAbsolute(p)) die(`An attachment path must be absolute; '${p}' is not.`);
  let args;
  if (action === "calendar.list") args = { ...(o.calendar ? { calendar: o.calendar } : {}), ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}), ...(o.max ? { max: o.max } : {}) };
  else if (action.startsWith("calendar.")) args = eventArgs(o, text);
  else if (action === "drive.list") args = { ...(o.max ? { max: o.max } : {}) };
  else if (action === "doc.create") args = { title: o.title, ...(text ? { text } : {}) };
  else if (action === "sheet.create") args = { title: o.title };
  else if (action === "doc.read") args = { id: o.id };
  else if (action === "doc.append") args = { id: o.id, text };
  else if (action === "sheet.read") args = { id: o.id, ...(o.range ? { range: o.range } : {}) };
  else if (action === "sheet.append") {
    let rows;
    try { rows = JSON.parse(text); } catch { die("sheet append reads a JSON array of rows from stdin, e.g. [[\"Name\",\"Qty\"],[\"Bolt\",12]]."); }
    args = { id: o.id, rows, ...(o.range ? { range: o.range } : {}) };
  } else {
    if (!text || !text.trim()) die("The email body is empty.");
    args = { to: o.to ?? [], cc: o.cc ?? [], bcc: o.bcc ?? [], subject: o.subject, body: text, ...(o.attach ? { attachments: o.attach } : {}), ...(o.update ? { update: o.update } : {}) };
  }
  print(action, await call("POST", "/google/actions", { account: o.account, action, args }));
}

const [cmd, verb, ...rest] = process.argv.slice(2);
if (cmd === "accounts") await accounts();
else if (cmd && verb) await run(cmd, verb, rest);
else die(USAGE);
