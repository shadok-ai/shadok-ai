import assert from "node:assert/strict";
import test from "node:test";
import { extractLiveText, livePreviewDecision } from "../public/live-text.js";

// Shared bottom of screen (separators + input box + footer).
const FOOTER = [
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  00:04:01  elapsed:6h58m51s  ctx:4%  ~$0,123  5h:8%",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

// Claude Code renders the assistant block with "⏺" (U+23FA) up to 2.0 and with
// "●" (U+25CF) from 2.1. Both must be recognised: matching only one makes
// extractLiveText return "" on every screen of that version — the web live
// preview and a question's preface simply go dark, with nothing in the DOM and
// nothing in the log. These two tests were deleted by a translation pass, which
// is why CI stayed green while the support was removed.
test("the ● bullet (Claude Code 2.1+) is recognised as a text block", () => {
  const screen = [
    "● An answer being written that wraps across several",
    "  lines folded by the terminal.",
    "✻ Crunched for 2s",
    FOOTER,
  ].join("\n");
  assert.equal(
    extractLiveText(screen),
    "An answer being written that wraps across several lines folded by the terminal.",
  );
});

test("a ● tool_use is not text either (same rule as ⏺)", () => {
  assert.equal(extractLiveText(["● Bash(ls -la)", FOOTER].join("\n")), "");
});

test("single in-flight block: unwraps the continuations", () => {
  const screen = [
    "⏺ Here is an introduction being written that spreads over several",
    "  lines because the terminal wraps them to the width, and the text",
    "  carries on a little further here.",
    "✽ Composing… (4s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(
    extractLiveText(screen),
    "Here is an introduction being written that spreads over several lines because the terminal wraps them to the width, and the text carries on a little further here.",
  );
});

test("multi-block: returns the last text block, not the first", () => {
  const screen = [
    "⏺ First paragraph, already finished.",
    "",
    "  Ran 1 shell command",
    "",
    "⏺ Second paragraph being written right now.",
    "✽ Composing… (2s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "Second paragraph being written right now.");
});

test("in-flight multi-paragraph block: every paragraph (blank-line separated) is captured", () => {
  // A real capture: a long assistant block whose paragraphs are separated by a
  // blank line. Before the fix, extraction stopped at the 1st blank line → only
  // the 1st paragraph showed in the preview, and all the rest appeared "at
  // once" on finalisation (the "weird streaming").
  const screen = [
    "⏺ Done, and the answer to your question changed along the way.",
    "",
    "  Now yes, up to date: local main = origin/main, 0 commits behind.",
    "",
    "  A second paragraph that must show up in the live preview too.",
    "✽ Composing… (3s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  const out = extractLiveText(screen);
  assert.match(out, /Done, and the answer/);
  assert.match(out, /Now yes, up to date/);
  assert.match(out, /A second paragraph/);
});

test("an indented tool summary after a blank line is NOT sucked into the text", () => {
  const screen = [
    "⏺ A finished paragraph of text.",
    "",
    "  Ran 1 shell command",
    "✽ Running… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "A finished paragraph of text.");
});

test('the last ⏺ is a tool_use → ""', () => {
  const screen = [
    "⏺ A first paragraph of text.",
    "",
    "⏺ Bash(echo A)",
    "  ⎿  A",
    "✽ Running… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test('no ⏺ at all → ""', () => {
  const screen = ["❯ a pending prompt", FOOTER].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test('the last ⏺ is a running tool ("Running…") → ""', () => {
  const screen = [
    "⏺ A paragraph of text already written.",
    "",
    "⏺ Running 1 shell command",
    "✽ Running… (2s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test('the last ⏺ is a finished tool ("Ran…") → ""', () => {
  const screen = ["⏺ Ran 1 shell command", FOOTER].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test("a bulleted line whose first detail is a ⎿ is a running tool's status, not text", () => {
  // Real capture: Claude Code renders a running bash as "● Sleeping for 6
  // seconds\n  ⎿ $ sleep 6" and flips the leading bullet on and off between
  // redraws. It must read as a tool (→ "") so the preview holds the real block
  // above, instead of oscillating onto the status line (or gluing it on).
  const screen = [
    "● Sleeping for 6 seconds",
    "  ⎿  $ sleep 6",
    "✽ Composing… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "");
});

test("long-task frames: the tool status never oscillates into (or onto) the real block", () => {
  // The exact two redraws that flickered: a git sentence, then a `sleep 6` whose
  // status shows sometimes WITH a "●" bullet, sometimes indented under the text.
  const withBullet = [
    "● AAA: Git is a distributed version control system that tracks changes",
    "  of a project's history.",
    "● Sleeping for 6 seconds",
    "  ⎿  $ sleep 6",
    "· Boondoggling… (2s · ↓ 33 tokens)",
    FOOTER,
  ].join("\n");
  const indented = [
    "● AAA: Git is a distributed version control system that tracks changes",
    "  of a project's history.",
    "  Sleeping for 6 seconds",
    "  ⎿  $ sleep 6",
    "✽ Boondoggling… (3s · ↓ 45 tokens)",
    FOOTER,
  ].join("\n");
  // Bullet frame → the last block is the tool status → "" (keep what's shown).
  assert.equal(extractLiveText(withBullet), "");
  // Indented frame → the real block, WITHOUT the tool status glued to its end.
  assert.equal(
    extractLiveText(indented),
    "AAA: Git is a distributed version control system that tracks changes of a project's history.",
  );
});

test("a real dialog screen: the paragraph preceding the question is recovered", () => {
  // A real capture of the TUI pane while an AskUserQuestion was displayed — the
  // case the Telegram bridge must be able to extract (spec of 2026-07-28).
  const screen = [
    "⏺ Option A. I am looking at the files involved before writing anything at all.",
    "",
    "  Searched for 1 pattern, read 1 file, ran 1 shell command",
    "",
    "⏺ This paragraph is here to act as the test's preface text: a capture of the TUI screen fires",
    "  in 25 seconds, while the question below is displayed. Answer whatever you like, only the",
    "  capture is of interest to me.",
    "",
    "❯ /login",
    "────────────────────────────────────────────",
    " ☐ Capture",
    "",
    "Capture in progress — answer anything after ~30 s.",
    "",
    "❯ 1. OK",
    "     Let ~30 seconds pass before clicking.",
    "  2. Cancel",
    "     Stop the capture test.",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  assert.equal(
    extractLiveText(screen),
    "This paragraph is here to act as the test's preface text: a capture of the TUI screen fires " +
      "in 25 seconds, while the question below is displayed. Answer whatever you like, only the " +
      "capture is of interest to me.",
  );
});

// ── livePreviewDecision (anti-flicker) ─────────────────────────────────────

test("livePreviewDecision: baseline before anything shown → clear (suppress the old answer)", () => {
  assert.equal(livePreviewDecision({ isBaseline: true, isFinalized: false, showing: false }), "clear");
});

test("livePreviewDecision: baseline AFTER new text shown → keep (hold, don't flip back)", () => {
  assert.equal(livePreviewDecision({ isBaseline: true, isFinalized: false, showing: true }), "keep");
});

test("livePreviewDecision: an already-finalized block → clear", () => {
  assert.equal(livePreviewDecision({ isBaseline: false, isFinalized: true, showing: true }), "clear");
});

test("livePreviewDecision: fresh in-flight text → show", () => {
  assert.equal(livePreviewDecision({ isBaseline: false, isFinalized: false, showing: false }), "show");
});

test("livePreviewDecision: the new↔old oscillation never flips back to the old text", () => {
  // Simulate the frames while the model writes: the baseline (previous answer)
  // keeps re-appearing between frames of new text. Once new text is showing, a
  // baseline frame must be HELD — the bug was it flipped back to the old text.
  let showing = false;
  const frames = [
    { isBaseline: true, isFinalized: false },   // turn start: old answer on screen
    { isBaseline: false, isFinalized: false },  // model starts writing
    { isBaseline: true, isFinalized: false },   // redraw glitch: old block last again
    { isBaseline: false, isFinalized: false },  // more new text
    { isBaseline: true, isFinalized: false },   // another glitch
  ];
  const seen: string[] = [];
  for (const f of frames) {
    const d = livePreviewDecision({ ...f, showing });
    seen.push(d);
    if (d === "show") showing = true;
    if (d === "clear") showing = false;
    // "keep" leaves `showing` as is
  }
  assert.deepEqual(seen, ["clear", "show", "keep", "show", "keep"]);
  // After the first "show", the preview is never cleared/flipped by a baseline
  // frame — no oscillation.
  assert.ok(!seen.slice(seen.indexOf("show") + 1).includes("clear"));
});
