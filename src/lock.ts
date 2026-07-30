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

/** Whether a process with `pid` is currently running. */
export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists but owned by another user → still alive
  }
}

/**
 * Try to become the single instance for this launch dir. Returns { ok: true }
 * when the lock is held, or { ok: false, pid } when a LIVE instance already
 * holds it. A stale lock (dead holder) is reclaimed.
 */
export function acquireInstanceLock(lockPath = instanceLockPath()): { ok: true } | { ok: false; pid: number } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // atomic create-if-absent
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10) || 0; } catch { /* unreadable */ }
      if (pid && pid !== process.pid && pidAlive(pid)) return { ok: false, pid };
      try { fs.rmSync(lockPath); } catch { /* someone else cleared it */ } // stale → retry
    }
  }
  return { ok: true }; // no live holder observed after clearing a stale lock
}

/** Release our lock (best effort) — only if we still hold it. */
export function releaseInstanceLock(lockPath = instanceLockPath()): void {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10) || 0;
    if (pid === process.pid) fs.rmSync(lockPath);
  } catch { /* not ours, or already gone */ }
}
