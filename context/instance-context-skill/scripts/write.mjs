#!/usr/bin/env node
// Write the instance context ONCE — the short text every agent on this cockpit
// receives at spawn. The server accepts it only from the lead agent (the home
// channel) and only while it is empty; afterwards humans own it.
//
// The text comes on stdin, never on the command line: it can be long, and a
// quote or a newline in argv is a quoting accident waiting to happen.
const die = (m) => { console.error(m); process.exit(1); };
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--stdin")
  die('usage: write.mjs --stdin   (pipe the text in, e.g. with a heredoc)');

const port = process.env.SHADOK_PORT;
const key = process.env.SHADOK_SESSION_KEY;
if (!port) die("Not inside a shadok-ai agent (SHADOK_PORT unset).");
if (!key) die("SHADOK_SESSION_KEY is unset — ask the human to reload this agent.");

let text = "";
for await (const chunk of process.stdin) text += chunk;
if (!text.trim()) die("Nothing on stdin — pipe the instance context in.");

let res;
try {
  res = await fetch(`http://127.0.0.1:${port}/instance-context/first`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-shadok-session-key": key },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
} catch (e) {
  die(`The cockpit did not answer (${e?.message ?? e}). Say so rather than working around it.`);
}
const body = await res.json().catch(() => ({}));
if (!res.ok) die(`Refused (${res.status}): ${body.error ?? "no reason given"}`);
console.log("instance context saved — every agent spawned from now on receives it.");
