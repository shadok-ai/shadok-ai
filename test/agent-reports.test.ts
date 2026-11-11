import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reportInput, fileReport, rateRefusal, shouldNotify, reportsInbox, markReportsSeen, resolveReport,
  notificationText, loadReports, saveReports, MAX_NEW_PER_HOUR, RENOTIFY_MS, RESOLVED_TTL_MS, type AgentReport,
} from "../src/agent-reports.js";

const who = { sessionId: "s1", agent: "triage", group: null, profile: "Dev" };

test("input: a title is required, kind defaults to bug, a secret is a NAME not a value", () => {
  assert.equal(reportInput({}).ok, false);
  assert.equal(reportInput({ title: "   " }).ok, false);
  const ok = reportInput({ title: " Linear  token\nexpired ", body: " 401 " });
  assert.deepEqual(ok, { ok: true, input: { kind: "bug", title: "Linear token expired", body: "401" } });
  assert.equal(reportInput({ title: "x", kind: "panic" }).ok, false);
  assert.equal(reportInput({ title: "x", kind: "access", secret: "LINEAR_API_KEY" }).ok, true);
  // A value pasted where the name goes is refused, and the error does not echo it.
  const bad = reportInput({ title: "x", secret: "lin_api_abc def" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && !bad.error.includes("lin_api_abc"));
  assert.equal(reportInput({ title: "x".repeat(201) }).ok, false);
});

test("file: the same open problem from the same agent merges, never duplicates", () => {
  const a = fileReport([], { kind: "access", title: "Linear token expired" }, who, 10, "r1");
  assert.equal(a.merged, false);
  const seen = markReportsSeen(a.list, "ada");
  const b = fileReport(seen, { kind: "access", title: "linear token  EXPIRED", body: "again" }, who, 20);
  assert.equal(b.merged, true);
  assert.equal(b.list.length, 1);
  assert.equal(b.report.count, 2);
  assert.equal(b.report.lastAt, 20);
  assert.equal(b.report.body, "again");
  // Filed again = unread again.
  assert.equal(reportsInbox(b.list, "ada").badge, 1);
  // Another agent, or a resolved one, is a new report.
  assert.equal(fileReport(b.list, { kind: "access", title: "Linear token expired" }, { ...who, sessionId: "s2" }, 30).merged, false);
  const res = resolveReport(b.list, "r1", "ada", 40);
  assert.ok(res.ok);
  assert.equal(fileReport(res.ok ? res.list : [], { kind: "access", title: "Linear token expired" }, who, 50).merged, false);
});

test("rate: new reports per agent per hour are capped; other agents are unaffected", () => {
  let list: AgentReport[] = [];
  for (let i = 0; i < MAX_NEW_PER_HOUR; i++) list = fileReport(list, { kind: "bug", title: "b" + i }, who, 1000 + i).list;
  assert.ok(rateRefusal(list, "s1", 2000));
  assert.equal(rateRefusal(list, "s2", 2000), null);
  assert.equal(rateRefusal(list, "s1", 1000 + 3600_000), null);
});

test("notify: always for a new report, for a duplicate at most hourly", () => {
  const r = fileReport([], { kind: "bug", title: "t" }, who, 0).report;
  assert.equal(shouldNotify(r, false, 0), true);
  assert.equal(shouldNotify({ ...r, notifiedAt: 0 }, true, RENOTIFY_MS - 1), false);
  assert.equal(shouldNotify({ ...r, notifiedAt: 0 }, true, RENOTIFY_MS), true);
});

test("inbox: open first, newest first; badge counts unseen open reports; resolve and reopen", () => {
  let list = fileReport([], { kind: "bug", title: "old" }, who, 1, "a").list;
  list = fileReport(list, { kind: "bug", title: "new" }, who, 2, "b").list;
  const r = resolveReport(list, "b", "ada", 3);
  assert.ok(r.ok);
  list = r.ok ? r.list : list;
  const box = reportsInbox(list, "ada");
  assert.deepEqual(box.reports.map((x) => x.id), ["a", "b"]);
  assert.equal(box.badge, 1);
  assert.equal(reportsInbox(markReportsSeen(list, "ada"), "ada").badge, 0);
  assert.equal(reportsInbox(markReportsSeen(list, "ada"), "bob").badge, 1);
  const back = resolveReport(list, "b", "ada", 4, true);
  assert.ok(back.ok && back.report.status === "open" && back.report.resolvedBy === undefined);
  assert.equal(resolveReport(list, "zz", "ada", 4).ok, false);
});

test("prune: resolved reports age out, open ones stay", () => {
  let list = fileReport([], { kind: "bug", title: "open" }, who, 0, "o").list;
  list = fileReport(list, { kind: "bug", title: "done" }, who, 0, "d").list;
  const r = resolveReport(list, "d", "ada", 0);
  list = r.ok ? r.list : list;
  const later = fileReport(list, { kind: "bug", title: "x" }, { ...who, sessionId: "s9" }, RESOLVED_TTL_MS + 1).list;
  assert.deepEqual(later.map((x) => x.id).sort(), ["o", later.find((x) => x.title === "x")!.id].sort());
});

test("notification text names the agent, the problem and the secret", () => {
  const r = fileReport([], { kind: "access", title: "Claude API 401", secret: "ANTHROPIC_API_KEY", body: "b".repeat(700) }, who, 0).report;
  const t = notificationText(r, "Prod");
  assert.match(t, /triage needs an admin · Prod/);
  assert.match(t, /access: Claude API 401/);
  assert.match(t, /secret: ANTHROPIC_API_KEY/);
  assert.ok(t.includes("…"));
});

test("storage round-trips with mode 600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reports-"));
  try {
    const f = path.join(dir, "sub", "r.json");
    assert.deepEqual(loadReports(f), []);
    const list = fileReport([], { kind: "bug", title: "t" }, who, 0, "x").list;
    saveReports(list, f);
    assert.deepEqual(loadReports(f), list);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
