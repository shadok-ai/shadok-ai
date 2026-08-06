import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = fs.readFileSync(path.join(HERE, "..", "public", "index.html"), "utf8");

/**
 * The browser's socket must inherit the page's scheme.
 *
 * This is a scan test, like `test/csp.test.ts`: the client is a single hand-written
 * `index.html` with no build step, so the only way to lock a client-side invariant
 * is to read the file back.
 *
 * Why it earns a test: a hardcoded `ws://` works perfectly on `http://localhost:3789`
 * — every developer setup — and breaks ONLY once the cockpit sits behind a TLS
 * reverse proxy, where the browser blocks the socket as mixed content. The page is
 * static HTML, so it still paints; the channels simply never connect. Nothing in the
 * DOM says why, tsc is green, and the server answers `101` to a `curl` upgrade. That
 * combination is what made it survive two HTTPS deployments unnoticed.
 */
test("the client never hardcodes a ws:// socket", () => {
  assert.doesNotMatch(
    INDEX,
    /new WebSocket\(\s*`ws:\/\//,
    "index.html hardcodes ws:// — an HTTPS page blocks it as mixed content",
  );
});

test("the socket scheme is derived from location.protocol", () => {
  assert.match(
    INDEX,
    /location\.protocol\s*===\s*"https:"\s*\?\s*"wss:"\s*:\s*"ws:"/,
    "index.html must pick wss: on an https page",
  );
});

test("the socket is opened with that derived scheme", () => {
  assert.match(INDEX, /new WebSocket\(\s*`\$\{scheme\}\/\/\$\{location\.host\}\/ws`\s*\)/);
});
