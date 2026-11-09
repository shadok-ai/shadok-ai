import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { messageCostUSD, windowStats, MODEL_PRICING, type MsgSample } from "../src/token-stats.js";
import { scanUsageSamples } from "../src/tail.js";

const u = (input: number, output: number, cacheCreation: number, cacheRead: number) => ({
  input,
  output,
  cacheCreation,
  cacheRead,
});

test("messageCostUSD: a known model applies input/output/cache-write/cache-read rates", () => {
  const p = MODEL_PRICING["claude-opus-5"];
  // 1M of each class, so the cost is just the four rates added.
  const cost = messageCostUSD("claude-opus-5", u(1_000_000, 1_000_000, 1_000_000, 1_000_000));
  assert.equal(cost, p.input + p.output + p.cacheWrite + p.cacheRead);
});

test("messageCostUSD: an unknown model (or the synthetic marker) has no price → null", () => {
  assert.equal(messageCostUSD("<synthetic>", u(10, 10, 10, 10)), null);
  assert.equal(messageCostUSD("some-future-model", u(10, 10, 10, 10)), null);
  assert.equal(messageCostUSD("", u(10, 10, 10, 10)), null);
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("windowStats: a message counts in every window wider than its age (nesting)", () => {
  const now = 1_000 * DAY;
  const samples: MsgSample[] = [{ at: now - 30 * MIN, model: "claude-opus-5", usage: u(100, 50, 0, 0) }];
  const w = windowStats(samples, now);
  // 30 min old → in all four.
  for (const k of ["h1", "h24", "d7", "d30"] as const) assert.equal(w[k].output, 50, k);
});

test("windowStats: ages place each message in the right nested windows", () => {
  const now = 1_000 * DAY;
  const samples: MsgSample[] = [
    { at: now - 2 * HOUR, model: "claude-opus-5", usage: u(0, 2, 0, 0) }, // in 24h/7d/30d, not 1h
    { at: now - 3 * DAY, model: "claude-opus-5", usage: u(0, 7, 0, 0) }, // in 7d/30d
    { at: now - 40 * DAY, model: "claude-opus-5", usage: u(0, 99, 0, 0) }, // older than 30d → dropped
    { at: now + HOUR, model: "claude-opus-5", usage: u(0, 5, 0, 0) }, // future (clock skew) → dropped
  ];
  const w = windowStats(samples, now);
  assert.equal(w.h1.output, 0);
  assert.equal(w.h24.output, 2);
  assert.equal(w.d7.output, 9);
  assert.equal(w.d30.output, 9); // 40d and future both excluded
});

test("windowStats: an unknown-priced sample flags costPartial but still counts tokens", () => {
  const now = 1_000 * DAY;
  const samples: MsgSample[] = [
    { at: now - MIN, model: "claude-opus-5", usage: u(1_000_000, 0, 0, 0) },
    { at: now - MIN, model: "<synthetic>", usage: u(500, 0, 0, 0) },
  ];
  const w = windowStats(samples, now);
  assert.equal(w.h1.input, 1_000_500); // tokens from both
  assert.equal(w.h1.costPartial, true); // one had no price
  assert.equal(w.h1.costUSD, MODEL_PRICING["claude-opus-5"].input); // only the priced one summed
});

test("scanUsageSamples: collapses streaming partials per id, earliest ts is upSince", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-stats-"));
  try {
    const file = path.join(tmp, "s.jsonl");
    fs.writeFileSync(
      file,
      [
        // a user prompt sets the floor for "up since"
        JSON.stringify({ type: "user", timestamp: "2026-11-01T08:00:00.000Z", message: { content: "go" } }),
        // same message id written twice (streaming), growing counts: last wins
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-01T08:00:10.000Z",
          message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-01T08:00:11.000Z",
          message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        }),
        // a line with no timestamp still parses but can't anchor a window
        JSON.stringify({
          type: "assistant",
          message: { id: "m2", model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        }),
      ].join("\n"),
    );
    const { samples, firstAt } = scanUsageSamples(file);
    assert.equal(samples.size, 1); // m1 collapsed to one; m2 skipped (no timestamp)
    assert.equal(samples.get("m1")!.usage.output, 40); // final count, not the partial 2
    assert.equal(firstAt, Date.parse("2026-11-01T08:00:00.000Z")); // the user prompt, not the first assistant turn
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
