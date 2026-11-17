import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Agents were told to delegate by default (#442) but never to clean up, so the
// siblings they spawned piled up in the cockpit: a channel, a process and a
// resume at every restart each, long after their job was done. A prose rule no
// code change can turn red is exactly the kind that needs a test.
test("the pilot prompt tells agents to stop the siblings they spawned once done", () => {
  const prompt = read("context/pilot-prompt.md");
  assert.match(prompt, /pilotctl\.mjs stop <id>/, "must name the command");
  assert.match(prompt, /job is done|result is delivered/i, "must say when");
  assert.match(prompt, /schedule or a webhook/i, "must warn that schedules die with the channel (invariant 67)");
  assert.match(prompt, /only agents YOU spawned/i, "must scope it to its own children");
});

test("the agents skill's delegation flow ends with stop", () => {
  const skill = read("context/agents-skill/SKILL.md");
  assert.match(skill, /6\. result delivered[^\n]*`stop <id>`/);
});
