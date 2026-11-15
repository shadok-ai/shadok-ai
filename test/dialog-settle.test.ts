import assert from "node:assert/strict";
import test from "node:test";
import { idleStep, settleStep, DIALOG_HOLD_MS } from "../src/detect.js";
import { detectDialog, dialogKey } from "../src/extract.js";

// A permission dialog that carries its own countdown, as Claude Code 2.1.300
// rendered it in a real tmux pane (prompt: `rm -rf /nonexistent-cc300-probe-xyz`).
// The dialog lines are verbatim; only the time on the ⚠ line moves, once a
// second, until Claude Code denies the request by itself at 0:00.
function countdownScreen(clock: string): string {
  return [
    "⏺ Bash(rm -rf /nonexistent-cc300-probe-xyz)",
    "",
    "────────────────────────────────────────────────────────────────────────────────",
    " Bash command",
    "",
    "   rm -rf /nonexistent-cc300-probe-xyz",
    "",
    "Dangerous rm operation on critical path: /nonexistent-cc300-probe-xyz",
    `⚠ Claude Code will automatically deny this request in ${clock}, to avoid blocking progress on an unattended`,
    "session",
    "",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "",
    "Esc to cancel · Tab to amend",
  ].join("\n");
}

/** What server.ts passes as `settleOn`: the dialog's dedup identity. */
const keyOf = (screen: string): string | null => {
  const d = detectDialog(screen);
  return d ? dialogKey(d) : null;
};

/** "1:59", "1:58", … — the clock at `ms` into a 120s countdown. */
function clockAt(ms: number): string {
  const left = 120 - Math.floor(ms / 1000);
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

test("countdown fixture: the two screens differ, the dialog does not", () => {
  const a = countdownScreen("1:43");
  const b = countdownScreen("1:42");
  assert.notEqual(a, b, "a byte comparison sees two different screens");
  const { body, ...dialog } = detectDialog(a)!;
  assert.deepEqual(dialog, {
    question: "Do you want to proceed?",
    options: [
      { n: 1, label: "Yes", hint: "" },
      { n: 2, label: "No", hint: "" },
    ],
    multi: false,
  }, "the countdown line stays out of the question");
  // The countdown IS the box's body — the card shows it — and that is exactly
  // why the body must stay out of the key: it ticks, the question does not.
  assert.match(body ?? "", /automatically deny this request in 1:43/);
  assert.equal(keyOf(a), keyOf(b), "the clock is in neither the question nor the labels");
});

test("countdown dialog: idleStep alone never settles, settleStep does", () => {
  // The production wait polls every ~160ms with a 2000ms window. The clock
  // ticks every second, so the screen never holds still for 2000ms — measured
  // on the real pane: longest byte-identical window 678ms.
  let idle = { done: false, stableSince: 0, lastScreen: "" };
  let settle = { done: false, since: 0, lastKey: null as string | null };
  let settledAt = -1;
  for (let t = 0; t < 20_000; t += 160) {
    const screen = countdownScreen(clockAt(t));
    idle = idleStep(screen, idle.lastScreen, idle.stableSince, t, 2000);
    assert.equal(idle.done, false, `byte-stability settled at ${t}ms — the clock should prevent it`);
    if (settledAt < 0) {
      settle = settleStep(screen, keyOf(screen), settle.lastKey, settle.since, t, DIALOG_HOLD_MS);
      if (settle.done) settledAt = t;
    }
  }
  assert.ok(settledAt >= DIALOG_HOLD_MS, `settled on sight (${settledAt}ms) — a half-painted dialog could be read`);
  assert.ok(settledAt < DIALOG_HOLD_MS + 400, `settled late (${settledAt}ms): the human has 120s, not forever`);
});

test("settleStep: never on the first sighting, then once the hold has elapsed", () => {
  const s = countdownScreen("1:59");
  const k = keyOf(s);
  let st = settleStep(s, k, null, 0, 1000, 400);
  assert.equal(st.done, false, "one poll proves nothing about the next");
  assert.equal(st.since, 1000);
  assert.equal(settleStep(s, k, k, 1000, 1399, 400).done, false, "one ms short");
  assert.equal(settleStep(s, k, k, 1000, 1400, 400).done, true, "exactly the hold");
  // Even a zero hold does not settle on a first sighting.
  assert.equal(settleStep(s, k, null, 0, 1000, 0).done, false);
});

test("settleStep: a dialog still being painted restarts the hold", () => {
  // The question is up, the second option has not arrived yet: a different
  // key, so the hold restarts and the half-dialog is never what gets read.
  const half = countdownScreen("1:59").replace("\n  2. No", "");
  const full = countdownScreen("1:58");
  assert.notEqual(keyOf(half), keyOf(full));
  let st = settleStep(half, keyOf(half), null, 0, 0, 400);
  st = settleStep(half, keyOf(half), st.lastKey, st.since, 300, 400);
  st = settleStep(full, keyOf(full), st.lastKey, st.since, 500, 400);
  assert.equal(st.done, false, "the full dialog is a new sighting");
  assert.equal(st.since, 500);
  assert.equal(settleStep(full, keyOf(full), st.lastKey, st.since, 900, 400).done, true);
});

test("settleStep: no dialog, or a working screen, never settles", () => {
  const plain = "❯ \n  ? for shortcuts";
  assert.equal(keyOf(plain), null);
  assert.equal(settleStep(plain, null, null, 0, 60_000, 400).done, false);
  // The work check sits above the caller's reading, as in idleStep: whatever
  // key it hands over, a screen with a live spinner is not a turn boundary.
  const working = countdownScreen("1:30") + "\n✻ Jitterbugging… (4m 26s · ↓ 7.1k tokens)";
  const st = settleStep(working, "some-dialog", "some-dialog", 1000, 61_000, 400);
  assert.equal(st.done, false);
  assert.equal(st.lastKey, null, "and it resets, so the hold restarts from scratch");
});
