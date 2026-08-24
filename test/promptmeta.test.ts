import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWhen,
  promptMetaHeader,
  hasPromptMeta,
  markPromptMeta,
  stripPromptMeta,
} from "../src/promptmeta.js";

const AT = new Date("2026-08-25T14:30:00Z");

test("formatWhen: ISO-like in a given zone", () => {
  assert.equal(formatWhen(AT, "UTC"), "2026-08-25 14:30");
  assert.equal(formatWhen(AT, "Europe/Paris"), "2026-08-25 16:30"); // +2 in August
});

test("promptMetaHeader: platform + time, and who when given", () => {
  assert.equal(promptMetaHeader("web", AT, undefined, "UTC"), "⟦web · 2026-08-25 14:30⟧");
  assert.equal(promptMetaHeader("telegram", AT, "Alex", "UTC"), "⟦telegram · 2026-08-25 14:30 · Alex⟧");
  assert.equal(promptMetaHeader("", AT, "  ", "UTC"), "⟦web · 2026-08-25 14:30⟧"); // empties default/dropped
});

test("markPromptMeta: prepends the header as its own line, idempotent", () => {
  const h = promptMetaHeader("web", AT, undefined, "UTC");
  assert.equal(markPromptMeta("do the thing", h), "⟦web · 2026-08-25 14:30⟧\ndo the thing");
  // Re-marking an already-marked message does nothing.
  assert.equal(markPromptMeta(markPromptMeta("x", h), h), "⟦web · 2026-08-25 14:30⟧\nx");
});

test("stripPromptMeta: removes only the header line", () => {
  assert.equal(stripPromptMeta("⟦web · 2026-08-25 14:30⟧\nhello\nworld"), "hello\nworld");
  assert.equal(stripPromptMeta("⟦telegram · 2026-08-25 14:30 · Alex⟧\nhi"), "hi");
});

test("stripPromptMeta: leaves an ordinary message untouched", () => {
  assert.equal(stripPromptMeta("just a message"), "just a message");
  // A lone bracket line without the ' · ' separator is NOT a header.
  assert.equal(stripPromptMeta("⟦important⟧\ntext"), "⟦important⟧\ntext");
  // Brackets mid-message never strip.
  assert.equal(stripPromptMeta("see ⟦web · x⟧ below"), "see ⟦web · x⟧ below");
});

test("hasPromptMeta: strict — the header must open the message", () => {
  assert.equal(hasPromptMeta("⟦web · 2026-08-25 14:30⟧\nx"), true);
  assert.equal(hasPromptMeta("hi\n⟦web · x⟧"), false);
  assert.equal(hasPromptMeta("⟦no separator⟧\nx"), false);
});
