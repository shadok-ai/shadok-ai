import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.join(HERE, "..", "public", "index.html"), "utf8");

/**
 * Phone chassis invariants.
 *
 * Scan tests, like `test/csp.test.ts` and `test/ws-url.test.ts`: the client is a
 * single hand-written `index.html` with no build step, so reading the file back is
 * the only way to lock a client-side rule.
 *
 * Why they earn a test: every one of these breaks ONLY on a real phone, and none
 * of them shows up as an error. The page paints, tsc is green, and a desktop
 * browser — even at a narrow window — behaves perfectly, because the failures come
 * from things a desktop does not have: a retracting URL bar, an on-screen
 * keyboard, and Safari's focus zoom.
 */

test("the viewport meta covers the safe areas and never disables zoom", () => {
  const meta = INDEX.match(/<meta name="viewport"[^>]*>/);
  assert.ok(meta, "no viewport meta");
  assert.match(meta[0], /viewport-fit=cover/, "safe-area insets need viewport-fit=cover");
  // Killing zoom is the tempting one-line answer to Safari's focus zoom. It also
  // takes pinch-zoom away from anyone who needs it — the fields are 16px instead.
  assert.doesNotMatch(meta[0], /user-scalable\s*=\s*no/);
  assert.doesNotMatch(meta[0], /maximum-scale/);
});

test("touch fields are 16px, so Safari never zooms on focus", () => {
  const block = INDEX.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n  \}/);
  assert.ok(block, "no (pointer: coarse) block — the composer's 14px field would zoom Safari in");
  assert.match(block[1], /font-size:\s*16px/);
  // The composer is the field this was written for, and its own rule
  // (`#composer textarea`) outranks a bare `textarea` selector — so it has to be
  // named explicitly or the fix silently does nothing where it matters most.
  assert.match(block[1], /#composer textarea/);
});

test("the chassis height follows the browser chrome and the keyboard", () => {
  // `100%` alone is the layout viewport: on a phone it assumes the URL bar is
  // retracted, which put the composer under it.
  assert.match(INDEX, /body \{ height: 100dvh; \}/);
  // `dvh` follows the URL bar but not the keyboard; only visualViewport reports it.
  assert.match(INDEX, /body\.vv-sized \{ height: var\(--app-h\); \}/);
  assert.match(INDEX, /--app-h", vv\.height/);
});
