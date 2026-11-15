import assert from "node:assert/strict";
import test from "node:test";
import { IdleTimeoutError, keepWaitingAfterTimeout, idleTimeoutMessage } from "../src/detect.js";

test("IdleTimeoutError: the screen is data, and the message keeps its old wording for the CLI", () => {
  const e = new IdleTimeoutError(900_000, "✻ Working… (14m 59s)");
  assert.ok(e instanceof Error);
  assert.equal(e.timeoutMs, 900_000);
  assert.equal(e.screen, "✻ Working… (14m 59s)");
  assert.match(e.message, /^waitForIdle: timed out after 900000 ms\. Last screen:\n✻ Working/);
});

test("keepWaitingAfterTimeout: a long turn that still shows work is waited on, not abandoned", () => {
  assert.equal(keepWaitingAfterTimeout(new IdleTimeoutError(1, ""), true), true);
});

test("keepWaitingAfterTimeout: a screen that churns with no work marker is a real hang → give up", () => {
  assert.equal(keepWaitingAfterTimeout(new IdleTimeoutError(1, ""), false), false);
});

test("keepWaitingAfterTimeout: any other failure (process exited…) is never swallowed", () => {
  assert.equal(keepWaitingAfterTimeout(new Error("The claude process has exited."), true), false);
  assert.equal(keepWaitingAfterTimeout("boom", true), false);
});

test("idleTimeoutMessage: a sentence for a person, never the raw screen", () => {
  const m = idleTimeoutMessage(900_000);
  assert.match(m, /15 min/);
  assert.match(m, /terminal view/);
  assert.doesNotMatch(m, /Last screen|waitForIdle/);
});
