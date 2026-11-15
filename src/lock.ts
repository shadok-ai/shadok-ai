import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Single-instance lock, keyed by launch directory (like the channel registry).
 *
 * Two servers running from the same directory share the same registry + the
 * `telegram-group` config, and each starts its own Telegram bridge on the same
 * bot. Concurrent writes corrupt the config (a bound board group id once leaked
 * in from a stale instance, then reconcile deleted every channel). A per-dir
 * lock makes the second instance refuse to start instead of fighting.
 */

/** The lock file for the instance launched in `cwd` (default: process.cwd()). */
export function instanceLockPath(cwd = process.cwd()): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".shadok-ai", "locks", enc + ".lock");
}

/**
 * Pure: the process state letter from a `/proc/<pid>/stat` line, or null when
 * the line is unusable.
 *
 * Read from the LAST `)`: the second field is the command name, parenthesised
 * and arbitrary, so it may itself contain spaces and brackets. Splitting from
 * the left mis-parses every process whose name has one.
 */
export function stateFromProcStat(contents: string): string | null {
  const close = contents.lastIndexOf(")");
  if (close < 0) return null;
  const [state] = contents.slice(close + 1).trim().split(/\s+/);
  return state || null;
}

/**
 * Pure: the process's start time from a `/proc/<pid>/stat` line — field 22,
 * ticks since the machine booted — or null when the line is unusable.
 *
 * This is what tells a pid APART from the pid number. Parsed from the last `)`
 * for the same reason as `stateFromProcStat`: the parenthesised command name is
 * arbitrary. The fields after it start at `state` (field 3), so field 22 sits at
 * index 19.
 */
export function startTimeFromProcStat(contents: string): string | null {
  const close = contents.lastIndexOf(")");
  if (close < 0) return null;
  const fields = contents.slice(close + 1).trim().split(/\s+/);
  return fields[19] || null;
}

/** What a holder wrote: its pid, and its start time when the version that wrote
 *  it recorded one (older locks hold a bare number). Pure. */
export function parseLockFile(contents: string): { pid: number; start: string | null } {
  const [pid, start] = contents.trim().split(/\s+/);
  return { pid: parseInt(pid, 10) || 0, start: start || null };
}

/** The line we write. Pure. Legacy-readable: it still STARTS with the pid. */
export function formatLockFile(pid: number, start: string | null): string {
  return start ? `${pid} ${start}` : String(pid);
}

/** How `pidAlive` looks a process up; injected in tests. */
export type ProcStatReader = (pid: number) => string | null;

const readProcStat: ProcStatReader = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null; // no /proc (macOS), or the process just vanished
  }
};

/**
 * Whether a process with `pid` is currently running.
 *
 * A **zombie** answers signal 0: it has exited, but nobody has reaped it, so
 * its pid entry survives. That is the normal case in a container, where pid 1
 * is the application rather than an init that reaps — so a stopped instance
 * held its launch directory's lock forever, and every later start was refused
 * while naming a pid that no longer existed. `/proc` is Linux-only; where it is
 * absent the signal's answer stands.
 */
export function pidAlive(pid: number, procStat: ProcStatReader = readProcStat): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
  } catch (e: any) {
    return e?.code === "EPERM"; // exists but owned by another user → still alive
  }
  const stat = procStat(pid);
  return stat === null ? true : stateFromProcStat(stat) !== "Z";
}

/**
 * Is the process that TOOK this lock still there?
 *
 * Not the same question as "is some process wearing that pid", and in a
 * container they come apart: pid numbers restart from 1 on every container
 * restart, and the server itself lands around 15 — so the number the previous
 * run wrote is, next boot, almost certainly worn by an unrelated process (one
 * of the supervisor's own children). That false positive made the cockpit
 * refuse to start, naming a pid that had nothing to do with it, and exit 0 —
 * so the container stayed down looking like a clean stop. Observed in
 * production: `another instance is already running from this directory
 * (pid 14) — exiting`, where 14 was a node the supervisor had just spawned.
 *
 * The start time settles it: a reused pid would have to have been born on the
 * same clock tick as the holder. An older lock carries no start time, so there
 * the pid is all we have and the previous behaviour stands — a stale one is
 * cleared by the next successful acquire, which writes both.
 */
export function holderStillThere(
  pid: number,
  start: string | null,
  procStat: ProcStatReader = readProcStat,
): boolean {
  if (!pidAlive(pid, procStat)) return false;
  if (!start) return true; // legacy lock: nothing to compare against
  const stat = procStat(pid);
  if (stat === null) return true; // no /proc: the pid's answer is all there is
  const live = startTimeFromProcStat(stat);
  return live === null || live === start;
}

/** Our own start time, for the lock we are about to write (null off Linux). */
function ownStartTime(procStat: ProcStatReader): string | null {
  const stat = procStat(process.pid);
  return stat === null ? null : startTimeFromProcStat(stat);
}

/**
 * Try to become the single instance for this launch dir. Returns { ok: true }
 * when the lock is held, or { ok: false, pid } when a LIVE instance already
 * holds it. A stale lock — a dead holder, or a pid the holder no longer is — is
 * reclaimed.
 */
export function acquireInstanceLock(
  lockPath = instanceLockPath(),
  procStat: ProcStatReader = readProcStat,
): { ok: true } | { ok: false; pid: number } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // atomic create-if-absent
      fs.writeSync(fd, formatLockFile(process.pid, ownStartTime(procStat)));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let held = { pid: 0, start: null as string | null };
      try { held = parseLockFile(fs.readFileSync(lockPath, "utf8")); } catch { /* unreadable */ }
      const { pid, start } = held;
      if (pid && pid !== process.pid && holderStillThere(pid, start, procStat)) return { ok: false, pid };
      try { fs.rmSync(lockPath); } catch { /* someone else cleared it */ } // stale → retry
    }
  }
  return { ok: true }; // no live holder observed after clearing a stale lock
}

/** Release our lock (best effort) — only if we still hold it. */
export function releaseInstanceLock(lockPath = instanceLockPath()): void {
  try {
    const { pid } = parseLockFile(fs.readFileSync(lockPath, "utf8"));
    if (pid === process.pid) fs.rmSync(lockPath);
  } catch { /* not ours, or already gone */ }
}
