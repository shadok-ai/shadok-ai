import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HOST,
  bindRefusal,
  isLoopbackHost,
  originAllowed,
  parseOrigins,
  resolveHost,
  browserOrigin,
} from "../src/net.js";

// ── Listening interface ──────────────────────────────────────────────────

test("with no SHADOK_HOST we listen to this machine only", () => {
  assert.equal(resolveHost({}), DEFAULT_HOST);
  assert.equal(resolveHost({ SHADOK_HOST: "   " }), DEFAULT_HOST);
});

test("SHADOK_HOST forces the interface (the container case)", () => {
  assert.equal(resolveHost({ SHADOK_HOST: "0.0.0.0" }), "0.0.0.0");
});

test("local forms are recognised, bracketed IPv6 included", () => {
  for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST"])
    assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.20", "::", "example.com"])
    assert.equal(isLoopbackHost(h), false, h);
});

// ── Refus fail-closed ────────────────────────────────────────────────────

test("local bind: never refused, password or not", () => {
  assert.equal(bindRefusal("127.0.0.1", false), null);
  assert.equal(bindRefusal("127.0.0.1", true), null);
});

test("network bind WITH a password: allowed (the legitimate Docker case)", () => {
  assert.equal(bindRefusal("0.0.0.0", true), null);
});

test("network bind WITHOUT a password: refused, and the message says what to do", () => {
  const r = bindRefusal("0.0.0.0", false);
  assert.ok(r, "a network bind with no password must be refused");
  assert.match(r!, /--password|SHADOK_GUI_PASSWORD/);
});

// ── Allowlist d'origines ─────────────────────────────────────────────────

test("SHADOK_ORIGINS: normalised (case, spaces, trailing slash), empties ignored", () => {
  assert.deepEqual(parseOrigins(" https://Cockpit.Example.com/ , ,http://a.b "), [
    "https://cockpit.example.com",
    "http://a.b",
  ]);
  assert.deepEqual(parseOrigins(undefined), []);
});

// ── The same-origin guard ────────────────────────────────────────────────

test("no Origin → allowed: this is a non-browser client", () => {
  // The Telegram bridge opens a WS to our own server with no Origin; refusing
  // it would cut Telegram off from its sessions.
  assert.equal(originAllowed(undefined, "127.0.0.1:3789"), true);
  assert.equal(originAllowed("", "127.0.0.1:3789"), true);
});

test("same origin → allowed, port included", () => {
  assert.equal(originAllowed("http://localhost:3789", "localhost:3789"), true);
  assert.equal(originAllowed("http://192.168.1.20:3789", "192.168.1.20:3789"), true);
  assert.equal(originAllowed("https://cockpit.example.com", "cockpit.example.com"), true);
});

test("a third-party page is refused — the WebSocket attack from a visited site", () => {
  assert.equal(originAllowed("https://evil.com", "localhost:3789"), false);
});

test("a different port is a different origin", () => {
  // evil.com can have anything listening on another local port; the origin is
  // compared whole, host AND port.
  assert.equal(originAllowed("http://localhost:1234", "localhost:3789"), false);
});

test("a host that merely starts the same does not get through", () => {
  assert.equal(originAllowed("http://localhost:3789.evil.com", "localhost:3789"), false);
  assert.equal(originAllowed("http://notlocalhost:3789", "localhost:3789"), false);
});

test("an opaque or unreadable origin is refused", () => {
  // `Origin: null` — sandboxed iframe, file:// page.
  assert.equal(originAllowed("null", "localhost:3789"), false);
  assert.equal(originAllowed("not a url", "localhost:3789"), false);
});

test("with no Host there is nothing to compare: refused", () => {
  assert.equal(originAllowed("https://evil.com", undefined), false);
});

test("SHADOK_ORIGINS opens one specific origin (reverse proxy)", () => {
  const allow = ["https://cockpit.example.com"];
  // The Host the server sees behind the proxy is not the browser's.
  assert.equal(originAllowed("https://cockpit.example.com", "127.0.0.1:3789", allow), true);
  assert.equal(originAllowed("https://Cockpit.Example.com/", "127.0.0.1:3789", allow), true);
  assert.equal(originAllowed("https://evil.com", "127.0.0.1:3789", allow), false);
});

test("browserOrigin: seul un navigateur same-origin passe", () => {
  // Used ONLY to guard the routes that change a profile's guardrails.
  // originAllowed lets Origin-less clients through (invariant 11: Telegram,
  // pilotctl, the CLI) — here that is precisely what we refuse.
  assert.equal(browserOrigin("http://localhost:3789", "localhost:3789"), true);
  assert.equal(browserOrigin(undefined, "localhost:3789"), false, "un shell d'agent n'envoie pas d'Origin");
  assert.equal(browserOrigin("", "localhost:3789"), false);
  assert.equal(browserOrigin("http://evil.example", "localhost:3789"), false);
  assert.equal(browserOrigin("null", "localhost:3789"), false, "origine opaque");
});
