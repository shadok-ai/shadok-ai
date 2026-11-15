import { spawn as spawnChild } from "node:child_process";

/**
 * Running privileged account/filesystem commands for the multi-tenant migration
 * and group provisioning (useradd, chown, cp over the data tree). Extracted from
 * server.ts so the timeout behaviour — the one that broke a real migration — is
 * unit-testable with harmless commands.
 *
 * The bug: every privileged command shared ONE fixed 60s timeout. That is ample
 * for an account command (useradd/groupadd), but the migration's CORE step is a
 * recursive `chown -R <commons> <tree>` over the WHOLE instance (workspace +
 * every agent's worktree, `~/.claude/projects`, `~/.shadok-ai`). On a busy
 * instance (measured: 28 running agents) that tree is hundreds of thousands of
 * files and the chown ran past 60s, so the spawn timeout SIGTERM'd it. A killed
 * child exits with a NULL code (`code: null, signal: 'SIGTERM'`), surfacing as
 * `chown exited with code null` — and because the chown is a core step, the
 * migration marker was withheld and the red "isolation did NOT complete" banner
 * stuck. It never self-heals: the tree only grows, so every boot retry dies the
 * same way. The fix gives the unbounded recursive operations a generous timeout
 * (`TREE_OP_TIMEOUT_MS`) while the short account commands keep the 60s default.
 * Safe because the migration is fire-and-forget off the boot path, so a slow run
 * can never hang boot.
 */

/** The short account commands (useradd, groupadd, usermod, install, ln…). */
export const DEFAULT_PRIVILEGED_TIMEOUT_MS = 60_000;

/** Recursive operations over the whole data tree (`chown -R`, `cp -r`): bounded
 *  only by the instance's size, so they need minutes, not seconds. Generous on
 *  purpose — the migration is fire-and-forget, so an over-long ceiling costs a
 *  slow migration at worst, never a hung boot. */
export const TREE_OP_TIMEOUT_MS = 20 * 60_000;

/** Decide what actually gets spawned: root runs the command directly; a non-root
 *  server goes through NON-interactive sudo (`-n`) so a MISSING right fails fast
 *  with a non-zero exit instead of prompting. Pure, so the sudo decision is
 *  testable without being root. */
export function privilegedInvocation(
  cmd: string,
  argv: string[],
  isRoot: boolean,
): { cmd: string; argv: string[] } {
  return isRoot ? { cmd, argv } : { cmd: "sudo", argv: ["-n", cmd, ...argv] };
}

/** Spawn `spawn.cmd spawn.argv` with a timeout, rejecting with `<label> exited
 *  with code <code>` on a non-zero/null exit. `label` is the ORIGINAL command
 *  name (not `sudo`), so the message names the real failing step; a timeout kill
 *  gives `code: null` → "<label> exited with code null". */
export function runWithTimeout(
  spawn: { cmd: string; argv: string[] },
  label: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawnChild(spawn.cmd, spawn.argv, { stdio: ["ignore", "inherit", "inherit"], timeout: timeoutMs });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`))));
  });
}

/** Run a privileged account/filesystem command. Pass `{ timeoutMs:
 *  TREE_OP_TIMEOUT_MS }` for an unbounded recursive operation; otherwise the 60s
 *  default applies. */
export function runPrivileged(cmd: string, argv: string[], opts?: { timeoutMs?: number }): Promise<void> {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return runWithTimeout(privilegedInvocation(cmd, argv, isRoot), cmd, opts?.timeoutMs ?? DEFAULT_PRIVILEGED_TIMEOUT_MS);
}
