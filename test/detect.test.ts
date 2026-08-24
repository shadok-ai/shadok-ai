import assert from "node:assert/strict";
import test from "node:test";
import { idleStep, screenShowsWork, inputHasProbe, inputText, nextScreenDelay, SCREEN_FAST_MS, SCREEN_SLOW_MS } from "../src/detect.js";

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
    screenShowsWork('the end of a turn is detected (no more "esc to interrupt" + a stable screen).'),
    false,
  );
  assert.equal(screenShowsWork("uses the “esc to interrupt” marker"), false);
  assert.equal(screenShowsWork("the 'esc to interrupt' marker is gone"), false);
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

// ── idleStep: when is a turn over? ──────────────────────────────────────────

const WORKING = "✻ Jitterbugging… (4m 26s · ↓ 7.1k tokens)";
const IDLE = "❯ \n  ? for shortcuts";

test("idleStep: a screen that keeps changing never settles", () => {
  let st = { stableSince: 0, lastScreen: "" };
  for (let t = 0; t < 10_000; t += 160) {
    st = idleStep(IDLE + t, st.lastScreen, st.stableSince, t, 2000);
    assert.equal(st.done, false, `settled at ${t}ms on a moving screen`);
  }
});

test("idleStep: settles only once the window has fully elapsed", () => {
  // First sighting starts the clock but never settles on the spot.
  let st = idleStep(IDLE, IDLE, 0, 1000, 2000);
  assert.equal(st.done, false);
  assert.equal(st.stableSince, 1000, "the clock starts at the first stable poll");
  assert.equal(idleStep(IDLE, IDLE, 1000, 2999, 2000).done, false, "one ms short is not settled");
  assert.equal(idleStep(IDLE, IDLE, 1000, 3000, 2000).done, true, "exactly the window settles");
});

test("idleStep: a working screen never settles, however still it is", () => {
  // Byte-identical for a minute, but the spinner says otherwise.
  assert.equal(idleStep(WORKING, WORKING, 1000, 61_000, 2000).done, false);
  // …and it resets the clock, so calm afterwards is measured from scratch.
  assert.equal(idleStep(WORKING, WORKING, 1000, 61_000, 2000).stableSince, 0);
});

test("idleStep: a shorter window settles sooner, on the same screen", () => {
  // The point of the interrupt path: same evidence, lower bar. 400ms is enough
  // once the user has explicitly asked the turn to stop.
  assert.equal(idleStep(IDLE, IDLE, 1000, 1400, 2000).done, false, "the normal window still waits");
  assert.equal(idleStep(IDLE, IDLE, 1000, 1400, 400).done, true, "the short window is done");
  // But a shorter window must NOT excuse a screen that is still working.
  assert.equal(idleStep(WORKING, WORKING, 1000, 61_000, 400).done, false);
});

test("nextScreenDelay: a moving screen is polled fast", () => {
  assert.equal(nextScreenDelay(0, false), SCREEN_FAST_MS);
  assert.equal(nextScreenDelay(2, false), SCREEN_FAST_MS);
});

test("nextScreenDelay: stillness backs off, and is capped", () => {
  // Geometric, so a session that has been quiet for hours costs almost nothing,
  // while one that just went quiet is still nearly live.
  assert.equal(nextScreenDelay(3, false), 600);
  assert.equal(nextScreenDelay(4, false), 1200);
  assert.equal(nextScreenDelay(5, false), SCREEN_SLOW_MS);
  assert.equal(nextScreenDelay(500, false), SCREEN_SLOW_MS);
});

test("nextScreenDelay: a busy session is never slowed", () => {
  // A running turn is when the screen moves most — and there are only ever a
  // handful of busy sessions, so the cost stays bounded.
  assert.equal(nextScreenDelay(999, true), SCREEN_FAST_MS);
});

test("nextScreenDelay: the delay never shrinks as stillness grows", () => {
  let prev = 0;
  for (let n = 0; n <= 12; n++) {
    const d = nextScreenDelay(n, false);
    assert.ok(d >= prev, `streak ${n}: ${d} < ${prev}`);
    assert.ok(d >= SCREEN_FAST_MS && d <= SCREEN_SLOW_MS);
    prev = d;
  }
});
