#!/usr/bin/env node
// Hand a file to the person driving this cockpit.
//
// Deliberately a script and not the harness's SendUserFile tool: a tmux agent
// keeps the Claude Code binary it was spawned with, so an agent older than that
// tool never sees it — and the whole fleet runs pre-upgrade binaries by design.
// An HTTP call works on every build, including the ones already running.
import path from "node:path";

const args = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };

let caption;
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--caption" || args[i] === "-c") caption = args[++i];
  else if (args[i] === "--help" || args[i] === "-h")
    die("usage: send.mjs <file...> [--caption \"…\"]");
  else paths.push(args[i]);
}
if (!paths.length) die("usage: send.mjs <file...> [--caption \"…\"]");

const port = process.env.SHADOK_PORT;
const key = process.env.SHADOK_SESSION_KEY;
if (!port) die("Not inside a shadok-ai agent (SHADOK_PORT unset).");
// Said plainly rather than worked around: an agent that cannot authenticate
// must tell the human, not invent its own way of surfacing a file.
if (!key) die("SHADOK_SESSION_KEY is unset — ask the human to reload this agent.");

// Resolved HERE, where the cwd is the agent's. The server's cwd is its launch
// directory and never this one, so a relative path sent as-is would point
// somewhere else and only ever work by coincidence.
const abs = paths.map((p) => path.resolve(p));

let res;
try {
  res = await fetch(`http://127.0.0.1:${port}/files`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shadok-session-key": key },
    body: JSON.stringify({ paths: abs, ...(caption ? { caption } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
} catch (e) {
  die(`The cockpit did not answer (${e?.message ?? e}). It may be restarting — say so rather than working around it.`);
}

const body = await res.json().catch(() => ({}));
if (!res.ok) die(`Refused (${res.status}): ${body.error ?? "no reason given"}`);
for (const f of body.sent ?? []) console.log(`sent: ${f.name} (${f.size} bytes)`);
// A partial success is reported, never swallowed: the agent has to know WHICH
// file did not make it.
for (const r of body.refused ?? []) console.error(`not sent: ${r}`);
