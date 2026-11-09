import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireInstanceLock,
  releaseInstanceLock,
  pidAlive,
  stateFromProcStat,
  startTimeFromProcStat,
  parseLockFile,
  formatLockFile,
  holderStillThere,
} from "../src/lock.js";

function tmpLock(): string {
  return path.join(os.tmpdir(), `shadok-lock-test-${process.pid}-${test.name || "x"}.lock`);
}

test("pidAlive: this process is alive, a bogus pid is not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false); // absurd pid
  assert.equal(pidAlive(0), false);
});

test("acquireInstanceLock: first acquire wins, holds until released", () => {
  const p = tmpLock();
  fs.rmSync(p, { force: true });
  const a = acquireInstanceLock(p);
  assert.deepEqual(a, { ok: true });
  assert.equal(parseLockFile(fs.readFileSync(p, "utf8")).pid, process.pid);
  releaseInstanceLock(p);
  assert.equal(fs.existsSync(p), false);
});

test("acquireInstanceLock: a lock held by a LIVE OTHER pid blocks a second acquire", () => {
  const p = tmpLock() + ".live";
  fs.writeFileSync(p, "1"); // pid 1 = init/launchd: alive and not us
  const r = acquireInstanceLock(p);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.pid, 1);
  fs.rmSync(p, { force: true });
});

test("acquireInstanceLock: a stale lock (dead pid) is reclaimed", () => {
  const p = tmpLock() + ".stale";
  fs.writeFileSync(p, String(2 ** 30)); // a pid that isn't running
  const r = acquireInstanceLock(p);
  assert.deepEqual(r, { ok: true });
  assert.equal(parseLockFile(fs.readFileSync(p, "utf8")).pid, process.pid);
  fs.rmSync(p, { force: true });
});

test("releaseInstanceLock: never deletes a lock owned by someone else", () => {
  const p = tmpLock() + ".other";
  fs.writeFileSync(p, String(2 ** 30)); // not our pid
  releaseInstanceLock(p);
  assert.equal(fs.existsSync(p), true); // left intact
  fs.rmSync(p, { force: true });
});

// ── A zombie is not a live instance ──────────────────────────────────────
// `kill(pid, 0)` succeeds on a zombie: the process has exited, but nobody has
// reaped it, so its pid entry survives. In a container that is the normal case
// — pid 1 is the application, not an init that reaps — so a stopped instance
// held its launch dir's lock FOREVER, and every later start was refused,
// naming a pid that no longer exists.

test("stateFromProcStat: reads the state letter", () => {
  assert.equal(stateFromProcStat("42 (node) Z 1 42 42 0 -1 4194560 0"), "Z");
  assert.equal(stateFromProcStat("42 (node) S 1 42 42 0 -1 4194560 0"), "S");
  assert.equal(stateFromProcStat("42 (node) R 1 42"), "R");
});

test("stateFromProcStat: a command name with spaces and parentheses still parses", () => {
  // The comm field is parenthesised and arbitrary; splitting from the LEFT
  // mis-reads any process whose name contains a space or a bracket.
  assert.equal(stateFromProcStat("7 (my weird (cmd)) Z 1 7"), "Z");
  assert.equal(stateFromProcStat("7 (a b c) S 1 7"), "S");
});

test("stateFromProcStat: junk yields null rather than a wrong letter", () => {
  assert.equal(stateFromProcStat(""), null);
  assert.equal(stateFromProcStat("no parens here"), null);
  assert.equal(stateFromProcStat("42 (node)"), null);
});

test("pidAlive: a zombie is dead, a sleeping process is alive", () => {
  const zombie = () => "1 (node) Z 1 1 1 0 -1 0 0";
  const sleeping = () => "1 (node) S 1 1 1 0 -1 0 0";
  assert.equal(pidAlive(process.pid, zombie), false);
  assert.equal(pidAlive(process.pid, sleeping), true);
});

test("pidAlive: no /proc (macOS) falls back to the signal answer", () => {
  // The reader returns null when it cannot look; the kill(0) verdict stands.
  assert.equal(pidAlive(process.pid, () => null), true);
});

test("acquireInstanceLock: a zombie holder's lock is reclaimed", () => {
  const f = path.join(os.tmpdir(), `shadok-zombie-${process.pid}.lock`);
  fs.writeFileSync(f, String(process.pid)); // a pid that answers signal 0
  try {
    assert.deepEqual(acquireInstanceLock(f, () => "1 (node) Z 1 1"), { ok: true });
    assert.equal(parseLockFile(fs.readFileSync(f, "utf8")).pid, process.pid);
  } finally {
    fs.rmSync(f, { force: true });
  }
});

