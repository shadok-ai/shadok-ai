import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.js";

test("parseArgs: defaults", () => {
  assert.deepEqual(parseArgs([]), { noTelegram: false, help: false, version: false });
});

test("parseArgs: --port / -p reads the next token as a number", () => {
  assert.equal(parseArgs(["--port", "4000"]).port, 4000);
  assert.equal(parseArgs(["-p", "8080"]).port, 8080);
});

test("parseArgs: flags", () => {
  assert.equal(parseArgs(["--no-telegram"]).noTelegram, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("parseArgs: unknown flags are ignored", () => {
  assert.deepEqual(parseArgs(["--wat", "--port", "5"]), {
    noTelegram: false,
    help: false,
    version: false,
    port: 5,
  });
});
