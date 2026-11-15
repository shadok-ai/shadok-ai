#!/usr/bin/env node
// Ask an admin for help: POST /reports with this agent's session key.
// A script rather than a raw curl so the body can come from stdin without any
// quoting trap, and so a refusal is said plainly.
const args = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };
const USAGE = 'usage: report.mjs [--kind access|bug|blocked] [--secret ENV_NAME] [--body "…"] "title" [<<< body]';

let kind, secret, bodyArg;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--kind" || args[i] === "-k") kind = args[++i];
  else if (args[i] === "--secret" || args[i] === "-s") secret = args[++i];
  else if (args[i] === "--body" || args[i] === "-b") bodyArg = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") die(USAGE);
  else rest.push(args[i]);
}
const title = rest.join(" ").trim();
if (!title) die(USAGE);

// The body comes from `--body` or from stdin. stdin is read only when it is not
// a TTY AND something actually arrives quickly: an agent's Bash tool hands the
// script a pipe that is never written nor closed, and a plain `for await` over
// it hung for ever (measured). Once data starts, it is read to the end.
async function readStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let buf = "";
    let started = false;
    const done = () => { clearTimeout(idle); process.stdin.pause(); process.stdin.removeAllListeners(); resolve(buf); };
    const idle = setTimeout(() => { if (!started) done(); }, 400);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { started = true; buf += c; });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}
const body = bodyArg ?? (await readStdin());

const port = process.env.SHADOK_PORT;
const key = process.env.SHADOK_SESSION_KEY;
if (!port) die("Not inside a shadok-ai agent (SHADOK_PORT unset).");
if (!key) die("SHADOK_SESSION_KEY is unset — say so in your chat and ask the human to reload this agent.");

let res;
try {
  res = await fetch(`http://127.0.0.1:${port}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shadok-session-key": key },
    body: JSON.stringify({ title, ...(kind ? { kind } : {}), ...(secret ? { secret } : {}), ...(body.trim() ? { body } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
} catch (e) {
  die(`The cockpit did not answer (${e?.message ?? e}). Say so in your chat instead.`);
}
const out = await res.json().catch(() => ({}));
if (!res.ok) die(`Refused (${res.status}): ${out.error ?? "no reason given"}`);
const how = ["the cockpit's Reports panel", out.notified?.telegram ? "a Telegram DM to the owner" : null].filter(Boolean).join(" and ");
process.stdin.destroy();
console.log(`reported${out.merged ? ` again (×${out.count})` : ""} — the admins were told through ${how}.`);
