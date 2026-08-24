import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireInstanceLock, releaseInstanceLock, pidAlive, stateFromProcStat } from "../src/lock.js";

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
  assert.equal(fs.readFileSync(p, "utf8").trim(), String(process.pid));
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
  assert.equal(fs.readFileSync(p, "utf8").trim(), String(process.pid));
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
    assert.equal(fs.readFileSync(f, "utf8").trim(), String(process.pid));
  } finally {
    fs.rmSync(f, { force: true });
  }
});
