import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("phone composer: every '+' menu item clicks a button that exists", () => {
  const menu = HTML.match(/<div id="cmpPlusMenu"[\s\S]*?<\/div>/)?.[0] ?? "";
  const targets = [...menu.matchAll(/data-for="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targets, ["attachBtn", "skillBtn"]);
  for (const id of targets) assert.ok(HTML.includes(`id="${id}"`), id);
});

test("phone composer: the folded buttons are hidden only inside the narrow container", () => {
  const narrow = HTML.match(/@container composer \(max-width: 560px\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(narrow, /#attachBtn, #composer #skillBtn \{ display: none; \}/);
  assert.match(narrow, /#cmpPlus \{ display: inline-flex; \}/);
  assert.match(HTML, /#cmpPlus, \.cmp-plus-menu \{ display: none; \}/);
});
