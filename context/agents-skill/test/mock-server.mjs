import http from "node:http";
import { WebSocketServer } from "ws";

// Minimal stand-in for the shadok-ai server: replays scripted replies per
// incoming message type, so pilotctl's client logic is exercised without a
// real claude process. `script[type]` is an array of messages to send back.
export function startMockServer(script = {}) {
  // Cookie headers seen on HTTP requests and on the WS upgrade — lets a test
  // assert pilotctl presents the SHADOK_AUTH cookie when a password is set.
  const cookies = { http: [], ws: [] };
  // Per-route HTTP requests seen, with their parsed JSON body and the session-key
  // header — lets a test assert what pilotctl actually sent (e.g. `talk`).
  const http_ = [];
  const app = http.createServer((req, res) => {
    if (req.headers.cookie) cookies.http.push(req.headers.cookie);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      http_.push({ method: req.method, url: req.url, body, sessionKey: req.headers["x-shadok-session-key"], peer: req.headers["x-shadok-peer"] });
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/live")) {
        if (script.liveStatus) res.statusCode = script.liveStatus;
        return res.end(JSON.stringify(script.live ?? []));
      }
      if (req.url.startsWith("/sessions")) return res.end(JSON.stringify(script.sessions ?? []));
      if (req.url.startsWith("/diff"))
        return res.end(
          JSON.stringify(script.diff ?? { status: "", diff: "", branch: null, error: "no such session" }),
        );
      if (req.url.startsWith("/talk/handle")) return res.end(JSON.stringify(script.talkHandle ?? { handle: "H" }));
      if (req.url.startsWith("/talk")) return res.end(JSON.stringify(script.talk ?? { ok: true, delivered: "abcd" }));
      res.end("{}");
    });
  });
  const wss = new WebSocketServer({ server: app, path: "/ws" });
  const received = [];
  wss.on("connection", (ws, req) => {
    if (req.headers.cookie) cookies.ws.push(req.headers.cookie);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      received.push(msg);
      for (const reply of script[msg.type] ?? []) ws.send(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    app.listen(0, () =>
      resolve({
        port: app.address().port,
        received,
        http: http_,
        cookies,
        close: () => new Promise((r) => { wss.close(); app.close(r); }),
      }),
    );
  });
}
