import type { WebSocketServer } from "ws";

/**
 * The subset of a `ws` socket the heartbeat touches. Structural on purpose, so
 * the sweep is unit-testable with plain mock objects (no real WebSocket).
 */
interface Beating {
  isAlive?: boolean;
  ping(): void;
  terminate(): void;
}

/**
 * One heartbeat sweep, pure over the client set: a client that hasn't answered
 * the previous ping (`isAlive === false`) is considered dead and terminated;
 * every other client is pinged and marked pending until its pong flips it back.
 * Returns counts for logging/tests.
 */
export function heartbeatSweep(clients: Iterable<Beating>): { pinged: number; terminated: number } {
  let pinged = 0;
  let terminated = 0;
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      terminated++;
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
      pinged++;
    } catch {
      // A socket mid-close can throw on ping; the next sweep terminates it.
    }
  }
  return { pinged, terminated };
}

/**
 * Keep idle WebSocket connections alive through reverse proxies. A resting
 * agent's `/ws` carries no application traffic, so nginx (`proxy_read_timeout`,
 * 60s default), Cloudflare (~100s) and friends idle-close it — and the client
 * then loops on "reconnecting" with nothing actually wrong. A periodic ping
 * resets the proxy's idle timer; a client that misses a pong (genuinely gone)
 * is terminated so it stops being pinged.
 *
 * Wires the pong→alive handshake on each connection and sweeps every
 * `intervalMs` (default well under the common 60s proxy window). Returns a stop
 * function; the timer is also cleared when the server closes.
 */
export function startHeartbeat(wss: WebSocketServer, intervalMs = 25_000): () => void {
  wss.on("connection", (ws) => {
    (ws as unknown as Beating).isAlive = true;
    ws.on("pong", () => {
      (ws as unknown as Beating).isAlive = true;
    });
  });
  const timer = setInterval(
    () => heartbeatSweep(wss.clients as unknown as Iterable<Beating>),
    intervalMs,
  );
  // The heartbeat must not, by itself, keep the process alive.
  timer.unref?.();
  const stop = () => clearInterval(timer);
  wss.on("close", stop);
  return stop;
}
