import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FORCED_CLAUDE_ENV } from "../src/session.js";

const session = fs.readFileSync("src/session.ts", "utf8");
const tmux = fs.readFileSync("src/tmux.ts", "utf8");

test("the transcript is forced on: a cockpit without one has no content at all", () => {
  assert.equal(FORCED_CLAUDE_ENV.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, "1");
});

test("both transports apply it — a fix in one only is how they drift", () => {
  for (const [name, src] of [["session.ts", session], ["tmux.ts", tmux]] as const) {
    assert.ok(src.includes("FORCED_CLAUDE_ENV"), `${name} never applies FORCED_CLAUDE_ENV`);
  }
});

test("the parent's markers are still stripped — the assertion ADDS to that, it does not replace it", () => {
  // Subtraction still covers the ordinary spawn; the point of the assertion is
  // that it keeps working when a marker we have not heard of turns up.
  for (const [name, src] of [["session.ts", session], ["tmux.ts", tmux]] as const) {
    assert.match(src, /\^\(CLAUDE\|CLAUDECODE\|AI_AGENT\)/, `${name} stopped stripping inherited vars`);
  }
});

test("it is applied LAST, so no profile secret can switch the transcript off", () => {
  // PtyPilot: the object spread that wins is the rightmost one.
  const spawnEnv = session.match(/env: \{ \.\.\.env,[^}]*\}/)?.[0];
  assert.ok(spawnEnv, "could not find PtyPilot's spawn env");
  assert.ok(
    spawnEnv.lastIndexOf("FORCED_CLAUDE_ENV") > spawnEnv.lastIndexOf("this.opts.env"),
    "FORCED_CLAUDE_ENV must come after ...this.opts.env, or a profile can override it",
  );

  // TmuxPilot: `env` applies KEY=VALUE assignments left to right, last wins.
  const cmd = tmux.match(/const cmd = \["env",[^\]]*\]/)?.[0];
  assert.ok(cmd, "could not find TmuxPilot's env command");
  assert.ok(
    cmd.lastIndexOf("...forced") > cmd.lastIndexOf("...secretEnv"),
    "...forced must come after ...secretEnv, or a profile can override it",
  );
});
