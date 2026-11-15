import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadHistory } from "../src/extract.js";
import { parseLine } from "../src/tail.js";

// A link to a message names a transcript uuid. Live, each text block is its own
// bubble (stream-text carries msgId); on replay consecutive blocks merge into one
// turn whose `ids` lists them all — so a link made on either side resolves.

const U1 = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";
const A2 = "33333333-3333-4333-8333-333333333333";
const C1 = "44444444-4444-4444-8444-444444444444";
const lines = [
  { type: "user", uuid: U1, message: { content: "⟦web · 2026-10-28 09:00 · steph⟧\nLook at this" } },
  { type: "assistant", uuid: A1, message: { content: [{ type: "text", text: "First block." }] } },
  { type: "assistant", uuid: "55555555-5555-4555-8555-555555555555", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
  { type: "user", uuid: "66666666-6666-4666-8666-666666666666", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
  { type: "assistant", uuid: A2, message: { content: [{ type: "text", text: "Second block." }] } },
  { type: "user", uuid: C1, message: { content: "⏰ [cron] check\n\nreport" } },
];

function withTranscript(fn: (cwd: string, sid: string) => void) {
  const prev = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ids-"));
  process.env.HOME = tmp;
  try {
    const cwd = "/tmp/ids/project";
    const sid = "77777777-7777-4777-8777-777777777777";
    const dir = path.join(tmp, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
    fn(cwd, sid);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("loadHistory: a user turn carries its uuid, a merged assistant turn all of them", () => {
  withTranscript((cwd, sid) => {
    const turns = loadHistory(cwd, sid);
    assert.deepEqual(turns.map((t) => [t.role, t.ids]), [
      ["user", [U1]],
      ["assistant", [A1, A2]],
    ]);
  });
});

test("tail: every text block carries the uuid its replayed turn lists (live == replay)", () => {
  const live = lines.flatMap((l) => parseLine(JSON.stringify(l)));
  const textIds = live.filter((e) => e.kind === "text").map((e: any) => e.uuid);
  assert.deepEqual(textIds, [A1, A2]);
});

test("tail: a visible prompt yields its id and display text; a cron one, a tool result do not", () => {
  const prompts = lines.flatMap((l) => parseLine(JSON.stringify(l))).filter((e) => e.kind === "prompt");
  assert.deepEqual(prompts, [{ kind: "prompt", uuid: U1, text: "Look at this" }]);
  // Without a uuid there is nothing to link to: no event at all.
  assert.deepEqual(parseLine(JSON.stringify({ type: "user", message: { content: "hi" } })), []);
});
