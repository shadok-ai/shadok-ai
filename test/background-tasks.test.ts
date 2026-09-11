import assert from "node:assert/strict";
import test from "node:test";
import { backgroundTasks } from "../src/detect.js";

const footer = (segment: string) => [
  "  Done.",
  "╭──────────────────────────────────╮",
  "│ >                                │",
  "╰──────────────────────────────────╯",
  "  ⏵⏵ auto mode on" + segment + " · ← for agents",
].join("\n");

test("a shell alone", () => {
  assert.deepEqual(backgroundTasks(footer(" · 1 shell ·")), { shells: 1, monitors: 0 });
});

test("a monitor alone", () => {
  assert.deepEqual(backgroundTasks(footer(" · 1 monitor ·")), { shells: 0, monitors: 1 });
});

test("BOTH share one segment, comma-separated — the real footer", () => {
  // Captured live: "⏵⏵ auto mode on · 1 shell, 1 monitor · esc to interrupt · …"
  // The monitor sits after a comma, not after a separator: a rule anchored on a
  // leading "·" alone would see the shell and miss the monitor entirely.
  assert.deepEqual(backgroundTasks(footer(" · 1 shell, 1 monitor ·")), { shells: 1, monitors: 1 });
  assert.deepEqual(backgroundTasks(footer(" · 3 shells, 2 monitors ·")), { shells: 3, monitors: 2 });
});

test("nothing running", () => {
  assert.deepEqual(backgroundTasks(footer("")), { shells: 0, monitors: 0 });
  assert.deepEqual(backgroundTasks(""), { shells: 0, monitors: 0 });
});

test("the segment may end the line", () => {
  assert.deepEqual(backgroundTasks("  ⏵⏵ accept edits on · 2 shells"), { shells: 2, monitors: 0 });
});

test("prose is refused: the WHOLE segment must be the list", () => {
  // Invariant 2's family. A segment carrying anything else is not a count — it
  // is an agent talking about its own work, and must not move an indicator.
  const chatty = [
    "  I launched 2 shells · and 1 monitor · to watch the build",
    "  ⏵⏵ auto mode on · ← for agents",
  ].join("\n");
  assert.deepEqual(backgroundTasks(chatty), { shells: 0, monitors: 0 });
  assert.deepEqual(backgroundTasks("  ⏵⏵ on · about 2 shells here · x"), { shells: 0, monitors: 0 });
});

test("only the footer region is read, never the scrollback", () => {
  const scrolled = ["  ⏵⏵ auto mode on · 4 shells, 9 monitors · ↓ to manage",
    ...Array(20).fill("  output line"),
    "  ⏵⏵ auto mode on · ← for agents"].join("\n");
  assert.deepEqual(backgroundTasks(scrolled), { shells: 0, monitors: 0 });
});

test("blank lines below the footer do not hide it", () => {
  assert.deepEqual(backgroundTasks("  ⏵⏵ auto mode on · 1 shell, 1 monitor · x\n\n\n"),
    { shells: 1, monitors: 1 });
});
