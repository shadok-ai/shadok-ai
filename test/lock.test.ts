import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireInstanceLock, releaseInstanceLock, pidAlive } from "../src/lock.js";

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
