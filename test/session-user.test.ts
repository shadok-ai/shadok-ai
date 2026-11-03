import { test } from "node:test";
import assert from "node:assert/strict";
import pty from "node-pty";
import { PtyPilot } from "../src/session.js";
import { launcherScript } from "../src/tmux.js";

/**
 * The privilege drop has to reach the ACTUAL spawn — a field threaded through
 * the options is not a field used (invariant 24). We capture the real spawn
 * rather than trust the types: `pty.spawn` is monkeypatched to record its
 * (file, args) and return a stub IPty, so the PtyPilot class runs its real
 * start() path without ever launching a process. The tmux transport puts the
 * wrapper on the launcher's `exec` line, so that half is asserted on the pure
 * `launcherScript` output (the exact string the pane runs).
 */

function captureSpawn(fn: () => void): { file: string; args: string[]; env: Record<string, string> } {
  const real = pty.spawn;
  let captured: { file: string; args: string[]; env: Record<string, string> } | null = null;
  // Minimal IPty stub: start() only wires onData/onExit and may write back.
  const stub = {
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
    pid: 1,
    cols: 100,
    rows: 40,
    process: "stub",
  };
  (pty as unknown as { spawn: unknown }).spawn = (
    file: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ) => {
    captured = { file, args, env: opts?.env ?? {} };
    return stub;
  };
  try {
    fn();
  } finally {
    (pty as unknown as { spawn: unknown }).spawn = real;
  }
  assert.ok(captured, "pty.spawn was never called");
  return captured!;
}

test("PtyPilot: with a user, the spawn is wrapped in setpriv dropping to that user", () => {
  const cap = captureSpawn(() => {
    const p = new PtyPilot({ claudePath: "/usr/bin/claude", args: ["--resume", "x"], user: "sk-comex" });
    p.start();
  });
  assert.equal(cap.file, "setpriv");
  assert.deepEqual(cap.args, [
    "--reuid", "sk-comex", "--regid", "sk-comex", "--init-groups", "--",
    "/usr/bin/claude", "--resume", "x",
  ]);
});

test("PtyPilot: with NO user, the spawn is byte-for-byte today's — the binary itself, no wrapper", () => {
  const cap = captureSpawn(() => {
    const p = new PtyPilot({ claudePath: "/usr/bin/claude", args: ["--resume", "x"] });
    p.start();
  });
  assert.equal(cap.file, "/usr/bin/claude");
  assert.deepEqual(cap.args, ["--resume", "x"]);
});

test("PtyPilot: a drop user sets HOME/USER/LOGNAME to that user's own (setpriv keeps the server's otherwise)", () => {
  const cap = captureSpawn(() => {
    const p = new PtyPilot({
      claudePath: "/usr/bin/claude",
      args: ["--resume", "x"],
      user: "sk-comex",
      home: "/home/sk-comex",
    });
    p.start();
  });
  // Without this the dropped agent keeps the server's HOME=/root and never
  // reaches its per-group ~/.claude — auth + skills break (CRITICAL #4).
  assert.equal(cap.env.HOME, "/home/sk-comex");
  assert.equal(cap.env.USER, "sk-comex");
  assert.equal(cap.env.LOGNAME, "sk-comex");
});

test("PtyPilot: with NO user, HOME is NOT forced (the spawn env is byte-for-byte today's)", () => {
  const prevHome = process.env.HOME;
  process.env.HOME = "/root";
  try {
    const cap = captureSpawn(() => {
      const p = new PtyPilot({ claudePath: "/usr/bin/claude", args: ["x"] });
      p.start();
    });
    // No drop → dropEnv is {} → HOME is whatever was inherited, USER/LOGNAME
    // untouched by us.
    assert.equal(cap.env.HOME, "/root");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("TmuxPilot launcher: a drop user exports HOME/USER/LOGNAME, after the profile env, before forced", () => {
  const { script } = launcherScript({
    unset: [],
    env: { DB_PASSWORD: "hunter2" },
    forced: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" },
    bin: "claude",
    args: [],
    user: "sk-comex",
    home: "/home/sk-comex",
  });
  assert.match(script, /^export HOME='\/home\/sk-comex'$/m);
  assert.match(script, /^export USER='sk-comex'$/m);
  assert.match(script, /^export LOGNAME='sk-comex'$/m);
  const lines = script.split("\n");
  const idx = (needle: string) => lines.findIndex((l) => l.includes(needle));
  // After the profile secret (so it overrides the inherited HOME), before forced.
  assert.ok(idx("DB_PASSWORD") < idx("export HOME="), "HOME exported after the profile env");
  assert.ok(idx("export HOME=") < idx("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"), "HOME before forced");
});

test("TmuxPilot launcher: with NO user, no HOME/USER/LOGNAME export (byte-for-byte today's)", () => {
  const { script } = launcherScript({
    unset: [],
    env: {},
    forced: {},
    bin: "claude",
    args: ["x"],
  });
  assert.doesNotMatch(script, /^export HOME=/m);
  assert.doesNotMatch(script, /^export (USER|LOGNAME)=/m);
});

test("TmuxPilot launcher: a user wraps the exec line in setpriv, binary after --", () => {
  const { script } = launcherScript({
    unset: [],
    env: { DB_PASSWORD: "hunter2" },
    forced: {},
    bin: "claude",
    args: ["--resume", "abc"],
    user: "sk-comex",
  });
  const exec = script.split("\n").find((l) => l.startsWith("exec "))!;
  assert.equal(
    exec,
    "exec 'setpriv' '--reuid' 'sk-comex' '--regid' 'sk-comex' '--init-groups' '--' 'claude' '--resume' 'abc'",
  );
  // The env is still EXPORTED (set in the root shell before the drop), never an
  // argument — setpriv preserves it across the exec.
  assert.match(script, /^export DB_PASSWORD='hunter2'$/m);
});

test("TmuxPilot launcher: with NO user the exec line is byte-for-byte today's (no wrapper)", () => {
  const { script } = launcherScript({
    unset: [],
    env: {},
    forced: {},
    bin: "claude",
    args: ["--resume", "abc"],
  });
  const exec = script.split("\n").find((l) => l.startsWith("exec "))!;
  assert.equal(exec, "exec 'claude' '--resume' 'abc'");
});
