import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECOVERY_COOLDOWN_MS,
  UNRESPONSIVE_CODE,
  UNRESPONSIVE_MESSAGE,
  UNRESPONSIVE_REPORT_TITLE,
  UnresponsiveError,
  submitRecoveryEnabled,
  submitRecoveryVerdict,
  submitWithRecovery,
  unresponsiveReportBody,
  type SubmitRecoveryInput,
  type SubmitRecoveryVerdict,
} from "../src/submit-recovery.js";
import { SubmitError, submitFailure, stuckScreenKind, describeStuckScreen } from "../src/detect.js";
import { fileReport } from "../src/agent-reports.js";

// The incident's shape: a live process, nothing recognisable on screen, a
// prompt that never showed in the box, and no recovery attempted before.
const WEDGED: SubmitRecoveryInput = {
  enabled: true,
  failure: "not-typed",
  stuck: null,
  exited: false,
  working: false,
  dialogOpen: false,
  restarting: false,
  promptLanded: false,
  sinceLastRecoveryMs: Infinity,
  cooldownMs: RECOVERY_COOLDOWN_MS,
};

// ── the verdict ───────────────────────────────────────────────────────────

test("a prompt that never reached a live, idle agent restarts it", () => {
  assert.deepEqual(submitRecoveryVerdict(WEDGED), { action: "restart" });
});

test("both halves of a failed submit are the same wedge", () => {
  // The first failure of a wedge is often the Enter that never sent a text
  // already pasted; every later one is a paste that never shows.
  assert.equal(submitRecoveryVerdict({ ...WEDGED, failure: "not-sent" }).action, "restart");
});

test("a box left full by the wedge is still a restart", () => {
  // That is what the incident looked like: the previous message sat in the box
  // and no clear removed it.
  assert.equal(submitRecoveryVerdict({ ...WEDGED, stuck: "box-full" }).action, "restart");
});

test("what is not this class of failure is left exactly alone", () => {
  const cases: [Partial<SubmitRecoveryInput>, string][] = [
    [{ enabled: false }, "disabled"],
    [{ failure: null }, "not a submit failure"],
    [{ exited: true }, "process exited"],
    [{ restarting: true }, "already restarting"],
    [{ promptLanded: true }, "the prompt landed"],
    [{ working: true }, "a turn is running"],
    [{ dialogOpen: true }, "waiting on a question"],
    [{ stuck: "question" }, "waiting on a question"],
  ];
  for (const [over, why] of cases) {
    assert.deepEqual(submitRecoveryVerdict({ ...WEDGED, ...over }), { action: "none", why }, why);
  }
});

test("a running turn is never restarted, whatever else is true", () => {
  // The guard that matters most: a respawn here cuts real work.
  for (const stuck of [null, "box-full", "first-run", "masked"] as const) {
    assert.equal(submitRecoveryVerdict({ ...WEDGED, working: true, stuck }).action, "none", String(stuck));
  }
});

test("a prompt the transcript recorded is never delivered a second time", () => {
  assert.equal(submitRecoveryVerdict({ ...WEDGED, failure: "not-sent", promptLanded: true }).action, "none");
});

test("a screen a new process would land on again goes straight to a human", () => {
  for (const stuck of ["first-run", "masked"] as const) {
    const v = submitRecoveryVerdict({ ...WEDGED, stuck });
    assert.equal(v.action, "escalate", stuck);
  }
});

test("inside the cooldown a second wedge escalates instead of restarting again", () => {
  const v = submitRecoveryVerdict({ ...WEDGED, sinceLastRecoveryMs: RECOVERY_COOLDOWN_MS - 1 });
  assert.equal(v.action, "escalate");
  assert.equal(submitRecoveryVerdict({ ...WEDGED, sinceLastRecoveryMs: RECOVERY_COOLDOWN_MS }).action, "restart");
});

test("submitRecoveryEnabled: on unless explicitly turned off", () => {
  assert.equal(submitRecoveryEnabled(undefined), true);
  assert.equal(submitRecoveryEnabled("1"), true);
  for (const off of ["0", "false", "off", "no", " OFF "]) assert.equal(submitRecoveryEnabled(off), false, off);
});

// ── the order of operations ───────────────────────────────────────────────

const wedge = () => new SubmitError("submit: the text never appeared in the input box.", "not-typed", null);

/** A fake server: `outcomes` is what each successive submit does. */
function harness(outcomes: (Error | null)[], verdict: SubmitRecoveryVerdict = { action: "restart" }) {
  const calls: string[] = [];
  let n = 0;
  const run = submitWithRecovery({
    submit: async () => {
      calls.push("submit");
      const o = outcomes[n++];
      if (o) throw o;
    },
    assess: () => {
      calls.push("assess");
      return verdict;
    },
    restart: async () => {
      calls.push("restart");
    },
    escalate: (_why, restarted) => {
      calls.push(restarted ? "escalate-after-restart" : "escalate");
    },
  });
  return { run, calls };
}

test("a submit that works touches nothing else", async () => {
  const h = harness([null]);
  await h.run;
  assert.deepEqual(h.calls, ["submit"]);
});

