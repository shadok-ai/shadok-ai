import assert from "node:assert/strict";
import test from "node:test";
import {
  privilegedInvocation,
  runWithTimeout,
  runPrivileged,
  DEFAULT_PRIVILEGED_TIMEOUT_MS,
  TREE_OP_TIMEOUT_MS,
} from "../src/privileged.js";

// Root runs the command directly; a non-root server goes through non-interactive
// sudo (`-n`) so a missing right fails fast instead of prompting.
test("privilegedInvocation: root runs the command as-is", () => {
  assert.deepEqual(privilegedInvocation("chown", ["-R", "main:main", "/x"], true), {
    cmd: "chown",
    argv: ["-R", "main:main", "/x"],
  });
});

test("privilegedInvocation: non-root wraps the command in `sudo -n`", () => {
  assert.deepEqual(privilegedInvocation("useradd", ["main"], false), {
    cmd: "sudo",
    argv: ["-n", "useradd", "main"],
  });
});

// The bug this module fixes: a command killed by the spawn timeout exits with a
// NULL code (SIGTERM, not a clean exit), and the rejection message reads
// "<cmd> exited with code null". On a large instance the migration's recursive
// `chown -R` over the whole data tree legitimately took longer than the fixed
// 60s and was killed exactly this way — a core migration step, so the marker was
// withheld and the red "isolation did NOT complete" banner stuck forever (the
// tree only grows, so every retry failed the same). Reproduced here with a real
// harmless command; `runWithTimeout` must carry a caller-chosen timeout.
test("runWithTimeout: a command that exceeds its timeout rejects with 'code null' (the SIGTERM kill)", async () => {
  await assert.rejects(
    runWithTimeout({ cmd: "sleep", argv: ["2"] }, "chown", 200),
    (e: Error) => /chown exited with code null/.test(e.message),
  );
});

test("runWithTimeout: a generous timeout lets a slow command finish (the fix)", async () => {
  await assert.doesNotReject(runWithTimeout({ cmd: "sleep", argv: ["0.2"] }, "chown", 5_000));
});

test("runWithTimeout: a non-zero clean exit rejects with that code (not null)", async () => {
  await assert.rejects(
    runWithTimeout({ cmd: "false", argv: [] }, "false", 5_000),
    (e: Error) => /false exited with code 1/.test(e.message),
  );
});

test("runWithTimeout: a clean success resolves", async () => {
  await assert.doesNotReject(runWithTimeout({ cmd: "true", argv: [] }, "true", 5_000));
});

// `runPrivileged` keeps the 60s default for the short account commands
// (useradd/groupadd), but the recursive tree operations must pass the generous
// TREE_OP_TIMEOUT_MS — large enough that a chown/cp over a many-agent instance
// never gets killed, while the migration stays off the boot critical path
// (fire-and-forget), so a slow run can never hang boot.
test("the default privileged timeout stays 60s; the tree-op timeout is far larger", () => {
  assert.equal(DEFAULT_PRIVILEGED_TIMEOUT_MS, 60_000);
  assert.ok(TREE_OP_TIMEOUT_MS >= 15 * 60_000, "a recursive tree chown/cp needs minutes, not 60s");
  assert.ok(TREE_OP_TIMEOUT_MS > DEFAULT_PRIVILEGED_TIMEOUT_MS);
});

// End-to-end only where the server runs as root (no sudo wrapping) — a non-root
// CI would turn `true` into `sudo -n true` and depend on the runner's sudoers.
test(
  "runPrivileged resolves a trivial command (end-to-end through the default path)",
  { skip: typeof process.getuid === "function" && process.getuid() !== 0 },
  async () => {
    await assert.doesNotReject(runPrivileged("true", []));
  },
);
