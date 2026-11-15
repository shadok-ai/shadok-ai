import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { bangCommands } from "../public/bang.js";

const prompt = readFileSync(new URL("../context/pilot-prompt.md", import.meta.url), "utf8");

// The `!` run-button only ever appears when an agent actually writes `! cmd`
// (public/bang.js). The feature is useless if the pilot prompt never tells
// agents to produce it — the reported symptom was agents saying "run <cmd>"
// without the prefix, so no button. Lock the guidance the way
// test/skill-auth-docs.test.ts locks the auth-header prose: a code change can't
// turn it red, which is exactly why a prose rule needs a test.
test("the pilot prompt tells agents to prefix human-run commands with !", () => {
  assert.match(prompt, /`!\s*cmd`|leading `!`|prefix the command with `!`/, "must name the ! convention");
  assert.match(prompt, /run button|▶/, "must say what the ! produces (a run button)");
  assert.match(prompt, /only the human can do|command the human\s+must run|only for a command/i,
    "must scope it to commands the human must run, not ones the agent can run itself");
});

test("the example the prompt gives is itself a recognised `!` command", () => {
  // Guard against documenting a shape the parser would not actually light up.
  assert.deepEqual(bangCommands("inline `! claude auth login` here"), ["claude auth login"]);
  assert.deepEqual(bangCommands("! gcloud auth login"), ["gcloud auth login"]);
});
