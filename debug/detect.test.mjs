// Run with: npx tsx --test debug/detect.test.mjs
// Fixture lines captured from real TUI screens (2026-07, Claude Code with
// the "← for agents" footer, which no longer prints "esc to interrupt").
import test from "node:test";
import assert from "node:assert/strict";
import { screenShowsWork } from "../src/detect.ts";

const FOOTER = [
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  02:15:13  elapsed:59m07s  ctx:7%  ~$0,256  5h:19%",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

test("old TUI: spinner with esc-to-interrupt hint", () => {
  const s = "✳ Working… (esc to interrupt)\n" + FOOTER;
  assert.equal(screenShowsWork(s), true);
});

test("new TUI: spinner with elapsed/tokens status line", () => {
  const s =
    "⏺ Skill(superpowers:writing-plans)\n" +
    "  ⎿  Successfully loaded skill\n" +
    "✽ Jitterbugging… (4m 26s · ↓ 7.1k tokens · almost done thinking with high effort)\n" +
    FOOTER;
  assert.equal(screenShowsWork(s), true);
});

test("new TUI: short elapsed, seconds only", () => {
  const s = "✢ Simmering… (3s · ↑ 120 tokens)\n" + FOOTER;
  assert.equal(screenShowsWork(s), true);
});

test("finished turn: past-tense summary line is NOT working", () => {
  const s =
    "  Laquelle ?\n" +
    "✻ Baked for 8m 20s\n" +
    FOOTER;
  assert.equal(screenShowsWork(s), false);
});

test("idle prompt with todo list is NOT working", () => {
  const s =
    "     ✔ Explorer le contexte du projet (session/server/tail)\n" +
    "     ✔ Questions de clarification (une à la fois)\n" +
    "      … +2 completed\n" +
    FOOTER;
  assert.equal(screenShowsWork(s), false);
});

test("subagent completion line (elapsed last) is NOT working", () => {
  const s = "  ⎿  Done (13 tool uses · 58.3k tokens · 5m 40s)\n" + FOOTER;
  assert.equal(screenShowsWork(s), false);
});

test("indented transcript quote of a status line is NOT working", () => {
  const s = "  ✽ Jitterbugging… (4m 26s · ↓ 7.1k tokens)\n" + FOOTER;
  assert.equal(screenShowsWork(s), false);
});
