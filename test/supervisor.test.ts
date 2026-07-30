import assert from "node:assert/strict";
import test from "node:test";
import {
  nextAction,
  runSupervisor,
  UPDATE_EXIT_CODE,
  RELOAD_EXIT_CODE,
  DEFAULT_BACKOFF,
} from "../src/supervisor.js";

test("nextAction: clean exit stops, code 75 updates, code 76 reloads", () => {
  assert.deepEqual(nextAction(0, [], 1000), { kind: "stop" });
  assert.deepEqual(nextAction(UPDATE_EXIT_CODE, [], 1000), { kind: "update" });
  assert.deepEqual(nextAction(RELOAD_EXIT_CODE, [], 1000), { kind: "reload" });
});

test("nextAction: a reload does not count toward the crash cap", () => {
  const now = 100_000;
  // Even with the window full of crashes, a reload just respawns (no give-up).
  const many = Array.from({ length: 10 }, (_, i) => now - i);
  assert.deepEqual(nextAction(RELOAD_EXIT_CODE, many, now), { kind: "reload" });
});

test("nextAction: a crash respawns with exponential backoff", () => {
  const now = 100_000;
  // 0 recent crashes → base delay
  assert.deepEqual(nextAction(1, [], now), { kind: "respawn", delayMs: 1000 });
  // 2 recent crashes → 1000 * 2^2
  assert.deepEqual(nextAction(1, [now - 1, now - 2], now), { kind: "respawn", delayMs: 4000 });
});

test("nextAction: backoff is capped at maxMs", () => {
  const now = 100_000;
  const opts = { windowMs: 60_000, cap: 10, baseMs: 1000, maxMs: 5000 };
  const many = Array.from({ length: 4 }, (_, i) => now - i); // 1000*2^4=16000 → capped
  assert.deepEqual(nextAction(1, many, now, opts), { kind: "respawn", delayMs: 5000 });
});

test("nextAction: too many crashes in the window gives up", () => {
  const now = 100_000;
  const five = Array.from({ length: 5 }, (_, i) => now - i * 100);
  const a = nextAction(1, five, now);
  assert.equal(a.kind, "give-up");
});

test("nextAction: crashes outside the window don't count", () => {
  const now = 100_000;
  const old = Array.from({ length: 5 }, (_, i) => now - DEFAULT_BACKOFF.windowMs - i);
  // all older than the window → treated as 0 recent → base delay
  assert.deepEqual(nextAction(1, old, now), { kind: "respawn", delayMs: 1000 });
});

test("runSupervisor: update triggers install + result write, then a clean stop ends it", async () => {
  const events: string[] = [];
  let call = 0;
  const code = await runSupervisor({
    spawnServer: async () => {
      call++;
      return call === 1 ? UPDATE_EXIT_CODE : 0; // update once, then stop
    },
    update: async () => {
      events.push("update");
      return { ok: true, version: "9.9.9" };
    },
    writeUpdateResult: (r) => events.push("wrote:" + (r.ok ? r.version : r.error)),
    sleep: async () => {},
    now: () => 0,
    log: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(events, ["update", "wrote:9.9.9"]);
});

test("runSupervisor: gives up after repeated crashes", async () => {
  let n = 0;
  const code = await runSupervisor(
    {
      spawnServer: async () => {
        n++;
        return 1; // always crash
      },
      update: async () => ({ ok: true, version: "x" }),
      writeUpdateResult: () => {},
      sleep: async () => {},
      now: () => 0, // frozen clock → all crashes land in the same window
      log: () => {},
    },
    { windowMs: 1000, cap: 3, baseMs: 1, maxMs: 4 },
  );
  assert.equal(code, 1);
  assert.equal(n, 4); // 1 initial + 3 respawns, then gives up on the 4th crash
});