// ── A pid number is not an identity ──────────────────────────────────────
// In a container, pid numbers restart from 1 on every container restart and the
// server lands around 15 — so the number the previous run wrote is, next boot,
// almost certainly worn by an unrelated process. Observed in production: the
// cockpit refused to start, named `pid 14` (a node the supervisor had just
// spawned), exited 0, and the container stayed down looking like a clean stop.

test("startTimeFromProcStat: reads field 22, the start time", () => {
  // 1       2       3 4 5 6 7  8  9       10 11 12 13 14 15 16 17 18 19 20 21 22
  const line = "42 (node) S 1 42 42 0 -1 4194560 0 0 0 0 11 2 0 0 20 0 24 0 987654 ...";
  assert.equal(startTimeFromProcStat(line), "987654");
});

test("startTimeFromProcStat: a command name with spaces and brackets still parses", () => {
  const line = "7 (a (weird) name) S 1 7 7 0 -1 0 0 0 0 0 1 1 0 0 20 0 2 0 555 x";
  assert.equal(startTimeFromProcStat(line), "555");
});

test("startTimeFromProcStat: a truncated line yields null rather than a wrong number", () => {
  assert.equal(startTimeFromProcStat("42 (node) S 1 42"), null);
  assert.equal(startTimeFromProcStat("no parens"), null);
});

test("parseLockFile: reads both shapes, old and new", () => {
  assert.deepEqual(parseLockFile("15\n"), { pid: 15, start: null }); // written before this change
  assert.deepEqual(parseLockFile("15 987654\n"), { pid: 15, start: "987654" });
  assert.deepEqual(parseLockFile("junk"), { pid: 0, start: null });
});

test("formatLockFile: still STARTS with the pid, so an older reader is not misled", () => {
  assert.equal(formatLockFile(15, "987654"), "15 987654");
  assert.equal(formatLockFile(15, null), "15");
  assert.equal(parseLockFile(formatLockFile(15, "987654")).pid, 15);
});

test("holderStillThere: a reused pid is NOT the holder", () => {
  // Same number, born on another tick: that is the container-restart case.
  const live = () => "15 (node) S 1 15 15 0 -1 0 0 0 0 0 1 1 0 0 20 0 2 0 999 x";
  assert.equal(holderStillThere(process.pid, "111", live), false);
  assert.equal(holderStillThere(process.pid, "999", live), true);
});

test("holderStillThere: a lock with no start time keeps the old pid-only verdict", () => {
  const live = () => "15 (node) S 1 15 15 0 -1 0 0 0 0 0 1 1 0 0 20 0 2 0 999 x";
  assert.equal(holderStillThere(process.pid, null, live), true);
  assert.equal(holderStillThere(2 ** 30, null, live), false);
});

test("holderStillThere: no /proc (macOS) trusts the pid, as before", () => {
  assert.equal(holderStillThere(process.pid, "111", () => null), true);
});

test("acquireInstanceLock: a lock whose pid is no longer the holder is reclaimed", () => {
  // The regression this fixes end to end: an alive pid, a start time that says
  // it is somebody else. Before the fix the acquire was REFUSED and the server
  // exited 0.
  const f = path.join(os.tmpdir(), `shadok-reused-${process.pid}.lock`);
  // pid 1 stands in for the production case: alive, not us, and NOT the holder
  // the lock was written by — the reader below says it was born on tick 999.
  fs.writeFileSync(f, formatLockFile(1, "111")); // alive pid, foreign birth
  try {
    const live = () => "15 (node) S 1 15 15 0 -1 0 0 0 0 0 1 1 0 0 20 0 2 0 999 x";
    assert.deepEqual(acquireInstanceLock(f, live), { ok: true });
    assert.deepEqual(parseLockFile(fs.readFileSync(f, "utf8")), { pid: process.pid, start: "999" });
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test("acquireInstanceLock: a REAL live instance is still refused", () => {
  // The lock must keep doing its job: same pid, same birth → that is the holder.
  const f = path.join(os.tmpdir(), `shadok-realholder-${process.pid}.lock`);
  const live = () => "15 (node) S 1 15 15 0 -1 0 0 0 0 0 1 1 0 0 20 0 2 0 999 x";
  fs.writeFileSync(f, formatLockFile(1, "999")); // pid 1 is alive and is not us
  try {
    const r = acquireInstanceLock(f, live);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.pid, 1);
  } finally {
    fs.rmSync(f, { force: true });
  }
});
