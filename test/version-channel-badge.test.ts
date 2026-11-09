import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The header carries a small release-channel badge (beta/alpha) next to the
// version number, fed from `updateChannel` on the `version` message — not a
// hardcoded "beta". Locked like test/ws-url.test.ts locks the socket scheme:
// a browser-only wiring, silent to tsc, easy to drop while touching the header.
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

test("the header has a channel badge element next to the version", () => {
  assert.match(HTML, /id="verChan"/, "expected a #verChan badge span in the header");
  assert.match(HTML, /header \.ver-chan\s*\{/, "expected the badge to be styled");
});

test("the badge text comes from updateChannel, not a hardcoded label", () => {
  // The render reads msg.updateChannel and only ever resolves to alpha/beta.
  assert.match(
    HTML,
    /verChan\.textContent\s*=\s*ch\b/,
    "the badge must be set from the resolved channel",
  );
  assert.match(
    HTML,
    /msg\.updateChannel\s*===\s*["']alpha["']\s*\?\s*["']alpha["']\s*:\s*["']beta["']/,
    "the channel must resolve to alpha/beta from updateChannel (beta is the default)",
  );
});