test("a wedge is restarted and the SAME prompt delivered again, once", async () => {
  const h = harness([wedge(), null]);
  await h.run; // resolves: the sender sees a slow answer, not an error
  assert.deepEqual(h.calls, ["submit", "assess", "restart", "submit"]);
});

test("a retry that fails too escalates BEFORE the error says the admins were alerted", async () => {
  const h = harness([wedge(), wedge()]);
  await assert.rejects(h.run, UnresponsiveError);
  assert.deepEqual(h.calls, ["submit", "assess", "restart", "submit", "escalate-after-restart"]);
});

test("never more than one restart and two submits for one prompt", async () => {
  // Every submit fails, for ever: the second failure is not assessed again.
  const h = harness(Array.from({ length: 10 }, wedge));
  await assert.rejects(h.run, UnresponsiveError);
  assert.equal(h.calls.filter((c) => c === "restart").length, 1);
  assert.equal(h.calls.filter((c) => c === "submit").length, 2);
  assert.equal(h.calls.filter((c) => c === "assess").length, 1);
});

test("a restart that throws escalates rather than leaking its own error", async () => {
  const calls: string[] = [];
  const run = submitWithRecovery({
    submit: async () => {
      calls.push("submit");
      throw wedge();
    },
    assess: () => ({ action: "restart" }),
    restart: async () => {
      throw new Error("the TUI never came up");
    },
    escalate: (why, restarted) => {
      calls.push(`escalate:${restarted}:${why}`);
    },
  });
  await assert.rejects(run, UnresponsiveError);
  assert.deepEqual(calls, ["submit", "escalate:true:the TUI never came up"]);
});

test("a failure of another class is rethrown untouched — no restart, no report", async () => {
  const original = new Error("The claude process has exited.");
  const h = harness([original], { action: "none", why: "process exited" });
  await assert.rejects(h.run, (e) => e === original);
  assert.deepEqual(h.calls, ["submit", "assess"]);
});

test("an escalate verdict reports without restarting", async () => {
  const h = harness([wedge()], { action: "escalate", why: "restarted a moment ago" });
  await assert.rejects(h.run, UnresponsiveError);
  assert.deepEqual(h.calls, ["submit", "assess", "escalate"]);
});

// ── what people are told ──────────────────────────────────────────────────

test("the sender is told the truth, not to send it again", () => {
  const e = new UnresponsiveError();
  assert.equal(e.code, UNRESPONSIVE_CODE);
  assert.equal(e.message, UNRESPONSIVE_MESSAGE);
  assert.match(UNRESPONSIVE_MESSAGE, /NOT delivered/);
  assert.match(UNRESPONSIVE_MESSAGE, /will not help/);
  assert.match(UNRESPONSIVE_MESSAGE, /admins have been alerted/);
  assert.doesNotMatch(UNRESPONSIVE_MESSAGE, /(please|try) (send|again)/i);
});

test("the report says what was tried, and a repeat merges into one row", () => {
  assert.match(unresponsiveReportBody("submit: nope.", true), /restarted it automatically/);
  assert.match(unresponsiveReportBody("restarted a moment ago", false), /No automatic restart was attempted/);
  // The constant title is what makes `fileReport` bump instead of pile up.
  const who = { sessionId: "s1", agent: "nightly import" };
  const input = { kind: "bug" as const, title: UNRESPONSIVE_REPORT_TITLE, body: unresponsiveReportBody("x", true) };
  const a = fileReport([], input, who, 1_000);
  const b = fileReport(a.list, input, who, 2_000);
  assert.equal(b.merged, true);
  assert.equal(b.list.length, 1);
  assert.equal(b.report.count, 2);
});

// ── the typed error the pilots throw ──────────────────────────────────────

test("submitFailure carries WHAT failed as data, and keeps the sentence", () => {
  const plain = submitFailure("not-typed", "❯ \n");
  assert.ok(plain instanceof SubmitError);
  assert.equal(plain.failure, "not-typed");
  assert.equal(plain.stuck, null);
  assert.equal(plain.message, "submit: the text never appeared in the input box.");
  const sent = submitFailure("not-sent", "❯ \n");
  assert.equal(sent.failure, "not-sent");
  assert.equal(sent.message, "submit: the prompt does not seem to have been sent.");
});

test("stuckScreenKind and describeStuckScreen recognise the same screens", () => {
  const screens = [
    "Welcome to Claude Code\n",
    "Paste code here > " + "*".repeat(30),
    "Pick one\n❯ 1. Yes\n  2. No\n",
    "❯ \n",
  ];
  for (const s of screens) {
    assert.equal(stuckScreenKind(s) === null, describeStuckScreen(s) === null, s);
  }
  assert.equal(stuckScreenKind(screens[0]), "first-run");
  assert.equal(stuckScreenKind(screens[1]), "masked");
  assert.equal(stuckScreenKind(screens[2]), "question");
  assert.equal(submitFailure("not-typed", screens[2]).stuck, "question");
});
