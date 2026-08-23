import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { heartbeatSweep, startHeartbeat } from "../src/heartbeat.js";

// A resting agent's /ws carries no traffic, so a reverse proxy (nginx
// proxy_read_timeout 60s, Cloudflare ~100s…) idle-closes it and the client
// loops on "reconnecting". A server-side ping keeps the connection warm.

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
  const stop = startHeartbeat(wss, 60); // a fast sweep for the test

  const a = new WebSocket(`ws://127.0.0.1:${port}`); // pong auto → survit
  const b = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false }); // silent → terminated
  await Promise.all([
    new Promise((r) => a.once("open", r)),
    new Promise((r) => b.once("open", r)),
  ]);
  let bClosed = false;
  b.once("close", () => { bClosed = true; });

  await new Promise((r) => setTimeout(r, 400)); // ~6 balayages
  assert.equal(a.readyState, WebSocket.OPEN, "the client that pongs must stay connected");
  assert.ok(bClosed, "the silent client must be terminated");

  stop();
  a.terminate();
  b.terminate();
  await new Promise((r) => wss.close(r));
});
