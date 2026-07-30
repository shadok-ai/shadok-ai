import assert from "node:assert/strict";
import test from "node:test";
import { screenShowsWork, inputHasProbe, inputText } from "../src/detect.js";

const idle = [
  "⏺ Done.",
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  10:59:45  elapsed:2m  ctx:17%  ~$0,144  5h:5%",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

test("idle input line is not working", () => {
  assert.equal(screenShowsWork(idle), false);
});

test("empty / blank screen is not working", () => {
  assert.equal(screenShowsWork(""), false);
  assert.equal(screenShowsWork("\n\n  \n"), false);
});

test("a live spinner with (elapsed first · …) is working", () => {
  assert.equal(screenShowsWork("✽ Jitterbugging… (4m 26s · ↓ 7.1k tokens · esc to interrupt)"), true);
  assert.equal(screenShowsWork("✶ Gallivanting… (16s · ↓ 136 tokens)"), true);
  assert.equal(screenShowsWork("✻ Crunched… (1h 2m 3s · ↑ 40 tokens)"), true);
});

test("a finished turn (past tense, no parens) is NOT working", () => {
  assert.equal(screenShowsWork("✻ Baked for 8m 20s"), false);
  assert.equal(screenShowsWork("✻ Cooked for 6s"), false);
});

test("a completion line with the elapsed LAST is NOT working", () => {
  assert.equal(screenShowsWork("Done (12 files · 5m 40s)"), false);
});

test("genuine unquoted 'esc to interrupt' status is working", () => {
  assert.equal(screenShowsWork("  · esc to interrupt"), true);
  assert.equal(screenShowsWork("(esc to interrupt)"), true);
});

test("a QUOTED 'esc to interrupt' in prose is NOT working (the self-reference bug)", () => {
  // Claude explaining shadok-ai's own detection must not trip it.
  assert.equal(
    screenShowsWork('la fin de tour est détectée (plus de "esc to interrupt" + écran stable).'),
    false,
  );
  assert.equal(screenShowsWork("uses the “esc to interrupt” marker"), false);
  assert.equal(screenShowsWork("le marqueur « esc to interrupt » a disparu"), false);
});

test("the ctx:/cost footer alone is not working", () => {
  assert.equal(screenShowsWork("  11:08:13  elapsed:34h05m41s  ctx:4%  ~$0,144"), false);
});

test("inputHasProbe: true while typed text sits in the input box", () => {
  const screen = "some history\n\n❯ Refactor the pars\n\n  auto mode on";
  assert.equal(inputHasProbe(screen, "Refactor the par"), true);
});

test("inputHasProbe: false once the box cleared after Enter (even if echo scrolled away)", () => {
  // The prompt was sent; the input box is empty and the echo is gone.
  const cleared = "✻ Baked for 3s\n\n❯ \n\n  auto mode on";
  assert.equal(inputHasProbe(cleared, "Refactor the par"), false);
});

test("inputHasProbe: false when the probe is only in scrollback, not the input line", () => {
  // A fast turn: the echo is still visible above but the box is empty.
  const scrolled = "❯ Refactor the parser now\n⏺ done.\n\n❯ \n";
  assert.equal(inputHasProbe(scrolled, "Refactor the par"), false);
});

test("inputText: reads the ❯ input box and strips the prompt", () => {
  assert.equal(inputText("history\n❯ hello world\n\n  footer"), "hello world");
  assert.equal(inputText("❯ "), "");
});

test("inputText: shell mode — the '!' box padded with a non-breaking space", () => {
  // The TUI pads the shell prompt with U+00A0, not a regular space.
  assert.equal(inputText("────\n!  echo hi\n────\n  ! for shell mode"), "echo hi");
  assert.equal(inputText("! \n────\n  ! for shell mode"), ""); // empty shell box
});
