import http from "node:http";

// A stand-in for the cockpit: records what the script sent, answers `status`.
// Deliberately not shared with the shadok-ai-agents skill's `mock-server.mjs`,
// which is built around the WebSocket protocol and pilotctl's own routes.
export async function fakeCockpit(status, body) {
  const seen = { body: undefined, cookie: undefined, method: undefined };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.method = req.method;
      seen.body = raw ? JSON.parse(raw) : null;
      seen.cookie = req.headers.cookie;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}
