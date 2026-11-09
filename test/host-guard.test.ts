import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  clientAddress,
  hostHeaderAllowed,
  hostNameOf,
  hostRefusal,
  parseAllowedHosts,
  requestIsHttps,
  type HostPolicy,
} from "../src/net.js";

// ── DNS rebinding: which Host header may reach us ─────────────────────────

const local = (over: Partial<HostPolicy> = {}): HostPolicy => ({
  passwordSet: false,
  allowedHosts: [],
  originHosts: [],
  machineNames: ["mybox"],
  ...over,
});

test("hostNameOf strips the port and the IPv6 brackets", () => {
  assert.equal(hostNameOf("LocalHost:3789"), "localhost");
  assert.equal(hostNameOf("[::1]:3789"), "::1");
  assert.equal(hostNameOf("127.0.0.1"), "127.0.0.1");
  assert.equal(hostNameOf("cockpit.example.com:443"), "cockpit.example.com");
  assert.equal(hostNameOf("bad host"), null);
  assert.equal(hostNameOf("evil.com@127.0.0.1"), null);
});

test("no password: loopback names and IP literals pass, on any port", () => {
  for (const h of ["localhost:3789", "localhost", "127.0.0.1:3899", "127.4.5.6:1", "[::1]:3789", "app.localhost:3789", "192.168.1.20:3789", "mybox:3789"])
    assert.equal(hostHeaderAllowed(h, local()), true, h);
});

// The attack: a page on evil.com rebinds its own name to 127.0.0.1. Origin and
// Host are then BOTH evil.com, so the same-origin check passes — only the Host
// name itself gives it away.
test("no password: a rebound domain name is refused", () => {
  for (const h of ["evil.com:3789", "evil.com", "127.0.0.1.evil.com:3789", "localhost.evil.com:3789", "mybox.evil.com"])
    assert.equal(hostHeaderAllowed(h, local()), false, h);
});

test("no password: SHADOK_ALLOWED_HOSTS and SHADOK_ORIGINS extend the list", () => {
  const p = local({ allowedHosts: ["cockpit.lan", ".corp.example"], originHosts: ["proxy.example.com"] });
  assert.equal(hostHeaderAllowed("cockpit.lan:3789", p), true);
  assert.equal(hostHeaderAllowed("a.corp.example", p), true);
  assert.equal(hostHeaderAllowed("corp.example", p), true);
  assert.equal(hostHeaderAllowed("proxy.example.com", p), true);
  assert.equal(hostHeaderAllowed("evil.com", p), false);
  assert.equal(hostHeaderAllowed("xcorp.example", p), false);
});

test("a client that sends no Host at all is not a browser — allowed", () => {
  assert.equal(hostHeaderAllowed(undefined, local()), true);
  assert.equal(hostHeaderAllowed("", local()), true);
});

// The deployments that exist today: a password-protected container behind
// nginx/Cloudflare on its own domain, Host forwarded. They must keep working
// with no configuration change.
test("with a password: any Host passes, as before (a rebinding page gets no cookie)", () => {
  const p = local({ passwordSet: true });
  for (const h of ["biosense.alfredclaw.com", "evil.com:3789", "localhost:3789"])
    assert.equal(hostHeaderAllowed(h, p), true, h);
});

test("with a password, SHADOK_ALLOWED_HOSTS tightens to the list (loopback still passes)", () => {
  const p = local({ passwordSet: true, allowedHosts: ["biosense.alfredclaw.com"] });
  assert.equal(hostHeaderAllowed("biosense.alfredclaw.com", p), true);
  assert.equal(hostHeaderAllowed("127.0.0.1:3789", p), true);
  assert.equal(hostHeaderAllowed("evil.com", p), false);
});

test("with a password, SHADOK_ORIGINS alone does NOT tighten (it never meant that)", () => {
  const p = local({ passwordSet: true, originHosts: ["proxy.example.com"] });
  assert.equal(hostHeaderAllowed("other.example.com", p), true);
});

test("`*` in SHADOK_ALLOWED_HOSTS switches the check off", () => {
  assert.equal(hostHeaderAllowed("evil.com", local({ allowedHosts: ["*"] })), true);
});

test("an unparseable Host is refused when the check applies", () => {
  assert.equal(hostHeaderAllowed("bad host", local()), false);
});

test("parseAllowedHosts takes names, host:port, or whole origins", () => {
  assert.deepEqual(parseAllowedHosts(" Cockpit.LAN , http://x.example:8080/ ,, .corp.example,* "), [
    "cockpit.lan",
    "x.example",
    ".corp.example",
    "*",
  ]);
  assert.deepEqual(parseAllowedHosts(undefined), []);
});

test("hostRefusal names the variable to set", () => {
  assert.match(hostRefusal("evil.com"), /SHADOK_ALLOWED_HOSTS/);
});

// The same decision, wired as the server wires it, over a real socket.
test("in an express app: a rebound Host gets 403, localhost gets through", async (t) => {
  const app = express();
  const policy = local();
  app.use((req, res, next) => (hostHeaderAllowed(req.headers.host, policy) ? next() : res.status(403).json({ error: hostRefusal(String(req.headers.host)) })));
  app.get("/x", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const http = await import("node:http");
  const get = (host: string) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/x", headers: { host } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      }).on("error", reject);
    });
  assert.equal(await get(`localhost:${port}`), 200);
  assert.equal(await get(`evil.com:${port}`), 403);
});

// ── Who is calling: the address a login limiter keys on ───────────────────

test("clientAddress: the socket, unless a local/private proxy relayed it", () => {
  assert.equal(clientAddress("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }), "203.0.113.9");
  assert.equal(clientAddress("127.0.0.1", {}), "127.0.0.1");
  assert.equal(clientAddress("::ffff:127.0.0.1", {}), "127.0.0.1");
  // nginx on the host → its $proxy_add_x_forwarded_for appends the real peer LAST;
  // whatever the client put before it is the client's own claim.
  assert.equal(clientAddress("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" }), "198.51.100.7");
  // Docker: the proxy reaches the container from the bridge gateway.
  assert.equal(clientAddress("::ffff:172.17.0.1", { "x-forwarded-for": "198.51.100.7" }), "198.51.100.7");
  assert.equal(clientAddress(undefined, {}), "unknown");
});

test("requestIsHttps: a direct TLS socket, or a local/private proxy saying https", () => {
  assert.equal(requestIsHttps(true, "203.0.113.9", {}), true);
  assert.equal(requestIsHttps(false, "127.0.0.1", { "x-forwarded-proto": "https" }), true);
  assert.equal(requestIsHttps(false, "172.17.0.1", { "x-forwarded-proto": "https, http" }), true);
  assert.equal(requestIsHttps(false, "127.0.0.1", {}), false);
  // From the network, the header is the client's claim, not a proxy's.
  assert.equal(requestIsHttps(false, "203.0.113.9", { "x-forwarded-proto": "https" }), false);
});
