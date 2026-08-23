import http from "node:http";

// A stand-in for the shadok-ai server, HTTP only: it records every request and
// answers from a route table. The shadok-ai-agents skill has its own
// `mock-server.mjs`, but that one is built around the WebSocket protocol and
// hardcodes pilotctl's two endpoints — these scripts speak plain HTTP to a
// different set of routes, so they get a helper of their own rather than a
// shared one bent to cover both.
export async function fakeCockpit(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const [path, query = ""] = req.url.split("?");
      seen.push({ method: req.method, path, query, body: raw ? JSON.parse(raw) : null, cookie: req.headers.cookie });
      const route = routes[`${req.method} ${path}`] ?? routes[path];
      res.writeHead(route?.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(route?.body ?? route ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}
