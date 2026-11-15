import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { SPAWN_STEPS, spawnStepStates, spawnLoaderTitle, SPAWN_HINT } from "../public/spawn-steps.js";
import { SPAWN_STEP_KEYS, isSpawnStep } from "../src/spawn-steps.js";
import {
  announceFirstAgent,
  firstAgentStatus,
  noteFirstAgentStep,
  settleFirstAgent,
} from "../src/first-agent.js";

const states = (cur: unknown) => spawnStepStates(cur).map((s) => s.state);

test("no step yet: the first one is under way, the rest to come", () => {
  assert.deepEqual(states(null), ["on", "todo", "todo"]);
});

test("each step ticks off everything before it", () => {
  assert.deepEqual(states("connect"), ["on", "todo", "todo"]);
  assert.deepEqual(states("workspace"), ["done", "on", "todo"]);
  assert.deepEqual(states("claude"), ["done", "done", "on"]);
});

test("an unknown step reads as the start, never as a crash or a skip", () => {
  assert.deepEqual(states("teleport"), ["on", "todo", "todo"]);
  assert.deepEqual(states(undefined), ["on", "todo", "todo"]);
});

test("every step has a label the person can read", () => {
  for (const s of spawnStepStates("workspace")) assert.ok(s.label.length > 3, s.key);
});

test("the title names the agent, or falls back to a generic one", () => {
  assert.equal(spawnLoaderTitle("researcher"), "researcher is waking up…");
  assert.equal(spawnLoaderTitle("  "), "Your agent is waking up…");
  assert.equal(spawnLoaderTitle(null), "Your agent is waking up…");
  assert.match(SPAWN_HINT, /real Claude Code session/);
});

test("the server's steps and the page's steps are the same list, in the same order", () => {
  assert.deepEqual(SPAWN_STEPS.map((s) => s.key), [...SPAWN_STEP_KEYS]);
  assert.ok(isSpawnStep("claude"));
  assert.ok(!isSpawnStep("nope"));
});

test("the start handler announces each step BEFORE the work it names, fresh spawns only", () => {
  const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const start = src.indexOf('case "start": {');
  const body = src.slice(start, src.indexOf("session = await createSession(", start) + 40);
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  assert.ok(at('announceStep("connect")') < at("await ensureClaudeOnce()"));
  assert.ok(at('announceStep("workspace")') < at("createWorktree("));
  assert.ok(at('announceStep("claude")') < at("session = await createSession("));
  // A resume shows its history, not a birth: the announcer is gated on a fresh spawn.
  assert.match(body, /const announceStep = \(step: SpawnStep\) => \{\s*if \(!freshSpawn\) return;/);
});

test("the first agent's status carries the step it is at, and clears it when settled", () => {
  announceFirstAgent(0);
  assert.equal(firstAgentStatus().step, null);
  noteFirstAgentStep("workspace");
  assert.equal(firstAgentStatus().step, "workspace");
  noteFirstAgentStep("bogus");
  assert.equal(firstAgentStatus().step, "workspace");
  settleFirstAgent("first-boot");
  assert.equal(firstAgentStatus().step, null);
  // A step arriving after the wait ended must not revive a stale one.
  noteFirstAgentStep("claude");
  assert.equal(firstAgentStatus().step, null);
});

test("the page shows the loader on a fresh tab and drops it on every way out", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /import \{[^}]*spawnStepStates[^}]*\} from "\/spawn-steps\.js\?v=__ASSET_V__"/);
  assert.match(html, /case "starting":/);
  for (const c of ['case "ready":', 'case "error":', 'case "exited":', 'case "gone":']) {
    const i = html.indexOf(c);
    assert.ok(i >= 0, c);
    assert.match(html.slice(i, i + 900), /clearSpawnLoader\(t\)/, `${c} must drop the loader`);
  }
});
