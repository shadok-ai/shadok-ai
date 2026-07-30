#!/usr/bin/env node
import { extractResponse, findSessionId } from "./extract.js";
import { PtyPilot } from "./session.js";

function usage(): never {
  console.error(`Usage: shadok-ai [options] "<prompt>"

Sends a prompt to a PTY-driven Claude Code TUI session and prints the
response once the session becomes idle again.

Options:
  --cwd <dir>       Working directory of the session (default: current cwd)
  --continue, -c    Resume the latest session of this directory
  --resume <id>, -r Resume a specific session (id printed at end of run)
  --watch           Mirror the TUI live on stdout
  --keep            Keep the session open at the end (Ctrl-C to quit)
  --timeout <sec>   Max wait for the response (default: 600)
`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let cwd = process.cwd();
let watch = false;
let keep = false;
let timeoutSec = 600;
let continueSession = false;
let resumeId: string | null = null;
const rest: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--cwd") cwd = argv[++i] ?? usage();
  else if (a === "--continue" || a === "-c") continueSession = true;
  else if (a === "--resume" || a === "-r") resumeId = argv[++i] ?? usage();
  else if (a === "--watch") watch = true;
  else if (a === "--keep") keep = true;
  else if (a === "--timeout") timeoutSec = Number(argv[++i] ?? usage());
  else if (a === "--help" || a === "-h") usage();
  else rest.push(a);
}

const prompt = rest.join(" ").trim();
if (!prompt) usage();
if (continueSession && resumeId) {
  console.error("--continue and --resume are mutually exclusive.");
  usage();
}

const claudeArgs: string[] = [];
if (continueSession) claudeArgs.push("--continue");
if (resumeId) claudeArgs.push("--resume", resumeId);

const pilot = new PtyPilot({ cwd, args: claudeArgs });

async function main() {
  console.error("▶ starting claude…");
  pilot.start();

  if (watch) pilot.onData((chunk) => process.stdout.write(chunk));

  // Wait for the TUI to be ready (stable screen, no spinner).
  let screen = await pilot.waitForIdle({ stableMs: 1200, timeoutMs: 60_000 });

  // First launch in a directory: trust dialog.
  if (/do you trust the files/i.test(screen)) {
    console.error("▶ trust dialog detected, accepting…");
    pilot.press("enter");
    screen = await pilot.waitForIdle({ stableMs: 1200, timeoutMs: 30_000 });
  }

  console.error(`▶ sending prompt: ${prompt}`);
  await pilot.submit(prompt);

  await pilot.waitForIdle({ stableMs: 2000, timeoutMs: timeoutSec * 1000 });

  console.error("▶ response received:\n");
  process.stdout.write(extractResponse(pilot.fullBuffer(), prompt) + "\n");

  const sessionId = findSessionId(cwd);
  if (sessionId) {
    console.error(`\n▶ session: ${sessionId}`);
    console.error(`  resume with: shadok-ai --resume ${sessionId} "<prompt>"`);
  }

  if (keep) {
    console.error("\n▶ session kept open (--keep). Ctrl-C to quit.");
    process.on("SIGINT", async () => {
      await pilot.stop();
      process.exit(0);
    });
  } else {
    await pilot.stop();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  pilot.kill();
  process.exit(1);
});
