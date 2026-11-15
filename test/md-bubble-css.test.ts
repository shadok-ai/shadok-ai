import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.join(HERE, "..", "public", "index.html"), "utf8");

/**
 * The markdown bubble's whitespace reset.
 *
 * Scan test, like `test/mobile-viewport.test.ts` and `test/csp.test.ts`: the
 * client is one hand-written `index.html` with no build step, so reading the
 * file back is the only way to lock a CSS rule.
 *
 * Why it earns a test: the reset existed and did nothing. `.bubble.md` is two
 * classes, `.turn.claude .bubble` is three, so every agent answer kept
 * `white-space: pre-wrap` — and `marked` puts a newline between block tags,
 * which pre-wrap renders as a blank LINE. Nothing errors, the markup is
 * correct, and a reader only sees an answer that is unreadably airy. The
 * declaration a refactor is most likely to "tidy away" as a duplicate is
 * precisely the one doing the work.
 */

/** Rough CSS specificity: enough to compare two class-only selectors. */
function classCount(sel: string): number {
  return (sel.match(/\.[a-zA-Z][\w-]*/g) ?? []).length;
}

function ruleBody(selector: string): string {
  const re = new RegExp(
    `(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  const m = INDEX.match(re);
  assert.ok(m, `no rule for \`${selector}\``);
  return m[2];
}

test("a markdown bubble's whitespace reset outranks the TUI pre-wrap it corrects", () => {
  // The rule being corrected: agent turns preserve the TUI's own newlines.
  assert.match(ruleBody(".turn.claude .bubble"), /white-space:\s*pre-wrap/);
  // The correction must match or beat it, or it is lost in silence.
  const reset = ".turn.claude .bubble.md";
  assert.match(ruleBody(reset), /white-space:\s*normal/);
  assert.ok(
    classCount(reset) >= classCount(".turn.claude .bubble"),
    "the reset must not be less specific than the rule it corrects",
  );
});

test("the compaction card keeps the plain .bubble.md reset", () => {
  // `.turn.compaction` has no pre-wrap override, so the two-class rule still
  // does the work there — and it is what proves the intent of the raised one.
  assert.match(ruleBody(".bubble.md"), /white-space:\s*normal/);
});
