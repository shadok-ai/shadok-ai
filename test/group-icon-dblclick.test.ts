import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// In the groups rail collapsed to icons (body.rail-mini), a group row is almost
// entirely its icon button, so a single click on the icon must SELECT the group
// (setView) and only a double-click opens the icon picker — otherwise selecting
// a collapsed group is impossible. A double-click on the NAME renames it.
// Neither may rely on a native `dblclick` nor on state kept on the element: the
// rail is rebuilt under the pointer — by the first click itself (selecting a
// group changes the active view) and, with live agents, by every mood change —
// and a dblclick whose clicks land on two different nodes never fires. That is
// how renaming a group stopped working on a busy cockpit. The browser's own
// click count (`e.detail`) follows the pointer rather than the node. Locked
// here like test/ws-url.test.ts locks the socket scheme: browser-only wiring,
// invisible to tsc, and exactly what a refactor of the rail could quietly revert.
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

const handler = (el: string) => {
  const m = HTML.match(new RegExp(el + String.raw`\.addEventListener\(\s*["']click["']\s*,\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\s{6}\}\);`));
  assert.ok(m, `expected the rail ${el} click handler`);
  return m![1];
};

test("a second click is the browser's click count, not a native dblclick", () => {
  assert.match(HTML, /const isSecondClick\s*=\s*\(e\)\s*=>\s*e\.detail\s*>=\s*2/);
  assert.doesNotMatch(HTML, /nm\.addEventListener\(\s*["']dblclick["']/, "a native dblclick dies with the rebuilt node");
});

test("the rail icon's single click selects the group, double-click opens the picker", () => {
  const body = handler("ic");
  assert.match(
    body,
    /if\s*\(isSecondClick\(e\)\)\s*openIconPicker\(group, ic\);\s*else\s*setView\(view\);/,
    "openIconPicker on the second click, setView otherwise",
  );
});

test("the rail name's double-click renames, without bubbling into a setView", () => {
  const body = handler("nm");
  assert.match(body, /if\s*\(!isSecondClick\(e\)\)\s*return;/);
  // setView may focus the composer, which would blur (= close) the new field.
  assert.match(body, /e\.stopPropagation\(\);[\s\S]*?inlineRename\(item, nm,/);
});

test("a mood-only rebuild waits while a click is under way", () => {
  assert.match(HTML, /railList\.addEventListener\(\s*["']pointerdown["']/);
  assert.match(HTML, /railHoldUntil - Date\.now\(\)[\s\S]{0,120}railSig\.startsWith\(v \+ "\|"\)/);
});

test("the rail icon advertises the double-click", () => {
  assert.match(HTML, /ic\.title\s*=\s*["']Double-click to change the icon["']/);
});
