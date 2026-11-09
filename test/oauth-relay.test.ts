import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { relayOAuthCallback, relayTarget } from "../src/oauth-relay.js";

test("relayTarget: accepts a loopback callback with a port", () => {
  for (const u of [
    "http://localhost:51823/callback?code=abc&state=xyz",
    "http://127.0.0.1:8765/?code=abc",
    "http://[::1]:9000/cb?state=s",
    "  http://localhost:1/x?error=access_denied&state=s  ",
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

// SSRF: the cockpit is a loopback client with the agents' network position, so a
// relay that GETs any path on any port reads local services for whoever can
// reach the cockpit. An OAuth callback carries code/state; nothing else does.
test("relayTarget: refuses a loopback address that is not an OAuth callback", () => {
  for (const u of [
    "http://localhost:51823/callback",
    "http://127.0.0.1:8765/json/version",
    "http://127.0.0.1:8765/?foo=bar",
  ])
    assert.equal(relayTarget(u).ok, false, u);
});

test("relayTarget: refuses the cockpit's own port and well-known internal ports", () => {
  assert.equal(relayTarget("http://127.0.0.1:4100/cb?code=x", { ownPort: 4100 }).ok, false);
  assert.equal(relayTarget("http://127.0.0.1:4100/cb?code=x").ok, true);
  // 3789… is where shadok instances live (one per port of the walk).
  for (const port of [3789, 3800, 9222, 9229, 2375, 6379, 11211])
    assert.equal(relayTarget(`http://127.0.0.1:${port}/cb?code=x`).ok, false, String(port));
});

test("relayOAuthCallback: reports the status only, never the listener's body", async () => {
  const srv = http.createServer((_req, res) => res.end("secret page content"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const r = await relayOAuthCallback(`http://127.0.0.1:${port}/cb?code=x`);
  srv.close();
  assert.deepEqual(r, { ok: true, status: 200 });
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
  assert.deepEqual(r, { ok: true, status: 200 });
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
