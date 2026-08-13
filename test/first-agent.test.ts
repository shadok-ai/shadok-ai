import assert from "node:assert/strict";
import test from "node:test";
import { BOSS_PROFILE_NAME } from "../src/profiles.js";
import { FIRST_AGENT_NAME, firstAgentPlan } from "../src/first-agent.js";

test("a signed-in instance with no channel gets the lead agent", () => {
  const p = firstAgentPlan({ channelCount: 0, authState: "signed-in" });
  assert.equal(p.spawn, true);
  assert.equal(p.name, FIRST_AGENT_NAME);
  assert.equal(p.profile, BOSS_PROFILE_NAME);
});

test("an instance that already has a channel is left alone", () => {
  // The whole idempotence rests on this: the condition IS "no channel", so the
  // call can be made at boot and after every sign-in without a second guard.
  const p = firstAgentPlan({ channelCount: 1, authState: "signed-in" });
  assert.equal(p.spawn, false);
  assert.equal(p.reason, "channels-exist");
});

test("a signed-out instance spawns nothing", () => {
  // Spawning here is exactly how zombie agents were made: a process with no
  // credentials, sitting on a screen nobody reads.
  const p = firstAgentPlan({ channelCount: 0, authState: "signed-out" });
  assert.equal(p.spawn, false);
  assert.equal(p.reason, "not-signed-in");
});

test("an auth state we could not read spawns nothing either", () => {
  // "unknown" means the probe failed, not that we are signed in. Waiting costs
  // one boot; guessing costs an agent that cannot work (invariant 29).
  const p = firstAgentPlan({ channelCount: 0, authState: "unknown" });
  assert.equal(p.spawn, false);
  assert.equal(p.reason, "not-signed-in");
});

test("the channel check comes FIRST, whatever the auth state", () => {
  // A cockpit in use must never be told "not signed in" as the reason it was
  // skipped — the log is the only place this decision is ever visible.
  const p = firstAgentPlan({ channelCount: 3, authState: "unknown" });
  assert.equal(p.reason, "channels-exist");
});
