import assert from "node:assert/strict";
import test from "node:test";
import { claudeUpdateState } from "../public/update-ready.js";

// Both footers are captured from the real TUI (the user's screenshots).

test("'Update installed · Restart to apply' → restart", () => {
  const screen = [
    "  some conversation …",
    "",
    "  ✓ Update installed · Restart to apply",
    "  new task? /clear to save 377.7k tokens",
  ].join("\n");
  assert.equal(claudeUpdateState(screen), "restart");
});

test("'Auto-update failed · Try … npm i -g …' → failed", () => {
  const screen = "  ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code";
  assert.equal(claudeUpdateState(screen), "failed");
});

test("failed wins over restart when both wordings somehow co-occur", () => {
  // "failed" is the more urgent, more specific line; it is checked first.
  assert.equal(claudeUpdateState("Auto-update failed · Restart to apply"), "failed");
});

test("case-insensitive", () => {
  assert.equal(claudeUpdateState("… restart to apply …"), "restart");
  assert.equal(claudeUpdateState("… AUTO-UPDATE FAILED …"), "failed");
});

test("an ordinary screen has no update state", () => {
  assert.equal(claudeUpdateState("esc to interrupt · 12k tokens"), null);
  assert.equal(claudeUpdateState("Restarting the service tomorrow"), null); // no "to apply"
});

test("a mere 'update available' (nothing installed/failed) is not actionable", () => {
  assert.equal(claudeUpdateState("⧉ update available (2.1.280)"), null);
});

test("only the FOOTER counts — an agent that merely says the phrase up-screen doesn't trip it", () => {
  // The words appear in the answer, scrolled up; the real footer below is idle.
  const lines = [
    "Sure — after an update Claude Code asks you to Restart to apply it.",
    ...Array.from({ length: 12 }, (_, i) => `line ${i}`),
    "  esc to interrupt",
    "  > ",
  ];
  assert.equal(claudeUpdateState(lines.join("\n")), null);
});

test("the footer in the tail IS detected even under a tall screen", () => {
  const lines = [
    ...Array.from({ length: 20 }, (_, i) => `body line ${i}`),
    "  ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code",
    "  > ",
  ];
  assert.equal(claudeUpdateState(lines.join("\n")), "failed");
});

test("empty / non-string input is safe", () => {
  assert.equal(claudeUpdateState(""), null);
  assert.equal(claudeUpdateState(undefined as unknown as string), null);
  assert.equal(claudeUpdateState(null as unknown as string), null);
});
