#!/usr/bin/env node
// secret — put a credential the agent OBTAINED into shadok-ai's vault, through
// the local API.
//
// The value is read from STDIN, never from argv: `ps` exposes a process's
// arguments to every user on the machine, so a token passed as a parameter
// leaks. There is deliberately no way to read a value back out — `list` prints
// names only, and there is no `get`.
//
// Reads SHADOK_PORT / SHADOK_SESSION_KEY from the env (injected into every agent).
//
// Node, not Python: shadok-ai IS a Node program, so the runtime is guaranteed
// present wherever a skill runs — the image's python3 exists to build native
// npm modules, and dropping it would have broken this in silence.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  return { base: `http://127.0.0.1:${port}`, key: process.env.SHADOK_SESSION_KEY ?? "" };
}

async function api(ctx, method, path, body) {
  let res;
  try {
    res = await fetch(ctx.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        // The agent's ONLY credential (no cookie is handed to agents any more).
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
  let attach = false;
  // `--profile NAME`, repeatable: the roles that receive the secret. Only the
  // server decides whether the caller may name them — this just carries them.
  const profiles = [];
  let pending = null;
  for (const a of rest) {
    if (pending) {
      if (a.startsWith("-")) throw new UsageError(`secret set: ${pending} needs a profile name`);
      profiles.push(a);
      pending = null;
    } else if (a === "--stdin") stdin = true;
    else if (a === "--attach") attach = true;
    else if (a === "--profile") pending = a;
    else if (a.startsWith("--profile=")) {
      const v = a.slice("--profile=".length);
      if (!v) throw new UsageError("secret set: --profile needs a profile name");
      profiles.push(v);
    } else if (a.startsWith("-")) throw new UsageError(`secret set: unrecognized argument ${a}`);
    else if (name === undefined) name = a;
    else throw new UsageError(`secret set: unrecognized arguments: ${a}`);
  }
  if (pending) throw new UsageError("secret set: --profile needs a profile name");
  if (name === undefined) throw new UsageError("secret set: the following arguments are required: name");
  if (!stdin) {
    throw new UsageError(
      "secret set: the following arguments are required: --stdin (the value is read from stdin, never from argv)",
    );
  }
  return { cmd, name, attach, profiles: [...new Set(profiles)] };
}

/** Like `api`, but hands the refusal back instead of exiting on it. */
async function apiSoft(ctx, method, path, body) {
  let res;
  try {
    res = await fetch(ctx.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(ctx.key ? { "x-shadok-session-key": ctx.key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `cannot reach the cockpit: ${e.message}` };
  }
  const raw = await res.text();
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    /* a non-JSON body is still a refusal we can report */
  }
  return res.ok ? { ok: true, body: parsed } : { ok: false, error: parsed.error ?? raw.slice(0, 200) };
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
  // `--attach` rides on the SAME request: the server creates the secret and
  // binds it to this agent's own profile in one write, or refuses before
  // storing anything. Two calls used to leave "stored, but NOT attached".
  const stored = await api(ctx, "PUT", "/secrets", {
    name: parsed.name,
    value,
    ...(parsed.attach ? { attach: true } : {}),
    ...(parsed.profiles.length ? { profiles: parsed.profiles } : {}),
  });
  // Never echo the value back: this output lands in the transcript, and may be
  // mirrored to Telegram.
  console.log(`stored ${parsed.name} in the vault`);
  if (parsed.profiles.length) {
    // A cockpit OLDER than this skill ignores `profiles` and answers without
    // the field (invariant 57). Claiming "bound" then would be a lie about
    // where a credential went, so say the truth and exit non-zero.
    if (Array.isArray(stored.profiles) && stored.profiles.length)
      console.log(`bound to ${stored.profiles.join(", ")} — each of those agents gets it at its next spawn.`);
    else {
      process.stderr.write(
        "stored, but the roles were NOT bound: this cockpit is older than the skill. Ask the user to bind it from the vault panel.\n",
      );
      process.exitCode = 1;
    }
  }
  if (!parsed.attach) {
    if (!parsed.profiles.length) {
      console.log("It reaches an agent only once attached to a profile (web Profiles panel,");
      console.log("or re-run with --attach for your own profile, --profile NAME for another role).");
    }
    return;
  }
  let profile = stored.attached;
  if (!profile) {
    // An older server ignores `attach` (this script can be newer than the
    // server it calls, invariant 57): fall back to the separate attach route.
    // The vault write already succeeded, so a refusal here must not read as
    // "nothing was stored" — say both halves, and still exit non-zero.
    const att = await apiSoft(ctx, "PUT", "/profiles/secret", { name: parsed.name });
    if (!att.ok) {
      process.stderr.write(`stored, but NOT attached: ${att.error}\n`);
      process.exit(1);
    }
    profile = att.body.profile;
  }
  console.log(`attached to your profile (${profile}).`);
  console.log("It is injected as an environment variable at your next reload, not in this");
  console.log("process: node ~/.claude/skills/shadok-reload/reload.mjs");
}

// Run only as a script (the test imports the pure helpers above). Compared
// through realpath: in a group HOME `~/.claude/skills/shadok-secrets` is a SYMLINK to
// the machine-wide copy, and Node resolves links in import.meta.url but not in
// argv[1]. A plain comparison then reads "imported", and the script exits 0
// having done NOTHING — a silent no-op the calling agent takes for success.
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
