#!/usr/bin/env node
// webhook — manage the webhooks of the CURRENT shadok-ai channel: an outside
// system POSTs to a URL and this agent is woken with a stored prompt plus the
// request body. The event-driven twin of schedule.mjs, through the same local
// API and the same three env vars (SHADOK_SESSION_ID / SHADOK_PORT /
// SHADOK_SESSION_KEY).
//
// An agent can only ever write a webhook on ITSELF: the server takes the target
// from the session key, never from this script.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 15_000;

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

/** A misuse of the command line: exit code 2, like schedule.mjs. */
export class UsageError extends Error {}

const USAGE = [
  "usage:",
  '  webhook.mjs add --name "<label>" --prompt "<what to do on each call>"',
  "  webhook.mjs list",
  '  webhook.mjs update <id> [--name "<label>"] [--prompt "<text>"] [--pause | --resume]',
  "  webhook.mjs rotate <id>",
  "  webhook.mjs del <id>",
].join("\n");

/** Pure: argv → { cmd, id?, opts }. Throws UsageError on anything unreadable. */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!["add", "list", "update", "rotate", "del"].includes(cmd)) throw new UsageError(USAGE);
  const opts = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--name" || a === "--prompt") {
      const v = rest[++i];
      if (v === undefined || !v.trim()) throw new UsageError(`${a} needs a value\n${USAGE}`);
      opts[a.slice(2)] = v.trim();
    } else if (a === "--pause" || a === "--resume") {
      if (opts.enabled !== undefined) throw new UsageError("--pause and --resume exclude each other");
      opts.enabled = a === "--resume";
    } else if (a.startsWith("--")) {
      throw new UsageError(`unknown option ${a}\n${USAGE}`);
    } else pos.push(a);
  }
  if (cmd === "add" && !opts.prompt) throw new UsageError(`add needs --prompt\n${USAGE}`);
  if (cmd === "add" && opts.enabled !== undefined) throw new UsageError("--pause / --resume are for update");
  if (["update", "rotate", "del"].includes(cmd) && pos.length !== 1) throw new UsageError(`${cmd} needs one webhook id\n${USAGE}`);
  if (["add", "list"].includes(cmd) && pos.length) throw new UsageError(`unexpected argument ${pos[0]}\n${USAGE}`);
  if (cmd === "update" && !Object.keys(opts).length) throw new UsageError(`update needs something to change\n${USAGE}`);
  return { cmd, id: pos[0], opts };
}

/**
 * Pure: the webhook an id PREFIX names among this agent's own. The list shows
 * eight characters, so that is what gets typed back; an ambiguous or unknown
 * prefix is an error rather than a guess — `del` on the wrong one is silent.
 */
export function resolveMine(list, sid, prefix) {
  const mine = list.filter((w) => w.sessionId === sid && w.id.startsWith(prefix));
  if (mine.length === 1) return mine[0];
  throw new UsageError(mine.length ? `'${prefix}' matches ${mine.length} webhooks — give more of the id` : `no webhook '${prefix}' on this agent (see: webhook.mjs list)`);
}

/**
 * Pure: how to tell the sender where to POST. The server knows the cockpit's
 * public address only once a person has opened it in a browser; before that it
 * answers a path, and inventing a host here would hand out a dead URL.
 */
export function callInstructions(hook, token) {
  const where = hook.url ?? `<the cockpit's public address>${hook.path ?? "/hooks/" + hook.id}`;
  const lines = [
    `POST ${where}`,
    `Authorization: Bearer ${token ?? "<the token shown when it was created>"}`,
    "",
    "A sender that can only be given a URL: append ?token=<token> (the header is better, it stays out of logs).",
    "The request body (JSON or text, 16 kB kept) reaches you as untrusted data after your prompt. The call answers 202 at once; it never returns your reply.",
  ];
  if (!hook.url) lines.push("", "The public address of this cockpit is not known yet (nobody has opened it in a browser since it started keeping track). Ask the person for it, or have the operator set SHADOK_PUBLIC_URL — do not guess a host.");
  return lines.join("\n");
}

function env() {
  const port = process.env.SHADOK_PORT;
  const sid = process.env.SHADOK_SESSION_ID;
  if (!port || !sid) die("Not inside a shadok-ai channel (SHADOK_PORT / SHADOK_SESSION_ID unset).");
  return { base: `http://127.0.0.1:${port}`, sid, key: process.env.SHADOK_SESSION_KEY ?? "" };
}

async function api(ctx, method, path, body) {
  let res;
  try {
    res = await fetch(ctx.base + path, {
      method,
      headers: { "content-type": "application/json", ...(ctx.key ? { "x-shadok-session-key": ctx.key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    die(`cannot reach the cockpit on ${ctx.base}: ${e.message}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 200);
    try { msg = JSON.parse(raw).error ?? msg; } catch { /* not JSON */ }
    // An older server (skills are seeded machine-wide and can be newer than the
    // instance answering) keeps webhooks person-only: say what to do instead.
    if (res.status === 403 && /browser/.test(msg)) die("This cockpit does not let an agent write webhooks. Ask the person to add it in this agent's Webhooks panel (the ⚡ icon).");
    die(`refused (${res.status}): ${msg}`);
  }
  return raw ? JSON.parse(raw) : {};
}

function line(w) {
  const state = w.enabled ? "" : " (paused)";
  const last = w.lastRun ? ` · last call ${new Date(w.lastRun).toISOString()} → ${w.lastOutcome ?? "?"}` : " · never called";
  return `${w.id.slice(0, 8)}  ${w.name}${state}${w.createdBy === "agent" ? "" : " · added by a person"}${last}\n          ${w.url ?? w.path ?? "/hooks/" + w.id}\n          prompt: ${w.prompt}`;
}

export async function main(argv) {
  let p;
  try {
    p = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(e.message + "\n");
    process.exit(2);
  }
  const ctx = env();
  try {
    if (p.cmd === "add") {
      const w = await api(ctx, "POST", "/webhooks", { name: p.opts.name, prompt: p.opts.prompt });
      console.log(`Webhook "${w.name}" created (${w.id.slice(0, 8)}). The token is shown ONCE — hand it over now:\n\n${callInstructions(w, w.token)}`);
      return;
    }
    const list = (await api(ctx, "GET", "/webhooks")).filter((w) => w.sessionId === ctx.sid);
    if (p.cmd === "list") {
      console.log(list.length ? list.map(line).join("\n") : "no webhook on this agent");
      return;
    }
    const w = resolveMine(list, ctx.sid, p.id);
    if (p.cmd === "update") {
      const u = await api(ctx, "PATCH", "/webhooks/" + w.id, p.opts);
      console.log(`Updated:\n${line(u)}`);
    } else if (p.cmd === "rotate") {
      const u = await api(ctx, "POST", "/webhooks/" + w.id + "/rotate");
      console.log(`New token for "${u.name}" — the old one stopped working. Shown ONCE:\n\n${callInstructions(u, u.token)}`);
    } else {
      await api(ctx, "DELETE", "/webhooks/" + w.id);
      console.log(`Deleted "${w.name}" (${w.id.slice(0, 8)}): its URL no longer answers.`);
    }
  } catch (e) {
    if (e instanceof UsageError) die(e.message);
    throw e;
  }
}

// Run only as a script. Compared through realpath: in a group HOME the skill
// directory is a SYMLINK to the machine-wide copy, and Node resolves links in
// import.meta.url but not in argv[1] — a plain comparison reads "imported" and
// the script exits 0 having done nothing.
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const invoked = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (invoked) {
  await main(process.argv.slice(2));
}
