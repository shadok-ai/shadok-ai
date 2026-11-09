import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore — plain ESM shared with the browser
import { EMOJI, searchEmoji, looksLikeEmoji } from "../public/emoji-search.js";

test("searchEmoji: a word finds its emoji, exact keyword first", () => {
  assert.equal(searchEmoji("rocket")[0], "🚀");
  assert.equal(searchEmoji("bug")[0], "🐛");
  assert.ok(searchEmoji("money").includes("💰"));
  assert.ok(searchEmoji("lock").includes("🔒"));
  assert.ok(searchEmoji("chart").includes("📊"));
});

test("searchEmoji: case-insensitive and prefix matches", () => {
  assert.ok(searchEmoji("ROCKET").includes("🚀"));
  assert.ok(searchEmoji("roc").includes("🚀"), "a prefix of a keyword still matches");
});

test("searchEmoji: ranking puts an exact keyword ahead of a mere substring", () => {
  // 'fire' is an exact keyword of 🔥; it must beat rows that only contain 'fire'
  // inside a longer word (e.g. 'extinguisher'... fire safety).
  assert.equal(searchEmoji("fire")[0], "🔥");
});

test("searchEmoji: empty / whitespace query returns nothing", () => {
  assert.deepEqual(searchEmoji(""), []);
  assert.deepEqual(searchEmoji("   "), []);
  assert.deepEqual(searchEmoji(null), []);
});

test("searchEmoji: the limit is honoured and results are deduped", () => {
  assert.ok(searchEmoji("a", 3).length <= 3);
  const r = searchEmoji("status");
  assert.equal(r.length, new Set(r).size, "no emoji appears twice");
});

test("looksLikeEmoji: tells a typed emoji from a typed word", () => {
  assert.equal(looksLikeEmoji("🚀"), true);
  assert.equal(looksLikeEmoji("🔥 hot"), true);
  assert.equal(looksLikeEmoji("rocket"), false);
  assert.equal(looksLikeEmoji(""), false);
});

test("the dataset is well-formed: [emoji, keywords] pairs, no mojibake", () => {
  assert.ok(EMOJI.length > 100, "a useful dataset has a few hundred rows");
  for (const row of EMOJI) {
    assert.equal(row.length, 2);
    const [e, kw] = row;
    assert.equal(typeof e, "string");
    assert.ok(e.trim().length > 0, "an emoji must not be blank");
    assert.ok(!e.includes("�"), `mangled emoji in a row: ${JSON.stringify(row)}`);
    assert.equal(typeof kw, "string");
    assert.ok(kw.trim().length > 0, `row ${e} has no keywords`);
    assert.ok(looksLikeEmoji(e), `row key is not an emoji: ${JSON.stringify(row)}`);
  }
});
