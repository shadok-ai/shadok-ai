import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TmuxPilot,
  isEnvName,
  launcherScript,
  shellQuote,
  tmuxAvailable,
  tmuxErrorMessage,
  tmuxHasSession,
  tmuxKillSession,
} from "../src/tmux.js";

/**
 * The spawn carried every secret VALUE of a profile, plus every system prompt,
 * as one string on `tmux new-session`. tmux refuses a command over ~16 KB, so
 * on a real instance (47 secrets, one of them 2.4 KB) the lead role — whose
 * prompt is longer — could not be launched at all, while a shorter role on the
 * same vault could. And the failure's message, built by `execFileSync` as
 * "Command failed: <every argument>", reached the browser with forty-six
 * credentials in it. These tests RUN the generated script with `sh` wherever
 * they can: what matters is what the child process receives, not how the text
 * looks.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "shadok-launcher-"));

/** Write a launcher, run it with `sh`, return what the child printed. */
function run(o: Parameters<typeof launcherScript>[0], outerEnv: NodeJS.ProcessEnv = {}): { out: string; file: string } {
  const dir = tmp();
  const file = path.join(dir, "launch.sh");
  fs.writeFileSync(file, launcherScript(o).script, { mode: 0o600 });
  const out = execFileSync("sh", [file], { encoding: "utf8", env: { PATH: process.env.PATH, ...outerEnv } });
  return { out, file };
}

test("a hostile secret value reaches the child byte for byte", () => {
  // Quotes, $, backticks, a newline and a backslash: every way a value could be
  // re-interpreted by the shell on its way through.
  const nasty = `it's $HOME \`id\` "q" \\ back\nsecond line; rm -rf /`;
  const { out } = run({
    unset: [],
    env: { NASTY: nasty },
    forced: {},
    bin: "sh",
    args: ["-c", 'printf "%s" "$NASTY"'],
  });
  assert.equal(out, nasty);
});

test("arguments with spaces and quotes survive the exec line too", () => {
  const prompt = `You are Shadok-Boss. Don't "print" $SECRETS;\nnever.`;
  const { out } = run({ unset: [], env: {}, forced: {}, bin: "sh", args: ["-c", 'printf "%s" "$1"', "x", prompt] });
  assert.equal(out, prompt);
});

test("FORCED_CLAUDE_ENV beats a profile secret of the same name", () => {
  // Invariant 29: a profile must never be able to switch transcript writing
  // off, even by accident of naming.
  const { out } = run({
    unset: [],
    env: { CLAUDE_FORCED_THING: "from-profile" },
    forced: { CLAUDE_FORCED_THING: "forced" },
    bin: "sh",
    args: ["-c", 'printf "%s" "$CLAUDE_FORCED_THING"'],
  });
  assert.equal(out, "forced");
});

test("an inherited CLAUDE* marker is stripped before claude starts", () => {
  const { out } = run(
    { unset: ["CLAUDECODE"], env: {}, forced: {}, bin: "sh", args: ["-c", 'printf "%s" "${CLAUDECODE-unset}"'] },
    { CLAUDECODE: "1" },
  );
  assert.equal(out, "unset");
});

test("the script deletes itself before exec — secrets do not stay on disk", () => {
  const { file } = run({ unset: [], env: { S: "v" }, forced: {}, bin: "true", args: [] });
  assert.equal(fs.existsSync(file), false);
});

test("no value is ever an ARGUMENT of a process: exports only, never an env prefix", () => {
  const { script } = launcherScript({
    unset: [],
    env: { DB_PASSWORD: "hunter2-secret" },
    forced: {},
    bin: "claude",
    args: ["--resume", "abc"],
  });
  const execLine = script.split("\n").find((l) => l.startsWith("exec "))!;
  assert.doesNotMatch(execLine, /hunter2-secret/);
  assert.doesNotMatch(execLine, /\benv\b/);
  assert.match(script, /^export DB_PASSWORD='hunter2-secret'$/m);
});

test("a name the shell cannot export is skipped and reported, never half-written", () => {
  const { script, skipped } = launcherScript({
    unset: [],
    env: { "bad-name": "leaky-value", GOOD: "ok" },
    forced: {},
    bin: "true",
    args: [],
  });
  assert.deepEqual(skipped, ["bad-name"]);
  assert.doesNotMatch(script, /leaky-value/);
  assert.match(script, /export GOOD='ok'/);
  assert.equal(isEnvName("revenucat_apikey"), true);
  assert.equal(isEnvName("9lives"), false);
});

test("shellQuote round-trips a single quote", () => {
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote("a'b")}`], { encoding: "utf8" }), "a'b");
});

test("a tmux error names the subcommand and tmux's complaint — never the arguments", () => {
  const args = ["new-session", "-d", "-s", "sk-x", "env 'DB_PASSWORD=hunter2-secret' claude"];
  const msg = tmuxErrorMessage(args, "command too long\n");
  assert.equal(msg, "tmux new-session failed: command too long");
  assert.doesNotMatch(msg, /hunter2/);
  assert.equal(tmuxErrorMessage(["send-keys", "-l", "--", "my private prompt"], undefined), "tmux send-keys failed");
});

const HAVE_TMUX = tmuxAvailable();

test("a spawn carrying 40 KB of secrets now starts (the refused-lead regression)", { skip: !HAVE_TMUX }, async () => {
  // 40 KB is well past tmux's ~16 KB command limit: the old code threw
  // "command too long" here. The child proves it got the WHOLE value.
  const dir = tmp();
  const runDir = path.join(dir, "run");
  const out = path.join(dir, "len.txt");
  const name = `sk-launcher-test-${process.pid}`;
  const big = "x".repeat(40_000);
  const pilot = new TmuxPilot({
    tmuxName: name,
    launcherDir: runDir,
    cwd: dir,
    env: { BIG_SECRET: big },
    claudePath: "sh",
    args: ["-c", `printf %s "\${#BIG_SECRET}" > ${shellQuote(out)}; sleep 30`],
  });
  try {
    pilot.start();
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.readFileSync(out, "utf8"), "40000");
    assert.equal(fs.existsSync(path.join(runDir, `${name}.sh`)), false, "launcher must be gone");
    assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
    assert.equal(tmuxHasSession(name), true);
  } finally {
    tmuxKillSession(name);
  }
});
