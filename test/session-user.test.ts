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

function captureSpawn(fn: () => void): { file: string; args: string[] } {
  const real = pty.spawn;
  let captured: { file: string; args: string[] } | null = null;
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
  (pty as unknown as { spawn: unknown }).spawn = (file: string, args: string[]) => {
    captured = { file, args };
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
