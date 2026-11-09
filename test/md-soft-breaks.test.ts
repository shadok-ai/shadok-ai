import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { marked } from "marked";

// Agent text in the .jsonl carries newlines where the agent meant them (one URL
// per line, a short list). The default Markdown rule renders a LONE "\n" as a
// word-space, so those lines glued into a single wrapped run in the chat bubble
// — while the engine-room screen and Telegram, which never go through marked,
// showed them correctly. The cockpit turns GFM soft breaks ON so a single
// newline is a <br>. Locked here like test/md-table.test.ts locks the table
// layout: a browser-only, silent-to-tsc regression, trivial to reintroduce by
// adding a fresh marked.parse call or dropping the global config.
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

test("index.html turns on GFM soft line breaks globally for marked", () => {
  assert.match(
    HTML,
    /marked\.setOptions\(\s*\{[^}]*breaks\s*:\s*true/,
    "expected a global `marked.setOptions({ breaks: true })` so every render site keeps single newlines",
  );
});

test("the behaviour we rely on: a single newline becomes <br> with breaks:true", () => {
  // Guards against a marked upgrade changing the meaning of the option we set.
  const out = marked.parse("line one\nline two", { breaks: true }) as string;
  assert.match(out, /<br\s*\/?>/, "a lone newline must render as a line break");
});

test("without breaks a single newline is a space (the bug being fixed)", () => {
  const out = marked.parse("line one\nline two", { breaks: false }) as string;
  assert.doesNotMatch(out, /<br\s*\/?>/, "default marked collapses a lone newline — this is why the option is needed");
});
