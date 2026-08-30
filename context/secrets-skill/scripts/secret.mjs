#!/usr/bin/env node
// secret — put a credential the agent OBTAINED into shadok-ai's vault, through
// the local API.
//
// The value is read from STDIN, never from argv: `ps` exposes a process's
// arguments to every user on the machine, so a token passed as a parameter
// leaks. There is deliberately no way to read a value back out — `list` prints
// names only, and there is no `get`.
//
// Reads SHADOK_PORT / SHADOK_AUTH from the env (injected into every agent).
//
// Node, not Python: shadok-ai IS a Node program, so the runtime is guaranteed
// present wherever a skill runs — the image's python3 exists to build native
// npm modules, and dropping it would have broken this in silence.

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
  if (!port) die("Not inside a shadok-ai agent (SHADOK_PORT unset).");
  return { base: `http://127.0.0.1:${port}`, auth: process.env.SHADOK_AUTH ?? "" , key: process.env.SHADOK_SESSION_KEY ?? "" };
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
    die(`cannot reach the cockpit on ${ctx.base}: ${e.message}`);
  }
  const raw = await res.text();
  if (res.status === 409) {
    die(
      "refused: a secret by that name already exists. Do NOT overwrite it " +
        "yourself — tell the user and let them decide.",
    );
  }
  if (!res.ok) die(`API error ${res.status}: ${raw.slice(0, 200)}`);
  return raw ? JSON.parse(raw) : {};
}

/**
 * The command line, kept identical to the argparse version. `--stdin` is
 * REQUIRED rather than optional: that is what removes any way of passing a
 * value in argv, so it is a security property, not ergonomics.
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "list") {
    if (rest.length) throw new UsageError(`secret list: unrecognized arguments: ${rest.join(" ")}`);
    return { cmd };
  }
  if (cmd !== "set") {
    throw new UsageError(`usage: secret {list,set} …\ninvalid choice: '${cmd ?? ""}'`);
  }
  let name;
  let stdin = false;
  for (const a of rest) {
    if (a === "--stdin") stdin = true;
    else if (a.startsWith("-")) throw new UsageError(`secret set: unrecognized argument ${a}`);
    else if (name === undefined) name = a;
    else throw new UsageError(`secret set: unrecognized arguments: ${a}`);
  }
  if (name === undefined) throw new UsageError("secret set: the following arguments are required: name");
  if (!stdin) {
    throw new UsageError(
      "secret set: the following arguments are required: --stdin (the value is read from stdin, never from argv)",
    );
  }
  return { cmd, name };
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
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

  if (parsed.cmd === "list") {
    const names = (await api(ctx, "GET", "/secrets")).names ?? [];
    console.log(names.length ? names.join("\n") : "(vault empty)");
    return;
  }

  const value = (await readStdin()).trim();
  if (!value) die("nothing on stdin — pipe the value in, e.g. `gh auth token | ... --stdin`");
  await api(ctx, "PUT", "/secrets", { name: parsed.name, value });
  // Never echo the value back: this output lands in the transcript, and may be
  // mirrored to Telegram.
  console.log(`stored ${parsed.name} in the vault`);
  console.log("It reaches an agent only once attached to a profile (web Profiles panel).");
}

// Importable by the tests, executable by the agents: only run when invoked
// directly, or importing this file would exit on a missing SHADOK_PORT.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
