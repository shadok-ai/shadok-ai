import test from "node:test";
import assert from "node:assert/strict";
import {
  isBinaryBusyError,
  binaryBusyError,
  startWithBusyRetry,
} from "../src/claude-bin.js";

test("recognises ETXTBSY as a code, as a message, and in prose", () => {
  assert.equal(isBinaryBusyError(Object.assign(new Error("spawn failed"), { code: "ETXTBSY" })), true);
  // node-pty surfaces the errno inside the message rather than as `code`.
  assert.equal(isBinaryBusyError(new Error("posix_spawnp failed: ETXTBSY")), true);
  assert.equal(isBinaryBusyError(new Error("Text file busy")), true);
  assert.equal(isBinaryBusyError(binaryBusyError("/usr/local/bin/claude")), true);
});

test("does NOT swallow the failures that must surface at once", () => {
  // A missing binary or a bad path does not get better by being asked six
  // times, and retrying would bury the message that says what is wrong.
  assert.equal(isBinaryBusyError(new Error("ENOENT: no such file or directory")), false);
  assert.equal(isBinaryBusyError(Object.assign(new Error("denied"), { code: "EACCES" })), false);
  assert.equal(isBinaryBusyError(undefined), false);
  assert.equal(isBinaryBusyError(null), false);
});

test("retries a busy binary and succeeds once the upgrade finishes", async () => {
  let calls = 0;
  const slept: number[] = [];
  await startWithBusyRetry(
    () => {
      calls++;
      if (calls < 3) throw binaryBusyError("claude");
    },
    { tries: 6, delayMs: 500, sleep: async (ms) => void slept.push(ms) },
  );
  assert.equal(calls, 3, "should have kept trying until the binary was runnable");
  assert.deepEqual(slept, [500, 500], "waits between attempts, not between attempt and success");
});

test("rethrows anything that is not a busy binary, on the FIRST attempt", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      startWithBusyRetry(
        () => {
          calls++;
          throw new Error("ENOENT: claude not found");
        },
        { tries: 6, sleep: async () => {} },
      ),
    /ENOENT/,
  );
  assert.equal(calls, 1, "a permanent failure must not be retried");
});

test("gives up after the last try and surfaces the real error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      startWithBusyRetry(
        () => {
          calls++;
          throw binaryBusyError("claude");
        },
        { tries: 4, sleep: async () => {} },
      ),
    /ETXTBSY/,
  );
  assert.equal(calls, 4, "exactly `tries` attempts, then the truth");
});

test("reports each retry, so a wait is never silent", async () => {
  const seen: string[] = [];
  let calls = 0;
  await startWithBusyRetry(
    () => {
      calls++;
      if (calls < 3) throw binaryBusyError("claude");
    },
    { tries: 6, sleep: async () => {}, onRetry: (a, t) => seen.push(`${a}/${t}`) },
  );
  assert.deepEqual(seen, ["1/6", "2/6"]);
});
