import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const HTML = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("a version-menu entry opens the instance-context popin", () => {
  assert.match(HTML, /<button class="vm-btn" id="instanceContextBtn" type="button">/);
  assert.match(HTML, /<div id="icOverlay" class="overlay" hidden>/);
  assert.match(HTML, /\$\("instanceContextBtn"\)\.addEventListener\("click"/);
});

test("the popin reads, saves and drafts through the routes", () => {
  assert.match(HTML, /fetch\("\/instance-context"\)/);
  assert.match(HTML, /fetch\("\/instance-context", \{ method: "PUT"/);
  assert.match(HTML, /fetch\("\/instance-context\/draft", \{ method: "POST"/);
  assert.match(HTML, /id="icText"[^>]*maxlength="2000"/);
  assert.match(HTML, /next reload/i);
});

test("no inline handler in the popin (CSP)", () => {
  const i = HTML.indexOf('<div id="icOverlay"');
  const card = HTML.slice(i, HTML.indexOf("\n</div>\n", i));
  assert.doesNotMatch(card, /\son\w+=/);
});

test("the textarea is a touch-sized field (Safari never zooms)", () => {
  const block = HTML.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n  \}/);
  // The panel's own rule outranks a bare `textarea` (measured: 13px on an
  // iPhone viewport), so it has to be named in the coarse block itself.
  assert.ok(block && /\.ic-panel textarea/.test(block[1]), ".ic-panel textarea is in the coarse 16px rule");
  // …and its base rule carries no size: equal specificity, later in the sheet,
  // it would win anyway (invariant 28). The compact size lives under (pointer: fine).
  const base = HTML.match(/\n  \.ic-panel textarea \{([\s\S]*?)\}/);
  assert.ok(base && !/font-size|\bfont:\s/.test(base[1]), "base .ic-panel textarea rule must not set a size");
});
