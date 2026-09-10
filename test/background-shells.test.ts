import assert from "node:assert/strict";
import test from "node:test";
import { backgroundShells } from "../src/detect.js";

/** A real footer, as Claude Code draws it when a background shell is alive. */
const withShell = [
  "  Dès que les trois cas sont ingérés, je lance la v3.",
  "✱ Sautéed for 3m 25s · done 10:55 PM · 1 shell still running",
  "╭──────────────────────────────────────────╮",
  "│ > ok tiens moi au courant                │",
  "╰──────────────────────────────────────────╯",
  "  ▶▶ auto mode on · 1 shell · ← for agents · ↓ to manage",
].join("\n");

/** The same cockpit with nothing running — the segment simply is not there. */
const idle = [
  "  Done.",
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
  "  auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

test("reads the count from the footer", () => {
  assert.equal(backgroundShells(withShell), 1);
});

test("no shell segment → zero", () => {
  assert.equal(backgroundShells(idle), 0);
  assert.equal(backgroundShells(""), 0);
});

test("plural, and more than one", () => {
  assert.equal(backgroundShells("  ▶▶ auto mode on · 3 shells · ← for agents · ↓ to manage"), 3);
});

test("the segment may end the line, with no trailing separator", () => {
  assert.equal(backgroundShells("  ▶▶ accept edits on · 2 shells"), 2);
});

test("prose that mentions shells does NOT count — the separator is required", () => {
  // Invariant 2's family: a quoted "esc to interrupt" once wedged a session as
  // busy. An agent explaining its own work must never move an indicator.
  const chatty = [
    "  I launched 2 shells in the background to watch the build.",
    "  Ran 6 shell commands",
    "╭────────────────────────╮",
    "│ >                      │",
    "╰────────────────────────╯",
    "  auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");
  assert.equal(backgroundShells(chatty), 0);
});

test("only the footer region is read, never the scrollback", () => {
  // The same footer text, but far above: it is history, not the live status.
  const scrolled = ["  ▶▶ auto mode on · 4 shells · ↓ to manage", ...Array(20).fill("  output line"),
    "  auto mode on (shift+tab to cycle) · ← for agents"].join("\n");
  assert.equal(backgroundShells(scrolled), 0);
});

test("blank lines below the footer do not hide it", () => {
  assert.equal(backgroundShells("  ▶▶ auto mode on · 1 shell · ↓ to manage\n\n\n"), 1);
});
