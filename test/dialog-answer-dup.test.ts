import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Answering question 1 of a multi-question form showed question 2 TWICE. The
// `choose` handler presses the key, sleeps, then calls finishTurn — and `busy`
// is down during that gap, so the screen watcher caught question 2 and
// published it; finishTurn then clears the dedup key on purpose (a fresh ask
// may repeat the last one byte for byte) and published it again. The handler
// now holds `answering` for its whole run and the watcher stays out. Locked by
// scanning the server, since the race needs a live tmux agent to reproduce.
const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

function handler(name: string): string {
  const at = src.indexOf(`case "${name}": {`);
  assert.ok(at > 0, name);
  const end = src.indexOf("\n        case ", at + 10);
  return src.slice(at, end);
}

test("the screen watcher never detects a dialog while an answer is in flight", () => {
  assert.match(src, /if \(settled && !s\.busy && !s\.answering\) \{\s*const d = detectDialog\(scr\);/);
  assert.match(src, /settled && !s\.busy && !s\.answering && pilot\.isWorking\(\)/);
});

test("every handler that answers a dialog holds `answering` until it is done", () => {
  for (const name of ["choose", "freetext", "confirm"]) {
    const body = handler(name);
    assert.match(body, /session\.answering\+\+;\s*try \{/, `${name} must raise answering`);
    assert.match(body, /finally \{\s*session\.answering--;/, `${name} must lower it in a finally`);
  }
});

test("freetext publishes the next question through the dedup funnel", () => {
  const body = handler("freetext");
  assert.doesNotMatch(body, /broadcast\(session, dialogMessage\(session, d\)\)/, "a raw broadcast is announced again by the watcher");
  assert.match(body, /publishDialog\(session, d\)/);
});
