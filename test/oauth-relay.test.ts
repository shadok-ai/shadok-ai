import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { relayOAuthCallback, relayTarget } from "../src/oauth-relay.js";

test("relayTarget: accepts a loopback callback with a port", () => {
  for (const u of [
    "http://localhost:51823/callback?code=abc&state=xyz",
    "http://127.0.0.1:8765/?code=abc",
    "http://[::1]:9000/cb",
    "  http://localhost:1/x  ",
  ])
    assert.equal(relayTarget(u).ok, true, u);
});

// It relays a callback; it must never become a fetch of anything else.
test("relayTarget: refuses anything that is not a loopback http callback", () => {
  for (const u of [
    undefined,
    "",
    "not a url",
    "https://localhost:443/x",
    "http://example.com:80/x",
    "http://169.254.169.254:80/latest/meta-data",
    "http://localhost/no-port",
    "http://user:pw@localhost:1/x",
    "file:///etc/passwd",
  ])
    assert.equal(relayTarget(u).ok, false, String(u));
});

test("relayOAuthCallback: hits the listener with the exact path and query", async () => {
  let seen = "";
  const srv = http.createServer((req, res) => {
    seen = req.url ?? "";
    res.end("<html><body><h1>Authentication successful</h1> You can close this window.</body></html>");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const r = await relayOAuthCallback(`http://127.0.0.1:${port}/callback?code=c0de&state=s7`);
  srv.close();
  assert.equal(seen, "/callback?code=c0de&state=s7");
  assert.deepEqual(r, { ok: true, status: 200, text: "Authentication successful You can close this window." });
});

// The redirect says `localhost`, the listener is IPv4-only, and `localhost`
// may resolve to ::1 first — the relay must still land.
test("relayOAuthCallback: localhost reaches a listener bound to 127.0.0.1", async () => {
  let seen = "";
  const srv = http.createServer((req, res) => {
    seen = req.url ?? "";
    res.end("ok");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const r = await relayOAuthCallback(`http://localhost:${port}/callback?code=c0de`);
  srv.close();
  assert.equal(seen, "/callback?code=c0de");
  assert.equal(r.ok, true);
});

test("relayOAuthCallback: a dead port says so instead of throwing", async () => {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  const r = await relayOAuthCallback(`http://127.0.0.1:${port}/callback?code=x`, 2000);
  assert.equal(r.ok, false);
});
