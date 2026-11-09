import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { glanceFromTail, glanceFile, TAIL_BYTES } from "../src/glance.js";

const user = (ts: string, text: string) =>
  JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const asst = (ts: string, content: any[], usage?: any) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id: "m" + ts, content, ...(usage ? { usage } : {}) } });
const toolResult = (ts: string) =>
  JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });

test("last visible message and last usage come from the end", () => {
  const g = glanceFromTail(
    [
      user("2026-11-09T10:00:00Z", "hello"),
      asst("2026-11-09T10:00:05Z", [{ type: "text", text: "hi" }], { input_tokens: 1, cache_read_input_tokens: 99 }),
      asst("2026-11-09T10:00:09Z", [{ type: "tool_use", id: "x", name: "Bash", input: {} }], { input_tokens: 2, cache_read_input_tokens: 500 }),
      toolResult("2026-11-09T10:00:10Z"),
      "",
    ].join("\n"),
  );
  // A tool call/result is not a chat message: the time stays on the "hi".
  assert.equal(g.lastAt, Date.parse("2026-11-09T10:00:05Z"));
  assert.equal(g.usage?.cacheRead, 500);
});

test("a line cut in half by the byte window is skipped, not fatal", () => {
  const g = glanceFromTail('ntent":"half"}}\n' + user("2026-11-09T11:00:00Z", "later"));
  assert.equal(g.lastAt, Date.parse("2026-11-09T11:00:00Z"));
  assert.equal(g.usage, null);
});

test("glanceFile reads only the tail and tolerates a missing file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glance-"));
  try {
    const file = path.join(dir, "s.jsonl");
    const filler = user("2026-01-01T00:00:00Z", "x".repeat(TAIL_BYTES * 2));
    fs.writeFileSync(file, filler + "\n" + asst("2026-11-09T12:00:00Z", [{ type: "text", text: "end" }], { input_tokens: 7 }) + "\n");
    const g = await glanceFile(file);
    assert.equal(g.lastAt, Date.parse("2026-11-09T12:00:00Z"));
    assert.equal(g.usage?.input, 7);
    assert.deepEqual(await glanceFile(path.join(dir, "nope.jsonl")), { lastAt: null, usage: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
