import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BUSY_LATCH_GRACE_MS,
  busyLatchLog,
  busyLatchVerdict,
  type BusyLatchInput,
} from "../src/busy-latch.js";

// The incident's shape: the flag is up, the pane is at an empty prompt, and
// none of the four things that may hold it is holding it.
const LATCHED: BusyLatchInput = {
  busy: true,
  turnInFlight: false,
  submitting: false,
  recovering: false,
  restarting: false,
  working: false,
  since: null,
  now: 1_000_000,
  graceMs: BUSY_LATCH_GRACE_MS,
};

test("busyLatchVerdict: an idle agent is never touched", () => {
  assert.deepEqual(busyLatchVerdict({ ...LATCHED, busy: false }).action, "none");
  // Even long past the grace window: there is nothing to take back.
  assert.deepEqual(
    busyLatchVerdict({ ...LATCHED, busy: false, since: 0 }).action,
    "none",
  );
});

test("busyLatchVerdict: each legitimate holder keeps the flag, alone", () => {
  for (const key of ["turnInFlight", "submitting", "recovering", "restarting"] as const) {
    const held = { ...LATCHED, [key]: true, since: 0 };
    assert.equal(busyLatchVerdict(held).action, "none", `${key} must keep busy`);
  }
});

test("busyLatchVerdict: a pane that shows work keeps the flag", () => {
  // `screenShowsWork` is the fragile heuristic of invariant 2, so it may only
  // ever KEEP the flag up — never bring it down on its own.
  assert.equal(busyLatchVerdict({ ...LATCHED, working: true, since: 0 }).action, "none");
});

test("busyLatchVerdict: the window starts at the first poll, never earlier", () => {
  const v = busyLatchVerdict(LATCHED);
  assert.deepEqual(v, { action: "watch", since: LATCHED.now });
  // A `since` we never observed would clear on the very first poll — which is
  // the race the window exists to rule out.
  assert.equal(busyLatchVerdict({ ...LATCHED, since: LATCHED.now }).action, "watch");
});

test("busyLatchVerdict: cleared only once the window has fully elapsed", () => {
  const since = LATCHED.now - BUSY_LATCH_GRACE_MS + 1;
  assert.equal(busyLatchVerdict({ ...LATCHED, since }).action, "watch");
  assert.equal(
    busyLatchVerdict({ ...LATCHED, since: LATCHED.now - BUSY_LATCH_GRACE_MS }).action,
    "clear",
  );
  assert.equal(busyLatchVerdict({ ...LATCHED, since: 0 }).action, "clear");
});

test("busyLatchVerdict: a holder appearing mid-window cancels it", () => {
  // The caller forgets `since` on anything but "watch", so a submit that
  // starts 14 s in does not get cleared 1 s later.
  const almost = { ...LATCHED, since: LATCHED.now - BUSY_LATCH_GRACE_MS + 1_000 };
  assert.equal(busyLatchVerdict({ ...almost, submitting: true }).action, "none");
});

test("busyLatchVerdict: the grace window outlasts the longest guarded submit", () => {
  // `typeIntoBox` retries 6 times over ~3.4 s each, so a submit alone can run
  // ~20 s. That stretch is covered by `submitting`, not by the window — but a
  // window shorter than a few seconds would race the ordinary gaps between two
  // holders, so keep it comfortably above the `run` handler's 5 s shell wait.
  assert.ok(BUSY_LATCH_GRACE_MS >= 10_000);
});

test("busyLatchLog: names the agent, the duration and the consequence", () => {
  const line = busyLatchLog("abcd1234-ef", 42_000);
  assert.match(line, /\[sk-abcd1234-ef\]/);
  assert.match(line, /42s/);
  assert.match(line, /unreachable/);
});

// ── Wiring, by source scan: server.ts cannot be imported (it starts a server) ──
const SERVER = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

test("server: finishTurn raises busy and then enters the try at once", () => {
  const body = SERVER.slice(SERVER.indexOf("async function finishTurn(s: Live) {"));
  const head = body.slice(0, body.indexOf("await s.pilot.waitForIdle"));
  // Nothing that can throw may sit between raising the flag and the `try` that
  // lowers it: that gap is what left an agent refusing every prompt, silently.
  assert.match(head, /s\.busy = true;[\s\S]*?s\.turnWaiters\+\+;\s*\n\s*try \{/);
  for (const risky of ["lastPromptAt(", "findTransientErrors(", "broadcast(s, workingMessage(s))"]) {
    const at = head.indexOf(risky);
    assert.ok(at > head.indexOf("try {"), `${risky} must sit inside finishTurn's try`);
  }
});

test("server: finishTurn's finally releases the waiter and the window", () => {
  const fin = SERVER.slice(SERVER.indexOf("async function finishTurn(s: Live) {"));
  const tail = fin.slice(fin.indexOf("} finally {"), fin.indexOf("flushParentInbox(s.id);"));
  assert.match(tail, /s\.turnWaiters = Math\.max\(0, s\.turnWaiters - 1\)/);
  assert.match(tail, /s\.busy = false;/);
  assert.match(tail, /s\.busyLatchSince = null;/);
});

test("server: the screen watcher asks the verdict and takes the flag back", () => {
  assert.match(SERVER, /busyLatchVerdict\(\{/);
  assert.match(SERVER, /graceMs: BUSY_LATCH_GRACE_MS/);
  assert.match(SERVER, /if \(verdict\.action === "watch"\) s\.busyLatchSince = verdict\.since;/);
  assert.match(SERVER, /releaseBusyLatch\(s, now - \(heldSince \?\? now\)\)/);
});

test("server: a release says the turn is over, so clients and Telegram move on", () => {
  const fn = SERVER.slice(SERVER.indexOf("function releaseBusyLatch("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /console\.error\(busyLatchLog\(/);
  assert.match(body, /s\.busy = false;/);
  assert.match(body, /s\.turnStartedAt = null;/);
  // `turn-done` is what the Telegram bridge waits on to replay the message it
  // preempted — without it the message that hit the latch is lost.
  assert.match(body, /type: "turn-done"/);
  assert.match(body, /flushParentInbox\(s\.id\)/);
  // NOT an interrupt: there is no turn to stop.
  assert.doesNotMatch(body, /press\(|escape/);
});

test("server: no finishTurn call swallows its error any more", () => {
  // Both callers that nobody awaits — the spontaneous resume and the auto-retry
  // — used to drop whatever finishTurn threw. That silence is how a flag left
  // up here stayed invisible for forty minutes.
  assert.doesNotMatch(SERVER, /finishTurn\(s\)\.catch\(\(\) => \{\}\)/);
  assert.match(SERVER, /finishTurn \(spontaneous resume\) failed/);
  assert.match(SERVER, /finishTurn \(auto-retry\) failed/);
});

test("server: every submit that holds busy goes through submitGuarded", () => {
  // The auto-retry used to type its "continue" with a bare `pilot.submit`, so
  // nothing said a submit was in flight while `busy` was up.
  assert.doesNotMatch(SERVER, /await s\.pilot\.submit\("continue"\)/);
  assert.match(SERVER, /await submitGuarded\(s, "continue"\)/);
});
