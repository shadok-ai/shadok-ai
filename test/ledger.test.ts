import assert from "node:assert/strict";
import test from "node:test";
// The skill is the single source of the logic; the repo suite tests it directly.
import {
  normEntity,
  upsertEntry,
  findEntries,
  ageDays,
  resolveId,
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

test("a new row keeps the id it was minted with; supersede PRESERVES it", () => {
  let rows: any[] = upsertEntry([], { entity: "Nightly import", status: "broken" }, 1000, "a1b2");
  assert.equal(rows[0].id, "a1b2");
  // superseding by name must keep the SAME id — it is a durable handle
  rows = upsertEntry(rows, { entity: "nightly import", status: "fixed" }, 2000, "zzzz");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "a1b2"); // NOT the freshly-minted "zzzz"
  assert.equal(rows[0].status, "fixed");
});

test("update BY ID changes fields in place, keeps entity + id, no twin", () => {
  let rows: any[] = upsertEntry([], { entity: "fork-follow (context overflow)", status: "in-progress" }, 1000, "a1b2");
  rows = upsertEntry(rows, { id: "a1b2", status: "resolved", note: "merged" }, 2000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity, "fork-follow (context overflow)"); // untouched
  assert.equal(rows[0].id, "a1b2");
  assert.equal(rows[0].status, "resolved");
  assert.equal(rows[0].note, "merged");
  assert.equal(rows[0].updatedAt, 2000);
});

test("update by an UNKNOWN id throws — never silently creates a row", () => {
  const rows = upsertEntry([], { entity: "x", status: "open" }, 1000, "a1b2");
  assert.throws(() => upsertEntry(rows, { id: "ffff", status: "resolved" }, 2000));
});

test("resolveId: exact, unique prefix, else null (empty / ambiguous / none)", () => {
  const rows = [
    { id: "a1b2", entity: "x", status: "open", updatedAt: 1 },
    { id: "a1c9", entity: "y", status: "open", updatedAt: 1 },
    { id: "d4e5", entity: "z", status: "open", updatedAt: 1 },
  ];
  assert.equal(resolveId(rows, "a1b2")?.entity, "x"); // exact
  assert.equal(resolveId(rows, "d4")?.entity, "z"); // unique prefix
  assert.equal(resolveId(rows, "a1"), null); // ambiguous
  assert.equal(resolveId(rows, ""), null); // empty
  assert.equal(resolveId(rows, "zzzz"), null); // no match
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
