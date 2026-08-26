import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  rootIdFromChunk,
  idFromTranscriptName,
  forkTarget,
  rootIdOfFile,
  detectFork,
} from "../src/forktrace.js";

const ROOT = "15f1efac-369a-4373-9622-255b0ce12618";
const NEW = "94f5df2b-eb6a-48dc-9cac-0d2daec70baf";
const SIBLING = "6468a748-5b71-44f8-b6b3-d872e61c36ca";

test("rootIdFromChunk: pulls the snake session_id (lineage root), ignores the camel one", () => {
  // A real fork record carries BOTH: camel `sessionId` = own id, snake
  // `session_id` = root. We want the snake one.
  const line = `{"sessionId":"${NEW}","session_id":"${ROOT}","type":"user"}`;
  assert.equal(rootIdFromChunk(line), ROOT);
  // whitespace-tolerant
  assert.equal(rootIdFromChunk(`{ "session_id" : "${ROOT}" }`), ROOT);
  // no snake field (e.g. the opening `mode` record) → null
  assert.equal(rootIdFromChunk(`{"sessionId":"${NEW}","type":"mode"}`), null);
  assert.equal(rootIdFromChunk("not json at all"), null);
});

test("idFromTranscriptName: only a bare <uuid>.jsonl name yields an id", () => {
  assert.equal(idFromTranscriptName(`${NEW}.jsonl`), NEW);
  assert.equal(idFromTranscriptName(`${NEW}.pos`), null);
  assert.equal(idFromTranscriptName(`${NEW}.jsonl.bak`), null);
  assert.equal(idFromTranscriptName("summary.jsonl"), null);
});

test("forkTarget: newest SAME-lineage file with a different id — never a sibling", () => {
  // the fork: newer file, root matches ours, own id differs → follow it
  assert.equal(
    forkTarget([{ id: NEW, mtime: 200, root: ROOT }], ROOT, ROOT),
    NEW,
  );
  // a sibling agent's file (its root is its OWN id, not ours) is never adopted,
  // even though it is newer — this is the shared-cwd safety property
  assert.equal(
    forkTarget([{ id: SIBLING, mtime: 999, root: SIBLING }], ROOT, ROOT),
    null,
  );
  // fork present alongside a sibling → pick the fork, ignore the sibling
  assert.equal(
    forkTarget(
      [
        { id: SIBLING, mtime: 999, root: SIBLING },
        { id: NEW, mtime: 200, root: ROOT },
      ],
      ROOT,
      ROOT,
    ),
    NEW,
  );
  // a multi-step chain (both rooted at ROOT) → jump to the NEWEST tip
  const TIP = "aaaaaaaa-eb6a-48dc-9cac-0d2daec70baf";
  assert.equal(
    forkTarget(
      [
        { id: NEW, mtime: 200, root: ROOT },
        { id: TIP, mtime: 300, root: ROOT },
      ],
      ROOT,
      ROOT,
    ),
    TIP,
  );
  // the id we already tail is skipped even if it resurfaces as a candidate
  assert.equal(forkTarget([{ id: NEW, mtime: 200, root: ROOT }], NEW, ROOT), null);
  // nothing newer/matching → no-op
  assert.equal(forkTarget([], ROOT, ROOT), null);
  // a file whose root we could not read (null) is not assumed to match
  assert.equal(forkTarget([{ id: NEW, mtime: 200, root: null }], ROOT, ROOT), null);
});

// One transcript line as Claude Code writes it: `sessionId` (own id, = filename)
// plus `session_id` (lineage root). `mkTranscript` writes such a file and back-
// dates its mtime so "newer than the frozen file" is deterministic.
function writeTranscript(dir: string, ownId: string, rootId: string, mtimeMs: number): void {
  const f = path.join(dir, `${ownId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "mode", mode: "normal", sessionId: ownId }),
    JSON.stringify({ type: "user", sessionId: ownId, session_id: rootId, message: { role: "user" } }),
  ];
  fs.writeFileSync(f, lines.join("\n") + "\n");
  const t = mtimeMs / 1000;
  fs.utimesSync(f, t, t);
}

test("rootIdOfFile: reads the snake session_id from a real file; null on absence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forktrace-"));
  try {
    writeTranscript(dir, NEW, ROOT, 1000);
    assert.equal(rootIdOfFile(path.join(dir, `${NEW}.jsonl`)), ROOT);
    // an original session: root == own id
    writeTranscript(dir, ROOT, ROOT, 1000);
    assert.equal(rootIdOfFile(path.join(dir, `${ROOT}.jsonl`)), ROOT);
    assert.equal(rootIdOfFile(path.join(dir, "nope.jsonl")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectFork: follows the fork, ignores the sibling, no-ops when quiet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forktrace-"));
  try {
    // the session we tail: original, frozen at an OLD mtime
    writeTranscript(dir, ROOT, ROOT, 1_000_000);
    const myFile = path.join(dir, `${ROOT}.jsonl`);

    // before any fork: only our file + a sibling (its own root, newer) → no-op
    writeTranscript(dir, SIBLING, SIBLING, 5_000_000);
    assert.equal(detectFork(myFile, ROOT, ROOT), null);

    // the fork appears, NEWER than our frozen file, rooted at ROOT → follow it
    writeTranscript(dir, NEW, ROOT, 9_000_000);
    assert.equal(detectFork(myFile, ROOT, ROOT), NEW);

    // once we tail the fork, our "file" is NEW; nothing newer in the lineage → no-op
    const forkFile = path.join(dir, `${NEW}.jsonl`);
    assert.equal(detectFork(forkFile, NEW, ROOT), null);

    // anti-flap: if the dead ROOT file were re-touched newer than NEW, we must
    // NOT oscillate back onto it once it is in the `seen` set
    writeTranscript(dir, ROOT, ROOT, 12_000_000); // ROOT bumped past NEW
    assert.equal(detectFork(forkFile, NEW, ROOT), ROOT); // without the guard, it flaps
    assert.equal(detectFork(forkFile, NEW, ROOT, new Set([ROOT])), null); // guarded
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
