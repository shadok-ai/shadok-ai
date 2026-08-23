import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "..", "public", "index.html");

/**
 * Grouping the transcript's labels is pure CSS, hence unverifiable here — the
 * real proof is a browser check (computed style). This test holds the one thing
 * a text file allows holding: that the rule does not forget to exclude turns
 * WITHOUT a label.
 *
 * Why it deserves a test: the rule hides the label of a `.turn.claude` that
 * follows another one, so only one "claude · 21:57" shows per speaking turn.
 * But an activity block and the provisional preview are `.turn.claude` too, and
 * display no label. Counting them makes a turn that shows nothing absorb the
 * answer's label — and since the agent almost always uses a tool before
 * writing, its answer lost its time in the most common case. A regression
 * already lived through once.
 */
const LABEL_RULE = /([^{}]*)>\s*\.label,[\s\S]*?\{\s*display:\s*none/;

test("the grouping rule is only opened by turns that display a label", () => {
  const css = fs.readFileSync(INDEX, "utf8");
  const m = LABEL_RULE.exec(css);
  assert.ok(m, "label-hiding rule not found — was it renamed?");
  const selector = m[1];
  for (const labelless of ["activity", "live-preview"])
    assert.match(
      selector,
      new RegExp(`:not\\(\\.${labelless}\\)`),
      `a .turn.claude.${labelless} displays no label: it must not hide the next turn's`,
    );
});
