import assert from "node:assert/strict";
import test from "node:test";
import { BOSS_PROFILE_NAME } from "../src/profiles.js";
import { FIRST_AGENT_NAME, firstAgentPlan, countMainChannels } from "../src/first-agent.js";

test("a signed-in instance with no channel gets the lead agent", () => {
  const p = firstAgentPlan({ mainChannelCount: 0, connected: "yes" });
  assert.equal(p.spawn, true);
  assert.equal(p.name, FIRST_AGENT_NAME);
  assert.equal(p.profile, BOSS_PROFILE_NAME);
});

test("an instance that already has a channel is left alone", () => {
  // The whole idempotence rests on this: the condition IS "no channel", so the
  // call can be made at boot and after every sign-in without a second guard.
  const p = firstAgentPlan({ mainChannelCount: 1, connected: "yes" });
  assert.equal(p.spawn, false);
  assert.equal(p.reason, "channels-exist");
});

test("a signed-out instance spawns nothing", () => {
  // Spawning here is exactly how zombie agents were made: a process with no
  // credentials, sitting on a screen nobody reads.
  const p = firstAgentPlan({ mainChannelCount: 0, connected: "no" });
  assert.equal(p.spawn, false);
  assert.equal(p.reason, "not-signed-in");
});

test("an auth state we could not read spawns nothing either", () => {
  // "unknown" means the probe failed, not that we are signed in. Waiting costs
  // one boot; guessing costs an agent that cannot work (invariant 27).
  const p = firstAgentPlan({ mainChannelCount: 0, connected: "unknown" });
  assert.equal(p.spawn, false);
  assert.equal(p.reason, "not-signed-in");
});

test("the channel check comes FIRST, whatever the auth state", () => {
  // A cockpit in use must never be told "not signed in" as the reason it was
  // skipped — the log is the only place this decision is ever visible.
  const p = firstAgentPlan({ mainChannelCount: 3, connected: "unknown" });
  assert.equal(p.reason, "channels-exist");
});

test("only Main counts: channels in other groups never block (or trigger) the lead", () => {
  const chans = [{ group: "g-private" }, { group: "g-private" }];
  // Main is empty while a private group is busy -> the lead is still due.
  assert.equal(countMainChannels(chans), 0);
  assert.equal(firstAgentPlan({ mainChannelCount: countMainChannels(chans), connected: "yes" }).spawn, true);
});

test("a non-empty Main means no lead, even if other groups are empty", () => {
  assert.equal(countMainChannels([{ group: "main" }]), 1);
  assert.equal(firstAgentPlan({ mainChannelCount: 1, connected: "yes" }).spawn, false);
});

test("null / missing group is the commons (mono-tenant unchanged)", () => {
  const chans = [{ group: null }, {}, { group: "main" }];
  assert.equal(countMainChannels(chans), 3);
});

test("a brand-new private group with zero channels triggers nothing", () => {
  // Zero channels in the private group is invisible to the plan: it only ever
  // sees Main's count, and Main already has its lead.
  const chans = [{ group: "main" }];
  assert.equal(firstAgentPlan({ mainChannelCount: countMainChannels(chans), connected: "yes" }).spawn, false);
});

test("the first agent is born in Main, never in its creator's private group", async () => {
  // PR #428 fixed the browser's Main view; the lead agent is spawned by the
  // SERVER over its loopback as the bootstrap admin, and without an explicit
  // group the isolation policy filed it into the admin's Personal (reproduced
  // on a fresh multi-tenant instance, 2026-11-09).
  const { firstAgentStartMessage } = await import("../src/first-agent.js");
  const { MAIN_GROUP_ID } = await import("../src/groups.js");
  const m = firstAgentStartMessage("/workspace", "Shadok-Boss");
  assert.equal(m.type, "start");
  assert.equal(m.group, MAIN_GROUP_ID);
  assert.equal(m.cwd, "/workspace");
  assert.equal(m.profile, "Shadok-Boss");
  assert.equal(m.origin, "boot");
});
