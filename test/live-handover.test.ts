import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { supersedeSession } from "../src/live-handover.js";

// The regression these lock (shared-ledger [5d8d]): a session's pilot exits
// while viewers are still attached; a resume makes a NEW Live and the registry
// entry is replaced, orphaning the old Live's clients. They keep seeing the
// agent's answers (the old tail runs on the same transcript) but miss every
// broadcast on the new Live — the other interfaces' prompt echoes above all.
// The cure is one Live per agent: hand the clients over and quiet the old Live
// WITHOUT killing the shared pane or resetting the shared tail position.

const fakeWs = (): WebSocket => ({ readyState: 1 }) as unknown as WebSocket;

function fakeLive() {
  let tailStopped = 0;
  let rawOffCalled = 0;
  return {
    clients: new Set<WebSocket>(),
    rawClients: new Set<WebSocket>(),
    screenTimer: null as ReturnType<typeof setInterval> | null,
    idleTimer: null as ReturnType<typeof setTimeout> | null,
    retryTimer: null as ReturnType<typeof setTimeout> | null,
    stopTail: (() => {
      tailStopped++;
    }) as (() => void) | null,
    rawOff: (() => {
      rawOffCalled++;
    }) as (() => void) | null,
    // Not part of HandoverLive — present only so the test can PROVE the agent is
    // never killed by the handover.
    pilot: { killed: 0, kill() { this.killed++; } },
    spy: () => ({ tailStopped, rawOffCalled }),
  };
}

test("supersedeSession moves every viewer to the succeeding Live", () => {
  const oldLive = fakeLive();
  const next = fakeLive();
  const a = fakeWs();
  const b = fakeWs();
  oldLive.clients.add(a);
  oldLive.clients.add(b);

  const moved = supersedeSession(oldLive, next);

  assert.equal(moved, 2);
  assert.equal(oldLive.clients.size, 0, "retired Live keeps no viewers");
  assert.ok(next.clients.has(a) && next.clients.has(b), "both viewers now on the new Live");
});

test("supersedeSession merges into viewers the new Live already has", () => {
  const oldLive = fakeLive();
  const next = fakeLive();
  const resumer = fakeWs(); // e.g. the Telegram bridge / cron that triggered the resume
  const orphan = fakeWs(); // the web tab left on the old Live
  next.clients.add(resumer);
  oldLive.clients.add(orphan);

  supersedeSession(oldLive, next);

  assert.ok(next.clients.has(resumer) && next.clients.has(orphan), "both kept");
  assert.equal(next.clients.size, 2);
});

test("supersedeSession quiets the old Live but NEVER kills the agent or clears the tail position", () => {
  const oldLive = fakeLive();
  const next = fakeLive();
  // Live timers that would otherwise keep firing on a retired Live.
  oldLive.screenTimer = setInterval(() => {}, 1_000_000);
  oldLive.idleTimer = setTimeout(() => {}, 1_000_000);
  oldLive.retryTimer = setTimeout(() => {}, 1_000_000);
  oldLive.rawClients.add(fakeWs());

  supersedeSession(oldLive, next);

  const { tailStopped, rawOffCalled } = oldLive.spy();
  assert.equal(tailStopped, 1, "old tail stopped (one transcript tailed once)");
  assert.equal(oldLive.stopTail, null);
  assert.equal(rawOffCalled, 1, "old raw pipe turned off");
  assert.equal(oldLive.rawClients.size, 0, "old raw viewers cleared");
  assert.equal(oldLive.screenTimer, null, "screen timer cleared");
  assert.equal(oldLive.idleTimer, null, "idle timer cleared");
  assert.equal(oldLive.retryTimer, null, "retry timer cleared");
  // The whole point of the light teardown: the agent survives, because the new
  // Live may have adopted the same tmux pane (a latched hasExited).
  assert.equal(oldLive.pilot.killed, 0, "the shared agent is never killed by a handover");
});

test("supersedeSession is a no-op shape with no viewers and no timers", () => {
  const oldLive = fakeLive();
  const next = fakeLive();
  oldLive.stopTail = null;
  oldLive.rawOff = null;
  const moved = supersedeSession(oldLive, next);
  assert.equal(moved, 0);
  assert.equal(next.clients.size, 0);
});
