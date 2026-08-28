import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  ledgerFileFor,
  deltaSince,
  formatLedgerBlock,
  markLedgerBlock,
  hasLedgerBlock,
  stripLedgerBlock,
  mintLedgerId,
} from "../src/ledger.js";
import { stripPromptMeta, markPromptMeta } from "../src/promptmeta.js";
import { markCronPrompt, isCronPrompt } from "../src/crons.js";

test("ledgerFileFor: per-instance path under ~/.shadok-ai/ledger/<enc>.json", () => {
  const f = ledgerFileFor("/home/x/proj");
  assert.equal(f, path.join(os.homedir(), ".shadok-ai", "ledger", "-home-x-proj.json"));
  // distinct launch dirs → distinct files (the whole point of "per instance")
  assert.notEqual(ledgerFileFor("/a"), ledgerFileFor("/b"));
});

test("deltaSince: only rows newer than the watermark, newest-first, capped", () => {
  const rows = [
    { id: "a1", entity: "a", status: "open", updatedAt: 100 },
    { id: "b2", entity: "b", status: "resolved", updatedAt: 300 },
    { id: "c3", entity: "c", status: "decided", updatedAt: 200 },
  ];
  const d = deltaSince(rows, 150, 10);
  assert.deepEqual(d.rows.map((r) => r.entity), ["b", "c"]); // 300, 200 — not 100
  assert.equal(d.total, 2);
  // nothing newer than the watermark → empty
  assert.deepEqual(deltaSince(rows, 9999, 10).rows, []);
  // cap limits rows but total still counts everything changed
  const capped = deltaSince(rows, 0, 2);
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.total, 3);
});

test("formatLedgerBlock: English header, [id] handles, singular/plural, overflow", () => {
  const one = formatLedgerBlock(
    [{ id: "a1b2", entity: "fork-follow", status: "resolved", source: "PR#164", updatedAt: 1 }],
    1,
  );
  assert.match(one, /^⟦ledger · 1 update since your last message⟧$/m);
  assert.match(one, /• \[a1b2\] fork-follow — resolved \(PR#164\)/);
  // plural + capped: total 3 shown, 2 rows, overflow line
  const many = formatLedgerBlock(
    [
      { id: "b2", entity: "b", status: "open", updatedAt: 1 },
      { entity: "c", status: "open", updatedAt: 1 }, // legacy row, no id → no bracket
    ],
    3,
  );
  assert.match(many, /3 updates since your last message/); // header counts the TOTAL
  assert.match(many, /• c — open/); // id-less row degrades gracefully
  assert.match(many, /\+1 more/); // 3 total − 2 shown
});

test("hasLedgerBlock / stripLedgerBlock: removes header + its bullet lines only", () => {
  const block = formatLedgerBlock(
    [{ id: "a1b2", entity: "x", status: "resolved", updatedAt: 1 }],
    1,
  );
  const user = "please ship it";
  const marked = markLedgerBlock(user, block);
  assert.ok(hasLedgerBlock(marked));
  assert.equal(stripLedgerBlock(marked), user);
  // a plain message is untouched, and is not falsely detected
  assert.equal(hasLedgerBlock(user), false);
  assert.equal(stripLedgerBlock(user), user);
});

test("strip composes with promptMeta: ledger block, then the ⟦platform⟧ header", () => {
  const block = formatLedgerBlock([{ id: "a1b2", entity: "x", status: "resolved", updatedAt: 1 }], 1);
  const user = "hello";
  // real order the server builds: ledger block wraps the promptMeta-marked text
  const withMeta = markPromptMeta(user, "⟦web · 2026-08-28 10:07⟧");
  const full = markLedgerBlock(withMeta, block);
  // display strips the ledger block first, then the platform header
  assert.equal(stripPromptMeta(stripLedgerBlock(full)), user);
});

test("mintLedgerId: 4 hex chars, avoids collisions with taken ids", () => {
  const id = mintLedgerId(new Set(["a1b2"]));
  assert.match(id, /^[0-9a-f]{4}$/);
  assert.notEqual(id, "a1b2");
});

test("a cron prompt carrying a ledger block stays hidden — strip before classify", () => {
  const block = formatLedgerBlock([{ id: "a1b2", entity: "x", status: "resolved", updatedAt: 1 }], 1);
  const cron = markCronPrompt("check the nightly export");
  const withBlock = markLedgerBlock(cron, block);
  // With the block in front, the cron mark is no longer first — a naive check misses it…
  assert.equal(isCronPrompt(withBlock), false);
  // …so loadHistory strips the ledger block FIRST, which restores recognition
  // (the prompt stays hidden) — the exact ordering the extract fix depends on.
  assert.equal(isCronPrompt(stripLedgerBlock(withBlock)), true);
});
