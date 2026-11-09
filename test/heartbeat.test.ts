import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { heartbeatSweep, startHeartbeat } from "../src/heartbeat.js";

// A resting agent's /ws carries no traffic, so a reverse proxy (nginx
// proxy_read_timeout 60s, Cloudflare ~100s…) idle-closes it and the client
// loops on "reconnecting". A server-side ping keeps the connection warm.

/** The flag `startHeartbeat` writes on a socket, which `ws`'s own type knows
 *  nothing about. */
const beat = (ws: unknown) => ws as { isAlive?: boolean };

/**
 * Poll until a condition HOLDS, bounded only so a broken run ends. Waiting a
 * fixed delay instead is what made this file flaky: any guess is wrong on a
 * machine running sixty test files at once.
 */
async function until(cond: () => boolean, what: string, ms = 10_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("heartbeatSweep: pings live clients, terminates those that did not pong", () => {
  const ev: string[] = [];
  const mk = (isAlive: boolean) => ({
    isAlive,
    ping() { ev.push("ping"); },
    terminate() { ev.push("term"); },
  });
  const alive = mk(true);
  const dead = mk(false);
  const r = heartbeatSweep([alive, dead] as never);
  assert.equal(r.pinged, 1);
  assert.equal(r.terminated, 1);
  assert.equal(alive.isAlive, false); // marked as awaiting the pong for the next sweep
  assert.deepEqual([...ev].sort(), ["ping", "term"]);
});

test("startHeartbeat: a client that pongs survives, a silent one is terminated", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const { port } = wss.address() as { port: number };
  // The automatic sweep is parked out of reach and this test drives the sweeps
  // itself. What `startHeartbeat` contributes here is the pong→isAlive wiring,
  // which is the half worth covering on real sockets; its TIMER on the other
  // hand used to race the pong's own round trip — a 60ms interval against a
  // loaded machine terminated the client that pongs about once in twenty runs
  // (measured: 3 hangs in 60 runs), and the assertion then fired before the
  // teardown below.
  const stop = startHeartbeat(wss, 60 * 60_000);
  const clients: WebSocket[] = [];
  try {
    // Connected one at a time, so matching a client to its server-side socket
    // needs no guessing.
    const a = new WebSocket(`ws://127.0.0.1:${port}`); // answers pings
    clients.push(a);
    await new Promise((r) => a.once("open", r));
    await until(() => wss.clients.size === 1, "the first client to be registered");
    const [aSrv] = wss.clients;

    const b = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false }); // stays silent
    clients.push(b);
    await new Promise((r) => b.once("open", r));
    await until(() => wss.clients.size === 2, "the second client to be registered");
    const bSrv = [...wss.clients].find((c) => c !== aSrv)!;
    let bClosed = false;
    b.once("close", () => { bClosed = true; });

    // First sweep: both are pinged and marked as awaiting a pong.
    assert.deepEqual(heartbeatSweep(wss.clients as never), { pinged: 2, terminated: 0 });
    await until(() => beat(aSrv).isAlive === true, "the first client's pong");
    assert.equal(beat(bSrv).isAlive, false, "the silent client must still be pending");

    // Second sweep: the one that answered is pinged again, the silent one cut.
    assert.deepEqual(heartbeatSweep(wss.clients as never), { pinged: 1, terminated: 1 });
    await until(() => bClosed, "the silent client to be disconnected");
    assert.equal(a.readyState, WebSocket.OPEN, "the client that pongs must stay connected");
  } finally {
    // Teardown belongs in a `finally`: a failed assertion used to skip it and
    // leave the server LISTENING, so node never exited. The test runner then
    // waited forever — `npm test` hung for eleven hours here, and every such
    // run left an orphan process behind (ten were still alive, the oldest from
    // mid-August). A red test must stay red, not become a hang.
    stop();
    for (const c of clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});
