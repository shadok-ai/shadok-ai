import { test } from "node:test";
import assert from "node:assert/strict";
import { cronMentionsSkill } from "../src/factory.js";
import { cronUsers, type CronLike } from "../src/skill-usage.js";

test("cronMentionsSkill: /name, name:name and the whole word — never a prefix of a longer name", () => {
  assert.ok(cronMentionsSkill("/daily-report then post it", "daily-report"));
  assert.ok(cronMentionsSkill("Run daily-report:daily-report", "daily-report"));
  assert.ok(cronMentionsSkill("use the daily-report skill.", "daily-report"));
  assert.ok(cronMentionsSkill("Use DAILY-REPORT", "daily-report"));
  assert.ok(!cronMentionsSkill("use daily-report-v2", "daily-report"));
  assert.ok(!cronMentionsSkill("a pre-daily-report step", "daily-report"));
  assert.ok(!cronMentionsSkill("", "daily-report"));
  // A regex metacharacter in a name is literal.
  assert.ok(!cronMentionsSkill("axb", "a.b"));
});

const cron = (id: string, sessionId: string, prompt: string): CronLike => ({ id, sessionId, prompt, enabled: true, label: "every 1h" });
const channels = [
  { sessionId: "s-one-xxxxxx", name: "one", group: "1" },
  { sessionId: "s-two-xxxxxx", name: null, group: null },
  { sessionId: "s-three-xxxx", name: "three" },
];

test("cronUsers: a cron that names the skill lists its agent before any run", () => {
  const out = cronUsers("digest", [cron("c1", "s-one-xxxxxx", "/digest"), cron("c2", "s-one-xxxxxx", "check the CI")], channels, undefined);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "one");
  assert.equal(out[0].cronRuns, 0);
  assert.deepEqual(out[0].crons.map((c) => [c.id, c.mentions]), [["c1", true]]);
});

test("cronUsers: a recorded cron run lists the agent even when no prompt names it — with all its crons", () => {
  const out = cronUsers("digest", [cron("c3", "s-two-xxxxxx", "morning routine"), cron("c4", "s-two-xxxxxx", "evening")], channels, { "s-two-xxxxxx": 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "s-two-xx");
  assert.equal(out[0].cronRuns, 3);
  assert.deepEqual(out[0].crons.map((c) => c.mentions), [false, false]);
});

test("cronUsers: an agent with neither is left out, and so is one outside the given channels", () => {
  const out = cronUsers("digest", [cron("c5", "s-three-xxxx", "nothing here"), cron("c6", "s-ghost", "/digest")], channels, { "s-ghost": 9 });
  assert.deepEqual(out, []);
});
