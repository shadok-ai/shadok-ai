import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// server.ts is un-importable, so the route's SHAPE is locked by scan (like
// test/instance-context-routes.test.ts) while the decision itself is unit-tested
// for real in test/tg-guests.test.ts (`guestPatchFlow`).
const SRC = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
function route(sig: string): string {
  const i = SRC.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return SRC.slice(i, SRC.indexOf("\n});", i));
}

test("PUT /telegram: the guest setup is an admin write, decided by the pure flow", () => {
  const r = route('app.put("/telegram",');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /guestPatchFlow\(/);
  // A refusal must return before anything is written.
  assert.match(r, /if \(!flow\.ok\) return res\.status\(flow\.status\)/);
  assert.match(r, /saveGroups\(flow\.groups\)/);
  assert.match(r, /setGuestSetupForCwd\(/);
});

test("PUT /telegram: the group and profile are never read from the body beyond the flow's judgement", () => {
  const r = route('app.put("/telegram",');
  // The body feeds `want`, which the flow validates; nothing else may reach a
  // spawn. The frame path is covered in test/tg-guests.test.ts.
  assert.match(r, /previous: guestSetupForCwd\(loadConfig\(\), cwd\)/);
  assert.match(r, /profileExists: \(n\) => !!getProfile\(n\)/);
  assert.match(r, /mode: DEPLOYMENT_MODE/);
});

test("PUT /telegram: a guests change restarts the bridge, which reads the setup at start", () => {
  const r = route('app.put("/telegram",');
  assert.match(r, /if \(hasConfigChange \|\| guestsChanged\) restartTelegram\(\)/);
});

test("GET /telegram: the picker's choices are resolved per caller, never instance-wide", () => {
  const r = route('app.get("/telegram",');
  assert.match(r, /telegramState\(viewerFor\(currentAccount\(req\)\)\)/);
  const st = SRC.slice(SRC.indexOf("async function telegramState("));
  const body = st.slice(0, st.indexOf("\n}\n"));
  assert.match(body, /guestGroupChoices\(loadGroups\(\), viewer\)/);
  // Still never the token (it is write-only), and never a group's member list.
  assert.doesNotMatch(body, /token:\s*tc\.token/);
  assert.match(body, /\{ id: g\.id, name: g\.name \}/);
});
