#!/usr/bin/env node
// List the LinkedIn accounts shared with this agent, and post on one.
//
// The OAuth token is never here: the server holds it and publishes on the
// agent's behalf. This script only ever sends the session key and the text.
import path from "node:path";

const MAX_CHARS = 3000; // mirrors MAX_COMMENTARY in src/linkedin.ts
const USAGE = "usage: social.mjs accounts | post --account <id> [--image <abs path>] --stdin";
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
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    die(`The cockpit did not answer (${e?.message ?? e}). It may be restarting — say so rather than working around it.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(body.error ?? `Refused (${res.status}): no reason given`);
  return body;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function accounts() {
  const { accounts: list = [] } = await call("GET", "/social/accounts");
  if (!list.length) {
    console.log("No LinkedIn account is shared with this agent. Ask the person to connect one in Secrets → Connected accounts.");
    return;
  }
  // Only these fields are ever printed, whatever else the server sent.
  for (const a of list) {
    console.log(`${String(a.id).slice(0, 8)}  ${a.label}  ${a.provider}  policy=${a.policy}  expires=${day(a.expiresAt)}${a.status === "expired" ? "  EXPIRED" : ""}`);
  }
}

async function post(args) {
  let account, image, stdin = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--account") account = args[++i];
    else if (args[i] === "--image") image = args[++i];
    else if (args[i] === "--stdin") stdin = true;
    else die(USAGE);
  }
  if (!stdin) die("post requires --stdin: the text is read from stdin so it never sits in argv.");
  if (!account) die("post requires --account <id> (see `accounts`).");
  if (image !== undefined && !path.isAbsolute(image)) die(`The image path must be absolute; '${image}' is not.`);
  const text = await readStdin();
  if (!text.trim()) die("The post is empty.");
  const n = [...text].length;
  if (n > MAX_CHARS) die(`The post is ${n.toLocaleString("en-US")} characters; LinkedIn allows ${MAX_CHARS.toLocaleString("en-US")}.`);
  const out = await call("POST", "/social/posts", { account, text, ...(image ? { image } : {}) });
  if (out.status === "pending") {
    console.log(`Draft ${out.draftId} is waiting for approval in the cockpit. Do not say it is published until you are told.`);
  } else if (out.status === "published") {
    console.log(`Published: ${out.url}`);
  } else {
    die("The cockpit gave an answer this script does not understand.");
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "accounts") await accounts();
else if (cmd === "post") await post(rest);
else die(USAGE);
