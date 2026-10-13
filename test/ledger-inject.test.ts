import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  ledgerFileFor,
  deltaSince,
  formatLedgerBlock,
  headline,
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
  assert.match(one, /^⟦ledger · 1 update⟧ /);
  assert.match(one, /• \[a1b2\] fork-follow — resolved \(PR#164\)/);
  // plural + capped: total 3 shown, 2 rows, overflow line
  const many = formatLedgerBlock(
    [
      { id: "b2", entity: "b", status: "open", updatedAt: 1 },
      { entity: "c", status: "open", updatedAt: 1 }, // legacy row, no id → no bracket
    ],
    3,
  );
  assert.match(many, /^⟦ledger · 3 updates⟧/); // header counts the TOTAL
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

/* ---------------------------------------------------------------- *
 * The delta says WHAT happened, not just which row moved.
 * Spec: docs/superpowers/specs/2026-10-13-ledger-kind-and-headline.md
 * ---------------------------------------------------------------- */

test("headline: the note's first sentence, flattened and hard-capped", () => {
  assert.equal(
    headline("Regenerated 09/10; two accounts still need a manual re-run. Pipeline is fine."),
    "Regenerated 09/10; two accounts still need a manual re-run.",
  );
  // a multi-line note is one line in the block
  assert.equal(headline("first line\n   second line"), "first line second line");
  assert.equal(headline(undefined), "");
  assert.equal(headline("   "), "");
});

test("headline: a bare dot is not a sentence boundary — this table is full of versions", () => {
  // "claude-code-2.1.285" and "v0.13.4" are all over the real table; splitting
  // on any period would cut every one of them in half.
  assert.equal(headline("Audited claude-code 2.1.285 with no regression."), "Audited claude-code 2.1.285 with no regression.");
  assert.match(headline("Shipped in v0.13.4. Promotion follows."), /^Shipped in v0\.13\.4\./);
  // …and a boundary that would leave almost nothing is not one
  assert.equal(headline("e.g. the nightly job runs at 03:00"), "e.g. the nightly job runs at 03:00");
});

test("headline: a long sentence is truncated on a word, with an ellipsis", () => {
  const long = "Supersede, not append, so the size of the table is bounded by the number of live topics and never by activity, which is the founding premise.";
  const h = headline(long);
  assert.ok(h.length <= 121, `too long: ${h.length}`); // 120 + the ellipsis
  assert.ok(h.endsWith("…"));
  assert.ok(!h.includes("  ")); // broke on a word, no dangling space
  // an explicit cap is honoured (the recurring per-turn cost is the reason it exists)
  assert.ok(headline(long, 30).length <= 31);
});

test("formatLedgerBlock: a headline per row, and the kind only when it is not a task", () => {
  const block = formatLedgerBlock(
    [
      { id: "0360", entity: "report regeneration", status: "resolved", source: "PR#1203", note: "Done 09/10; two accounts need a manual re-run.", updatedAt: 1 },
      { id: "a1b2", entity: "nightly import window", status: "current", kind: "fact", note: "Runs 03:00-03:40 Europe/Paris.", updatedAt: 1 },
      { id: "c3d4", entity: "supersede, not append", status: "decided", note: "Size stays bounded by live topics.", updatedAt: 1 },
      { id: "e5f6", entity: "no note here", status: "open", updatedAt: 1 },
    ],
    4,
  );
  // the payload used to be the entity LABEL and nothing else
  assert.match(block, /• \[0360\] report regeneration — resolved \(PR#1203\) ↳ Done 09\/10; two accounts need a manual re-run\./);
  // a FACT has no lifecycle and a DECISION is not a phase of one: say so
  assert.ok(block.includes("• [a1b2] nightly import window — current · fact ↳"));
  // `decided` with no stored kind still reads as a decision (nothing was rewritten)
  assert.ok(block.includes("• [c3d4] supersede, not append — decided · decision ↳"));
  // a task carries no tag — it is nearly the whole table, so it would be noise
  assert.ok(block.endsWith("• [e5f6] no note here — open"));
  assert.ok(!block.includes("· task"));
  // a row with no note gets no continuation line
  assert.equal((block.match(/↳/g) || []).length, 3);
});

test("stripLedgerBlock removes the block whole — one-line and historical multi-line alike", () => {
  // The continuation line is indented, not a `• ` bullet. The old strip stopped
  // at the first non-bullet, which would have left every headline sitting in the
  // displayed message — the silent-display class this block exists to avoid.
  const block = formatLedgerBlock(
    [
      { id: "a1b2", entity: "x", status: "resolved", note: "Fixed it. Twice.", updatedAt: 1 },
      { id: "c3d4", entity: "y", status: "current", kind: "fact", note: "Still true.", updatedAt: 1 },
    ],
    2,
  );
  const user = "please ship it";
  const marked = markLedgerBlock(user, block);
  assert.ok(marked.includes("↳ Fixed it.")); // the headline really is in there
  assert.equal(stripLedgerBlock(marked), user); // …and nothing of it survives

  // The block is TYPED into the TUI and read back out of the transcript. Keying
  // the strip on leading spaces would break the day anything on that path
  // trimmed them, leaving the headlines in the chat with nothing to explain it —
  // so the marker is a character and the indentation is only cosmetic.
  const historical = ["⟦ledger · 2 updates since your last message⟧", "• [a1b2] x — resolved", "    ↳ Fixed it.", "• [c3d4] y — current · fact", "    ↳ Still true.", user].join("\n");
  assert.ok(hasLedgerBlock(historical));
  assert.equal(stripLedgerBlock(historical), user);

  // and it still composes with the ⟦platform⟧ header, in the server's own order
  const full = markLedgerBlock(markPromptMeta(user, "⟦web · 2026-10-13 12:09 · admin⟧"), block);
  assert.equal(stripPromptMeta(stripLedgerBlock(full)), user);
});

test("the block is ONE LINE and within budget — a fourth line neutralises the user's message", () => {
  // Not a style rule. `pilot.submit` pastes into the TUI, and Claude Code
  // collapses a paste past a threshold into `<pasted_content>` — material its
  // own system prompt says to act on only where the user's message asks. With a
  // multi-line block the user's message is INSIDE that wrapper and stops being
  // an instruction; an agent answered "I haven't acted on that line" to a direct
  // order. Measured on 486 real prompts: 0 of 324 at ≤3 lines, ~30% of 162 at ≥4.
  // A prompt is ⟦web⟧ + message, so the block gets exactly one line.
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `id0${i}`,
    entity: `a reasonably long entity name number ${i} as they really are`,
    status: "resolved",
    source: "PR#1203",
    note: `Something happened to row ${i} and this sentence describes it at length. A second sentence.`,
    updatedAt: i,
  }));
  for (const n of [1, 2, 3, 5, 8]) {
    const block = formatLedgerBlock(rows.slice(0, n), 20);
    assert.equal(block.split("\n").length, 1, `${n} rows must stay on ONE line`);
    assert.ok(block.length <= 640, `${n} rows: ${block.length} chars is past the ceiling`);
    assert.ok(hasLedgerBlock(block)); // and still detected, so it is still stripped
    assert.equal(stripLedgerBlock(`${block}\n⟦web · x⟧\nhi`), "⟦web · x⟧\nhi");
  }
  // rows that do not fit become the overflow pointer, never a second line
  assert.match(formatLedgerBlock(rows, 20), /\(\+\d+ more — run: ledger list\)$/);
  // a single oversized row is still carried — an empty block would announce a
  // delta and name nothing, which is worse than a long line
  const huge = [{ id: "a1b2", entity: "x".repeat(900), status: "open", updatedAt: 1 }];
  const one = formatLedgerBlock(huge, 1);
  assert.equal(one.split("\n").length, 1);
  assert.ok(one.includes("[a1b2]"));
  assert.ok(one.length <= 640);
});
