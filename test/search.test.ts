import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuery, makeSnippet, searchTurns, MIN_QUERY } from "../src/search.js";

test("normalizeQuery trims and collapses whitespace", () => {
  assert.equal(normalizeQuery("  hello   world \n"), "hello world");
  assert.equal(normalizeQuery(""), "");
});

test("makeSnippet: case-insensitive, keeps the match's own casing", () => {
  const s = makeSnippet("The Login Bug is annoying", "login bug");
  assert.ok(s);
  assert.equal(s.match, "Login Bug");
  assert.equal(s.before + s.match + s.after, "The Login Bug is annoying");
});

test("makeSnippet: null when the query is absent", () => {
  assert.equal(makeSnippet("nothing here", "zzz"), null);
});

test("makeSnippet: flattens newlines and trims to a window with ellipses", () => {
  const long = "x".repeat(200) + " NEEDLE\nsecond line " + "y".repeat(200);
  const s = makeSnippet(long, "needle", 20)!;
  assert.equal(s.match, "NEEDLE");
  assert.ok(s.before.startsWith("…"), "left side truncated");
  assert.ok(s.after.endsWith("…"), "right side truncated");
  assert.ok(!/\n/.test(s.before + s.after), "no newlines in the snippet");
  // second line got flattened into the window, not left on its own line
  assert.ok(s.after.includes("second line"));
});

test("searchTurns: newest hit first, capped per agent, ignores too-short queries", () => {
  const turns = [
    { role: "user" as const, text: "first apple", at: 1 },
    { role: "assistant" as const, text: "no fruit here", at: 2 },
    { role: "user" as const, text: "second apple", at: 3 },
    { role: "assistant" as const, text: "third apple", at: 4 },
  ];
  const hits = searchTurns(turns, "apple", 2);
  assert.equal(hits.length, 2, "capped at maxPerAgent");
  assert.deepEqual(hits.map((h) => h.at), [4, 3], "newest first");
  assert.equal(hits[0].role, "assistant");
  assert.equal(searchTurns(turns, "a", 5).length, 0, "single char below MIN_QUERY");
  assert.equal(MIN_QUERY, 2);
});
