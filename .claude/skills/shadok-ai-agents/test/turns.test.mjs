import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockServer } from "./mock-server.mjs";

process.env.SHADOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pilotctl-test-"));
process.env.SHADOK_NO_HOLDER = "1";
process.env.SHADOK_NO_AUTOSTART = "1";
const { run, writeState } = await import("../pilotctl.mjs");

const READY = { type: "ready", sessionId: "abc", cwd: "/tmp/x" };

function useMock(mock) {
  process.env.SHADOK_PORT = String(mock.port);
  writeState("abc", { sessionId: "abc", cwd: "/tmp/x", holderPid: null });
}

test("prompt returns the answer streamed at turn-done", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [
      { type: "working" },
      { type: "stream-text", text: "Bonjour" },
      { type: "stream-tool", name: "Bash", summary: "ls" },
      { type: "stream-text", text: "Fini." },
      { type: "turn-done", sessionId: "abc" },
    ],
  });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "fais un truc"]);
    assert.equal(r.status, "answer");
    assert.equal(r.text, "Bonjour\n\nFini.");
    assert.deepEqual(r.tools, [{ name: "Bash", summary: "ls" }]);
    assert.deepEqual(mock.received[1], { type: "prompt", text: "fais un truc" });
  } finally {
    await mock.close();
  }
});

test("prompt remonte un dialog en attente", async () => {
  const dialog = {
    type: "dialog",
    question: "Autoriser Bash ?",
    options: [{ n: 1, label: "Oui" }, { n: 2, label: "Non" }],
    multi: false,
  };
  const mock = await startMockServer({ start: [READY], prompt: [{ type: "working" }, dialog] });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "fais un truc"]);
    assert.equal(r.status, "dialog");
    assert.equal(r.question, "Autoriser Bash ?");
    assert.equal(r.options.length, 2);
  } finally {
    await mock.close();
  }
});

test("a prompt with no end of turn returns a timeout with the current screen", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [{ type: "working" }, { type: "screen", text: "esc to interrupt", working: true }],
  });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "long", "--timeout", "1"]);
    assert.equal(r.status, "timeout");
    assert.equal(r.screen, "esc to interrupt");
  } finally {
    await mock.close();
  }
});

// The server refuses above the ideal pace: it sends "pace-blocked" and writes
// NOTHING into the TUI, so no "turn-done" will ever follow. The turn must end
// right away with the reason, and above all must not burn the timeout (600 s by
// default) only to return a mute {status:"timeout"}.
test("a prompt refused on pace ends immediately with the reason", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [
      { type: "pace-blocked", reason: "7d: 55% used vs 14% ideal pace (285% of pace)", text: "fais un truc" },
    ],
  });
  useMock(mock);
  try {
    const t0 = Date.now();
    // A generous timeout: were it reached, the test would take 30 s and the
    // status would be "timeout" — the two assertions below would catch it.
    const r = await run(["prompt", "abc", "fais un truc", "--timeout", "30"]);
    assert.equal(r.status, "pace-blocked");
    assert.equal(r.reason, "7d: 55% used vs 14% ideal pace (285% of pace)");
    assert.ok(Date.now() - t0 < 5_000, "must hand back control without waiting for the timeout");
    // Nothing was forced: pilotctl sends the prompt as is, exactly once.
    assert.deepEqual(mock.received[1], { type: "prompt", text: "fais un truc" });
    assert.equal(mock.received.length, 2);
  } finally {
    await mock.close();
  }
});

// Non-regression: adding "pace-blocked" to the list of turn endings must change
// nothing for an ordinary prompt.
test("an ordinary prompt is unchanged by the pace-blocked turn ending", async () => {
  const mock = await startMockServer({
    start: [READY],
    prompt: [
      { type: "working" },
      { type: "stream-text", text: "Bonjour" },
      { type: "turn-done", sessionId: "abc" },
    ],
  });
  useMock(mock);
  try {
    const r = await run(["prompt", "abc", "fais un truc", "--timeout", "30"]);
    assert.equal(r.status, "answer");
    assert.equal(r.text, "Bonjour");
    assert.equal(r.reason, undefined);
  } finally {
    await mock.close();
  }
});

test("choose commits an option and waits for what follows", async () => {
  const mock = await startMockServer({
    start: [READY],
    choose: [{ type: "working" }, { type: "stream-text", text: "ok" }, { type: "turn-done" }],
  });
  useMock(mock);
  try {
    const r = await run(["choose", "abc", "1"]);
    assert.equal(r.status, "answer");
    assert.deepEqual(mock.received[1], { type: "choose", n: 1 });
  } finally {
    await mock.close();
  }
});

test("dialog interroge via settle et mappe answer → idle", async () => {
  const mock = await startMockServer({ start: [READY], settle: [{ type: "turn-done" }] });
  useMock(mock);
  try {
    const r = await run(["dialog", "abc"]);
    assert.equal(r.status, "idle");
  } finally {
    await mock.close();
  }
});

test("freetext passes n and the text", async () => {
  const mock = await startMockServer({ start: [READY], freetext: [{ type: "turn-done" }] });
  useMock(mock);
  try {
    await run(["freetext", "abc", "3", "my answer"]);
    assert.deepEqual(mock.received[1], { type: "freetext", n: 3, text: "my answer" });
  } finally {
    await mock.close();
  }
});
