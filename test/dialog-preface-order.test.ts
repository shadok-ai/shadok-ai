import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The text an agent writes BEFORE a question reaches the web client after the
// question (the transcript writes a suspended message only once its tool
// resolves). The client must put it back ABOVE the question card. This logic
// lives in index.html's inline script, so it is locked by scanning the page,
// the way csp.test.ts locks the nonce; it was verified end to end in a browser
// replaying text → dialog → answer.
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("the authoritative block takes the promoted preface's slot instead of moving to the bottom", () => {
  assert.doesNotMatch(html, /t\.prefaceEl\.remove\(\)/, "removing the promoted copy re-appends the text below the question");
  assert.match(html, /slot\?\.isConnected\) slot\.replaceWith\(b\.parentElement\)/);
});

test("with nothing promoted, the block lands before the question card", () => {
  assert.match(html, /t\.dialogAnchor\?\.isConnected\) t\.dialogAnchor\.before\(b\.parentElement\)/);
  assert.match(html, /if \(!tab\.dialogAnchor\?\.isConnected\) tab\.dialogAnchor = turn;/);
});

test("the anchor is released once the suspended message is over", () => {
  for (const c of ['case "stream-tool":', 'case "turn-done":', 'case "prompt-echo":']) {
    const at = html.indexOf(c);
    assert.ok(at > 0, c);
    assert.match(html.slice(at, at + 900), /dialogAnchor = null/, `${c} must clear the anchor`);
  }
});

test("the server's preface is the fallback when no grey preview was painted", () => {
  assert.match(html, /promotePreface\(t, msg\.preface\)/);
});
