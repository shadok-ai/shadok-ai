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
  // The Connect Claude card's code/token fields carry no `type`, so the
  // attribute selectors above miss them — named explicitly, on any touch device
  // (a tablet is coarse but wider than the 640px phone query).
  assert.match(block[1], /\.cx-row input/);
});

test("a compact field size is gated on a FINE pointer, never merely overridden", () => {
  // The ledger filter bar styles its fields through `#ledgerTools input`
  // (0,1,0,1). Naming that same selector inside the (pointer: coarse) block
  // ties on specificity and LOSES on source order — measured in a real phone
  // viewport, the field stayed 13px with the "fix" in place. So anything under
  // 16px has to live inside a (pointer: fine) query: the small size must not
  // exist on touch rather than be corrected there.
  const fine = INDEX.match(/@media \(pointer: fine\) \{([\s\S]*?)\n  \}/);
  assert.ok(fine, "no (pointer: fine) block — a sub-16px field would zoom Safari in");
  assert.match(fine[1], /#ledgerTools input[\s\S]*font-size:\s*13px/);
  // and the un-gated rule must NOT carry one
  const base = INDEX.match(/\n  #ledgerTools input, #ledgerTools select \{([\s\S]*?)\}/);
  assert.ok(base && !/font-size/.test(base[1]), "the base rule must leave the size to the pointer query");
  // `font: inherit` is the same bug spelled differently: the shorthand sets the
  // SIZE as well, to the body's 15px, and wins the same tie just as quietly.
  assert.ok(base && !/\bfont:\s/.test(base[1]), "use font-family: the `font` shorthand carries a size");
});

test("the chassis height follows the browser chrome and the keyboard", () => {
  // `100%` alone is the layout viewport: on a phone it assumes the URL bar is
  // retracted, which put the composer under it.
  assert.match(INDEX, /body \{ height: 100dvh; \}/);
  // `dvh` follows the URL bar but not the keyboard; only visualViewport reports it.
  assert.match(INDEX, /body\.vv-sized \{ height: var\(--app-h\); \}/);
  assert.match(INDEX, /--app-h", vv\.height/);
});
