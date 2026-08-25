import assert from "node:assert/strict";
import test from "node:test";
// The skill is the single source of the logic; the repo suite tests it directly.
import {
  normEntity,
  upsertEntry,
  findEntries,
  ageDays,
} from "../context/ledger-skill/ledger-core.mjs";

test("upsert SUPERSEDES by normalised entity — never a twin", () => {
  let rows: any[] = [];
  rows = upsertEntry(rows, { entity: "Nightly import", status: "broken" }, 1000);
  rows = upsertEntry(rows, { entity: "  nightly   IMPORT ", status: "fixed", source: "PR#12" }, 2000);
  assert.equal(rows.length, 1); // state table, not a log
  assert.equal(rows[0].status, "fixed");
  assert.equal(rows[0].source, "PR#12");
  assert.equal(rows[0].updatedAt, 2000);
});

test("upsert requires an entity", () => {
  assert.throws(() => upsertEntry([], { entity: "  ", status: "x" }, 1));
});

test("find matches entity OR note, most-recent first", () => {
  const rows = [
    { entity: "landing page rework", status: "paused", updatedAt: 10 },
    { entity: "nightly import", status: "fixed", note: "restarted the job", updatedAt: 30 },
    { entity: "staging budget", status: "learned", updatedAt: 20 },
  ];
  assert.deepEqual(findEntries(rows, "import").map((e: any) => e.entity), ["nightly import"]);
  assert.deepEqual(findEntries(rows, "restarted").map((e: any) => e.entity), ["nightly import"]); // note match
});

test("empty query lists the whole table, recent-first", () => {
  const rows = [
    { entity: "a", status: "x", updatedAt: 10 },
    { entity: "b", status: "y", updatedAt: 30 },
    { entity: "c", status: "z", updatedAt: 20 },
  ];
  assert.deepEqual(findEntries(rows, "").map((e: any) => e.entity), ["b", "c", "a"]);
});

test("normEntity collapses case and whitespace", () => {
  assert.equal(normEntity("  Nightly   IMPORT "), "nightly import");
});

test("ageDays is whole days since updatedAt", () => {
  assert.equal(ageDays({ updatedAt: 0 }, 3 * 86_400_000 + 5), 3);
  assert.equal(ageDays({ updatedAt: 100 }, 100), 0);
});
