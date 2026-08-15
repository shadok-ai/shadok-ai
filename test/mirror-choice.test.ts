import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The "Mirror to Telegram" checkbox travelled to the SERVER (in the `start`
 * message) but never to the TAB. The tab is born `mirror: false`, and
 * `persistChannels` pushes `mirror: !!t.mirror` — so the first persist after
 * `ready` overwrote the server's freshly stored `true`, and the agent was never
 * mirrored. Ticking the box did nothing; only the channel menu worked, because
 * that path does update the tab.
 *
 * The value is duplicated by design (the server needs it at `ready`, the client
 * owns it afterwards), so the two must be set from ONE place: `launchTab`, the
 * single funnel every creation path goes through. Scanned here the way
 * `csp.test.ts` and `ws-url.test.ts` scan the same file — a browser-side wiring
 * bug is invisible to tsc and to every other test.
 */
const HTML = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

/** The body of a top-level `function name(...) { … }` in the page's script. */
function functionBody(name: string): string {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in index.html`);
  let depth = 0;
  for (let i = HTML.indexOf("{", start); i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("the creation form sends the mirror choice to the server", () => {
  // Without this the server never learns the choice at all.
  assert.match(HTML, /msg\.mirror\s*=\s*\$\("mirrorInput"\)\.checked/);
});

test("launchTab teaches the TAB the mirror choice too", () => {
  // The regression: the tab kept its default `false` and the next persist
  // overwrote the server. Every creation path goes through launchTab, so the
  // propagation belongs there — not in one caller that a future path forgets.
  assert.match(functionBody("launchTab"), /msg\.mirror/);
});

test("persistChannels still pushes the tab's mirror", () => {
  // If this ever stops being pushed, toggling from the menu stops persisting —
  // the twin failure, in the other direction.
  assert.match(functionBody("persistChannels"), /mirror:\s*!!t\.mirror/);
});
