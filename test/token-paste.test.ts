import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePastedToken } from "../src/token-paste.js";

const good = "sk-ant-oat01-" + "Ab3_-".repeat(6);

test("trims whitespace and newlines around a long-lived token", () => {
  assert.deepEqual(normalizePastedToken(`  ${good}\n`), { ok: true, token: good });
});

test("refuses empty, prose and an API key", () => {
  for (const raw of ["", "   ", "hello", "sk-ant-api03-" + "x".repeat(40), undefined, 42]) {
    const r = normalizePastedToken(raw);
    assert.equal(r.ok, false);
  }
});

test("the refusal never echoes what was pasted", () => {
  const raw = "sk-ant-api03-SECRETVALUE1234567890";
  const r = normalizePastedToken(raw);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(!r.error.includes("SECRETVALUE"));
    assert.ok(!r.error.includes(raw));
  }
});

test("a token wrapped across lines by a terminal is joined back", () => {
  const half = good.length >> 1;
  assert.deepEqual(normalizePastedToken(good.slice(0, half) + "\n  " + good.slice(half)), { ok: true, token: good });
});
