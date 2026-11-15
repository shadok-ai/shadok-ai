import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { mergeAppendedPrompts } from "../src/prompt-args.js";

// Claude Code's `--append-system-prompt <prompt>` takes ONE value: given several,
// the model sees only the LAST (measured, claude 2.1.319). shadok passed the
// role, the env note, the pilot prompt and the ledger reflex as four flags, so
// an agent kept only the last of them.

test("several --append-system-prompt collapse into one, in order, at the first position", () => {
  const out = mergeAppendedPrompts([
    "--permission-mode", "auto",
    "--append-system-prompt", "ROLE",
    "--model", "opus",
    "--append-system-prompt", "NOTE",
    "--append-system-prompt", "PILOT",
    "--append-system-prompt", "LEDGER",
  ]);
  assert.deepEqual(out, [
    "--permission-mode", "auto",
    "--append-system-prompt", "ROLE\n\nNOTE\n\nPILOT\n\nLEDGER",
    "--model", "opus",
  ]);
  assert.equal(out.filter((a) => a === "--append-system-prompt").length, 1);
});

test("no flag, one flag: unchanged", () => {
  assert.deepEqual(mergeAppendedPrompts(["--model", "opus"]), ["--model", "opus"]);
  assert.deepEqual(mergeAppendedPrompts(["--append-system-prompt", "X", "--resume", "id"]), ["--append-system-prompt", "X", "--resume", "id"]);
});

test("a value that itself looks like a flag stays a value", () => {
  const out = mergeAppendedPrompts(["--append-system-prompt", "--append-system-prompt", "--append-system-prompt", "B"]);
  assert.deepEqual(out, ["--append-system-prompt", "--append-system-prompt\n\nB"]);
});

test("makePilot spawns with the merged args", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(src, /const fullArgs = mergeAppendedPrompts\(\[/);
});
