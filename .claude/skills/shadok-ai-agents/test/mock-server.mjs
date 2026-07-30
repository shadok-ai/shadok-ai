import http from "node:http";
import { WebSocketServer } from "ws";

// Minimal stand-in for the shadok-ai server: replays scripted replies per
// incoming message type, so pilotctl's client logic is exercised without a
// real claude process. `script[type]` is an array of messages to send back.
export function startMockServer(script = {}) {
  const app = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/sessions")) return res.end(JSON.stringify(script.sessions ?? []));
    if (req.url.startsWith("/diff"))
      return res.end(
        JSON.stringify(script.diff ?? { status: "", diff: "", branch: null, error: "no such session" }),
      );
    res.end("{}");
  });
  const wss = new WebSocketServer({ server: app, path: "/ws" });
  const received = [];
  wss.on("connection", (ws) => {
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
        close: () => new Promise((r) => { wss.close(); app.close(r); }),
      }),
    );
  });
}
