import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The auth cookie's SameSite is a security-relevant attribute the source sets
// inline (no pure function to unit-test), so — like test/ws-url.test.ts and
// test/csp.test.ts — we lock it by scanning the source. `Strict` withholds the
// cookie on top-level cross-site navigations (a bookmark from another app, a
// link out of Telegram, a restored session), which logged users out every time
// they reopened the cockpit despite a valid, persistent cookie. `Lax` is the
// right level: the same-origin `Origin` gate (src/net.ts) is the real CSRF
// defense, not SameSite. Never let it drift back to Strict.
const SERVER = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
  "utf8",
);

test("no sk_auth cookie is ever set SameSite=Strict", () => {
  const strict = SERVER.match(/sk_auth=[^\n]*SameSite=Strict/g);
  assert.equal(strict, null, "the auth cookie must be SameSite=Lax, not Strict");
});

test("every sk_auth Set-Cookie declares SameSite=Lax", () => {
  // Each line that SETS the sk_auth cookie (login, invite redeem, logout clear)
  // must carry SameSite=Lax explicitly — an omitted attribute is a silent drift.
  // Keyed on `Path=/`, which every Set-Cookie carries: it excludes the loopback
  // `adminCookie()` builder, which is a request `Cookie:` header (the Telegram
  // bridge/agents present it) and correctly has no SameSite of its own.
  const lines = SERVER.split("\n").filter((l) => /sk_auth=/.test(l) && /Path=\//.test(l));
  assert.ok(lines.length >= 3, `expected at least 3 sk_auth Set-Cookie lines, found ${lines.length}`);
  for (const l of lines) {
    assert.match(l, /SameSite=Lax/, `sk_auth cookie missing SameSite=Lax: ${l.trim()}`);
  }
});
