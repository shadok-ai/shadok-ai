import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// A wide agent table must scroll sideways, but the scroll belongs on a WRAPPER,
// never on the <table> via `display:block` — that breaks the table's own layout,
// so thead and tbody stop sharing column widths and the header row detaches and
// misaligns from the body (a real, reported render bug). Locked here like
// test/ws-url.test.ts locks the socket scheme: a browser-only, silent-to-tsc
// regression that is easy to reintroduce while "fixing" a wide table on mobile.
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

test(".bubble.md table is never display:block (it would detach the header)", () => {
  const m = HTML.match(/\.bubble\.md table\s*\{([^}]*)\}/);
  assert.ok(m, "expected a `.bubble.md table { … }` rule");
  assert.doesNotMatch(
    m![1],
    /display\s*:\s*block/,
    "the table must stay display:table; put overflow-x on .md-table-wrap instead",
  );
});

test("agent tables are wrapped in a scrollable .md-table-wrap", () => {
  // The wrapper carries the horizontal scroll, in both the CSS and the render
  // code that inserts it after sanitising.
  assert.match(HTML, /\.md-table-wrap\s*\{[^}]*overflow-x\s*:\s*auto/, "wrapper must scroll-x in CSS");
  assert.match(HTML, /className\s*=\s*["'`]md-table-wrap["'`]/, "render code must create the wrapper");
});
