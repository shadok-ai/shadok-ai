import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { splitBySession, triggerCount, triggerSummary } from "../src/channel-triggers.js";

// Neutral fixtures: two agents, each with something aimed at it.
const crons = [
  { id: "c-1", sessionId: "agent-a", enabled: true },
  { id: "c-2", sessionId: "agent-b", enabled: true },
  { id: "c-3", sessionId: "agent-a", enabled: false },
];
const hooks = [
  { id: "w-1", sessionId: "agent-a" },
  { id: "w-2", sessionId: "agent-b" },
];

test("closing a channel removes exactly the rows that target it", () => {
  const { kept, removed } = splitBySession(crons, "agent-a");
  assert.deepEqual(removed.map((c) => c.id), ["c-1", "c-3"]);
  assert.deepEqual(kept.map((c) => c.id), ["c-2"]);
});

test("another channel's close leaves a store untouched, in order", () => {
  const { kept, removed } = splitBySession(crons, "agent-z");
  assert.deepEqual(removed, []);
  assert.deepEqual(kept, crons);
});

test("an empty id removes nothing, even from a row that has an empty one", () => {
  // `"" === ""` would otherwise turn a malformed row into collateral damage of
  // whichever close came first.
  const list = [...crons, { id: "c-x", sessionId: "", enabled: true }];
  const { kept, removed } = splitBySession(list, "");
  assert.deepEqual(removed, []);
  assert.equal(kept.length, list.length);
});

test("an id is matched whole, never as a prefix", () => {
  // Cron IDS accept a prefix (they are shown truncated); a session id is never
  // typed by anyone, and a prefix match here would delete a sibling's schedule.
  assert.deepEqual(splitBySession(crons, "agent").removed, []);
});

test("the input list is not mutated", () => {
  const before = JSON.stringify(crons);
  splitBySession(crons, "agent-a");
  assert.equal(JSON.stringify(crons), before);
});

test("the count includes paused schedules: they are deleted too", () => {
  assert.deepEqual(triggerCount("agent-a", crons, hooks), { schedules: 2, webhooks: 1 });
  assert.deepEqual(triggerCount("agent-z", crons, hooks), { schedules: 0, webhooks: 0 });
});

test("the summary names only what exists, and agrees in number", () => {
  assert.equal(triggerSummary({ schedules: 0, webhooks: 0 }), "");
  assert.equal(triggerSummary({ schedules: 1, webhooks: 0 }), "1 schedule");
  assert.equal(triggerSummary({ schedules: 0, webhooks: 2 }), "2 webhooks");
  assert.equal(triggerSummary({ schedules: 3, webhooks: 1 }), "3 schedules and 1 webhook");
});

// ── Non-regression: a DORMANT channel keeps its schedules ────────────────────
//
// The tempting implementation is "delete what targets a session with no running
// process". It fixes the reported symptom and silently deletes the feature: a
// schedule's whole job is to wake a channel that has none. The helpers cannot
// express that mistake (they take an id and nothing else), so what is locked
// here is the WIRING — the one place a liveness test could creep back in.

const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

/** The source of a top-level function, from its declaration to the next one. */
function bodyOf(name: string): string {
  const start = server.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `${name} not found in server.ts`);
  const rest = server.slice(start + 1);
  const next = rest.search(/^(async )?function \w+\(/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test("the helpers have no way to ask whether a process is running", () => {
  // A dormant channel and a live one are the same input: an id.
  assert.equal(splitBySession.length, 2);
  assert.deepEqual(
    splitBySession(crons, "agent-b").kept.map((c) => c.id),
    ["c-1", "c-3"],
    "rows of a channel that is not being closed stay, running or not",
  );
});

test("ending a PROCESS never deletes schedules — only closing a channel does", () => {
  // Idle reclaim, a restart and a crash all go through these; none of them
  // removes the channel, so none of them may touch what targets it.
  for (const fn of ["destroySession", "detach", "restartSession"]) {
    assert.doesNotMatch(bodyOf(fn), /forgetChannelTriggers|saveCrons|saveWebhooks/, `${fn} must not delete triggers`);
  }
  const callers = server.match(/(?<!function )forgetChannelTriggers\b(?=[(,\s}])/g) ?? [];
  // endChannel, plus the hook handed to the Telegram bridge at its two starts.
  assert.equal(callers.length, 3, "a new caller of forgetChannelTriggers must be a channel CLOSE");
});

test("endChannel refuses the home channel BEFORE deleting anything", () => {
  const body = bodyOf("endChannel");
  const guard = body.indexOf("isHomeChannel(ch)) return false");
  const cleanup = body.indexOf("forgetChannelTriggers(");
  assert.ok(guard !== -1 && cleanup !== -1);
  assert.ok(guard < cleanup, "the home refusal must come first");
  // A row that was never read cannot be told from the home base.
  assert.match(body, /if \(ch\) forgetChannelTriggers\(sessionId\)/);
});

test("the close confirmation says what else is deleted", () => {
  const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const start = page.indexOf("function confirmEndAgent(");
  const confirmFn = page.slice(start, page.indexOf("function closeTab(", start));
  assert.match(confirmFn, /tab\.closes/);
  assert.match(confirmFn, /also deletes/);
  assert.match(confirmFn, /cannot be undone/);
});
