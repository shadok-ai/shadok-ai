import assert from "node:assert/strict";
import test from "node:test";
import { extractLiveText } from "../public/live-text.js";

// Shared bottom of screen (separators + input box + footer).
const FOOTER = [
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  00:04:01  elapsed:6h58m51s  ctx:4%  ~$0,123  5h:8%",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

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

test("a continuation stops at the tool result ⎿", () => {
  const screen = [
    "⏺ Text before a tool.",
    "  ⎿  tool output that must not be sucked in",
    "✽ Composing… (1s · esc to interrupt)",
    FOOTER,
  ].join("\n");
  assert.equal(extractLiveText(screen), "Text before a tool.");
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
