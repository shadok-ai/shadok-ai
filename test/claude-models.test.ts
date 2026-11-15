import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseModelNames, rankModels, cacheIsFresh, scanModels, availableModels, resetModelMemo,
} from "../src/claude-models.js";

test("parseModelNames keeps plain names and drops the longer spellings", () => {
  const blob = [
    "claude-opus-5-5", "claude-opus-5", "claude-sonnet-4-5",
    "claude-opus-4-5-20251101", "claude-opus-4-5-20251101-v1", "claude-opus-4-6-v1",
  ].join("\u0000");
  const got = parseModelNames(blob);
  assert.ok(got.includes("claude-opus-5-5"));
  assert.ok(got.includes("claude-sonnet-4-5"));
  // A dated form is the SAME model spelled longer. Three spellings of one model
  // in a picker is noise, not choice — and `-20251101` would sort as a version.
  assert.ok(!got.some((n) => /\d{8}/.test(n)), "a dated form got through");
  assert.ok(!got.some((n) => /-v\d+$/.test(n)), "a -v1 form got through");
});

test("parseModelNames refuses the artifacts a strings dump invents", () => {
  // THE reason this filter is narrow. A dump glues adjacent bytes, and this
  // binary really does contain both of these. Offering them would produce an
  // agent that dies at spawn on a model nobody can find — the silent-loss
  // shape shadok keeps paying for.
  const got = parseModelNames("claude-haiku-3-55\u0000claude-fable-5-mythos-5\u0000claude-haiku-3-5");
  assert.deepEqual(got, ["claude-haiku-3-5"]);
});

test("parseModelNames does not truncate a longer name into a shorter one", () => {
  // Without the trailing guard, `claude-opus-4-5-20251101` would ALSO yield the
  // prefix `claude-opus-4-5` — inventing a choice out of a name we rejected.
  assert.deepEqual(parseModelNames("claude-opus-4-5-20251101"), []);
  assert.deepEqual(parseModelNames("claude-opus-4-5"), ["claude-opus-4-5"]);
});

test("rankModels puts the newest of each family first", () => {
  const got = rankModels([
    "claude-sonnet-4-5", "claude-opus-4-8", "claude-opus-5-5", "claude-opus-5", "claude-haiku-4-5",
  ]);
  assert.deepEqual(got, [
    "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5",
  ]);
});

test("a cache entry is stale the moment the binary is replaced", () => {
  // The trio that changes on every claude-code upgrade. Getting this wrong
  // means one scan then a list frozen for the life of the install.
  const c = { bin: "/b", size: 10, mtimeMs: 5, models: ["claude-opus-5"] };
  assert.ok(cacheIsFresh(c, { size: 10, mtimeMs: 5 }, "/b"));
  assert.ok(!cacheIsFresh(c, { size: 11, mtimeMs: 5 }, "/b"), "size change missed");
  assert.ok(!cacheIsFresh(c, { size: 10, mtimeMs: 6 }, "/b"), "mtime change missed");
  assert.ok(!cacheIsFresh(c, { size: 10, mtimeMs: 5 }, "/other"), "path change missed");
  assert.ok(!cacheIsFresh(c, null, "/b"), "a vanished binary must not look fresh");
  assert.ok(!cacheIsFresh(null, { size: 10, mtimeMs: 5 }, "/b"));
});

test("scanning a missing or placeholder binary yields nothing, never a throw", () => {
  // The normal case, not the exception: the launcher is unlinked and relinked
  // on EVERY claude-code upgrade (invariant 32), so a scan meets ETXTBSY, a
  // 500-byte stub, or no file at all. It must degrade to the family row.
  assert.deepEqual(scanModels("/nonexistent/claude"), []);
});

test("a failed scan is never memoised as the answer", () => {
  // `if (memo && ...)` treated an EMPTY array as a cached answer, so one scan
  // during a claude-code upgrade froze the picker family-only for the life of
  // the process. An empty array is truthy; a "could not look" is not an answer.
  // Same rule the file cache already had — invariant 32's "never cache a
  // verdict about the binary", applied to the memo too.
  resetModelMemo();
  const first = availableModels("/nonexistent/claude");
  assert.deepEqual(first, []);
  // A later call must try again rather than serve the empty memo. The real
  // binary is not available in CI, so we assert the CALL happens by pointing at
  // a readable file that does contain a name.
  const f = path.join(os.tmpdir(), `shadok-models-${process.pid}.bin`);
  fs.writeFileSync(f, "\u0000\u0000claude-opus-5-5\u0000\u0000");
  try {
    assert.deepEqual(availableModels(f), ["claude-opus-5-5"]);
  } finally {
    fs.rmSync(f, { force: true });
    resetModelMemo();
  }
});
