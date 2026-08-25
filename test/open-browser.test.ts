import assert from "node:assert/strict";
import test from "node:test";
import { openCommand, shouldOpenBrowser } from "../src/open-browser.js";

const base = { SHADOK_OPEN: "1" } as NodeJS.ProcessEnv;

test("opens on a desktop that asked for it", () => {
  assert.equal(shouldOpenBrowser({ env: { ...base, DISPLAY: ":0" }, platform: "linux", inContainer: false }), true);
  assert.equal(shouldOpenBrowser({ env: base, platform: "darwin", inContainer: false }), true);
});

test("never without the flag the first spawn sets", () => {
  // The supervisor respawns the server on every auto-update. Without this the
  // browser would pop open several times a day, on every instance.
  assert.equal(shouldOpenBrowser({ env: {}, platform: "darwin", inContainer: false }), false);
  assert.equal(shouldOpenBrowser({ env: { SHADOK_OPEN: "0" }, platform: "darwin", inContainer: false }), false);
});

test("never in a container", () => {
  // The four vps1 instances run in Docker: there is no browser to open, and the
  // spawn would just fail into the logs every boot.
  assert.equal(shouldOpenBrowser({ env: base, platform: "linux", inContainer: true }), false);
});

test("never over SSH", () => {
  // Opening a browser on the REMOTE machine helps nobody — the person is at the
  // other end of the pipe.
  assert.equal(
    shouldOpenBrowser({ env: { ...base, DISPLAY: ":0", SSH_CONNECTION: "10.0.0.1 22" }, platform: "linux", inContainer: false }),
    false,
  );
});

test("never on a Linux box with no display", () => {
  assert.equal(shouldOpenBrowser({ env: base, platform: "linux", inContainer: false }), false);
  // Wayland counts as a display just as much as X11.
  assert.equal(shouldOpenBrowser({ env: { ...base, WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", inContainer: false }), true);
});

test("macOS needs no DISPLAY — it has no such notion", () => {
  assert.equal(shouldOpenBrowser({ env: base, platform: "darwin", inContainer: false }), true);
});

test("openCommand picks the platform's opener", () => {
  assert.deepEqual(openCommand("darwin", "http://x"), { cmd: "open", args: ["http://x"] });
  assert.deepEqual(openCommand("linux", "http://x"), { cmd: "xdg-open", args: ["http://x"] });
  // The empty "" is the window TITLE start expects; without it a quoted URL
  // would be read as the title and nothing would open.
  assert.deepEqual(openCommand("win32", "http://x"), { cmd: "cmd", args: ["/c", "start", "", "http://x"] });
});

test("openCommand refuses a platform it does not know", () => {
  assert.equal(openCommand("aix", "http://x"), null);
});
