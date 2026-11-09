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

test("POST /instance-context/draft: browser admin, home agent, empty context, hidden interview prompt", () => {
  const r = route('app.post("/instance-context/draft"');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /isHomeChannel\(/);
  assert.match(r, /instanceContextInterviewBrief\(\)/);
  assert.match(r, /markAgentPrompt\(/);
});

test("the first-run greeting asks when the context is empty", () => {
  const i = SRC.indexOf("function greetHomeAgent(");
  const body = SRC.slice(i, SRC.indexOf("\n}\n", i));
  assert.match(body, /instanceContextEmpty:\s*!instanceContextForCwd\(/);
});

test("draft answers only once the hidden prompt was delivered (or says why not)", () => {
  const r = route('app.post("/instance-context/draft"');
  assert.match(r, /await deliverWithRetry\(/);
  assert.match(r, /res\.status\(503\)/);
});
