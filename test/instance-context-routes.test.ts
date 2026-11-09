import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// server.ts is un-importable; the route guards are locked by scan, like
// test/mt-token-ui.test.ts. An agent must never be able to write what every
// agent is told — beyond the lead's once-only path (invariant 26's family).
const SRC = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
function route(sig: string): string {
  const i = SRC.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return SRC.slice(i, SRC.indexOf("\n});", i));
}

test("GET /instance-context answers the text and the cap", () => {
  const r = route('app.get("/instance-context"');
  assert.match(r, /instanceContextForCwd\(/);
  assert.match(r, /INSTANCE_CONTEXT_MAX/);
});

test("PUT /instance-context is a browser-origin admin write", () => {
  const r = route('app.put("/instance-context",');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /normalizeInstanceContext\(/);
  assert.match(r, /setInstanceContextForCwd\(/);
});

test("PUT /instance-context/first: session key, home channel, empty only", () => {
  const r = route('app.put("/instance-context/first"');
  assert.match(r, /x-shadok-session-key/);
  assert.match(r, /localSessionForKey\(/);
  assert.match(r, /isHomeChannel\(/);
  assert.match(r, /firstWriteVerdict\(/);
  assert.doesNotMatch(r, /res\.json\([^)]*key/i, "never echoes the key");
});
