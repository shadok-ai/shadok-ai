import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { heartbeatSweep, startHeartbeat } from "../src/heartbeat.js";

// A resting agent's /ws carries no traffic, so a reverse proxy (nginx
// proxy_read_timeout 60s, Cloudflare ~100s…) idle-closes it and the client
// loops on "reconnecting". A server-side ping keeps the connection warm.

test("heartbeatSweep: ping les clients vivants, terminate ceux qui n'ont pas pongé", () => {
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
  assert.equal(alive.isAlive, false); // marqué en attente du pong pour le prochain balayage
  assert.deepEqual([...ev].sort(), ["ping", "term"]);
});

test("startHeartbeat: un client qui pong survit, un client muet est terminé", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const { port } = wss.address() as { port: number };
  const stop = startHeartbeat(wss, 60); // balayage rapide pour le test

  const a = new WebSocket(`ws://127.0.0.1:${port}`); // pong auto → survit
  const b = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false }); // muet → terminé
  await Promise.all([
    new Promise((r) => a.once("open", r)),
    new Promise((r) => b.once("open", r)),
  ]);
  let bClosed = false;
  b.once("close", () => { bClosed = true; });

  await new Promise((r) => setTimeout(r, 400)); // ~6 balayages
  assert.equal(a.readyState, WebSocket.OPEN, "le client qui pong doit rester connecté");
  assert.ok(bClosed, "le client muet doit être terminé");

  stop();
  a.terminate();
  b.terminate();
  await new Promise((r) => wss.close(r));
});
