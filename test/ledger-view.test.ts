import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error — plain ESM served to the browser, no types
import { ldgNorm, ledgerHaystack, ledgerAge, ledgerFacets, filterLedger, LEDGER_AGES, LEDGER_SORTS } from "../public/ledger-view.js";

const DAY = 86400000;
const NOW = new Date("2026-10-14T12:00:00Z").getTime();
const daysAgo = (n: number) => NOW - n * DAY;

const rows = [
  { id: "a1b2", entity: "logo hôpital sur la page partenaires", status: "resolved", note: "Corrigé en production.", source: "PR#12", updatedAt: daysAgo(0) },
  { id: "c3d4", entity: "nightly import window", status: "current", kind: "fact", note: "Runs 03:00-03:40 Europe/Paris.", updatedAt: daysAgo(2), verifiedAt: daysAgo(40) },
  { id: "e5f6", entity: "indexing backlog", status: "in-progress", note: "36 of 120 documents indexed.", source: "cron a92f", updatedAt: daysAgo(5) },
  { id: "7890", entity: "supersede, not append", status: "decided", kind: "decision", note: "Size stays bounded by live topics.", updatedAt: daysAgo(60) },
  { id: "beef", entity: "cron guard news lost on a failed delivery", status: "open", note: "The guard advances before the wake.", updatedAt: daysAgo(9) },
];

test("search is case- AND accent-insensitive — a sibling instance's rows are French", () => {
  // `hopital` must find `hôpital`, or the box is a trap for exactly the people
  // whose rows need it most.
  assert.equal(ldgNorm("Hôpital ÉTÉ"), "hopital ete");
  assert.equal(filterLedger(rows, { text: "hopital" }, NOW).length, 1);
  assert.equal(filterLedger(rows, { text: "HÔPITAL" }, NOW).length, 1);
});

test("a row is findable by its id — that is the handle the block and the CLI print", () => {
  assert.ok(ledgerHaystack(rows[0]).includes("a1b2"));
  assert.deepEqual(filterLedger(rows, { text: "beef" }, NOW).map((r: any) => r.id), ["beef"]);
});

test("every term must match: typing more words narrows", () => {
  assert.equal(filterLedger(rows, { text: "cron" }, NOW).length, 2); // the guard row + the row whose source is a cron
  assert.equal(filterLedger(rows, { text: "cron guard" }, NOW).length, 1);
  assert.equal(filterLedger(rows, { text: "cron unicorn" }, NOW).length, 0);
});

test("the note and the source are searchable, not just the label", () => {
  assert.deepEqual(filterLedger(rows, { text: "120 documents" }, NOW).map((r: any) => r.id), ["e5f6"]);
  assert.deepEqual(filterLedger(rows, { text: "PR#12" }, NOW).map((r: any) => r.id), ["a1b2"]);
});

test("an empty selection means NO constraint, never 'nothing'", () => {
  // A filter bar that can be driven into an empty list by doing nothing is a
  // bug report waiting to happen.
  assert.equal(filterLedger(rows, {}, NOW).length, rows.length);
  assert.equal(filterLedger(rows, { status: [], kind: [], text: "  " }, NOW).length, rows.length);
});

test("age reads verifiedAt before updatedAt — an edit is not an observation", () => {
  // The fact row was REWORDED two days ago and last CONFIRMED forty days ago.
  // Reading `updatedAt` would call it fresh, which is the lie the two clocks
  // exist to remove, and the one the whole hedge rests on.
  assert.equal(ledgerAge(rows[1], NOW), 40);
  assert.equal(ledgerAge(rows[0], NOW), 0);
  assert.equal(ledgerAge({ entity: "x", status: "open" } as any, NOW), null);
  const stale = filterLedger(rows, { age: "stale" }, NOW).map((r: any) => r.id);
  assert.deepEqual(stale.sort(), ["7890", "c3d4"], "the reworded fact must count as stale");
});

test("an age window never silently drops a row that has no date at all", () => {
  const undated = { id: "0000", entity: "no clock", status: "open" };
  for (const a of LEDGER_AGES) {
    assert.ok(
      filterLedger([...rows, undated], { age: a.value }, NOW).some((r: any) => r.id === "0000"),
      `the undated row vanished under "${a.value}" — hiding it is how it stops existing`,
    );
  }
});

test("status and kind narrow, and `task` is the kind of a row that stores none", () => {
  assert.deepEqual(filterLedger(rows, { status: ["open", "in-progress"] }, NOW).map((r: any) => r.id), ["e5f6", "beef"]);
  assert.deepEqual(filterLedger(rows, { kind: ["fact"] }, NOW).map((r: any) => r.id), ["c3d4"]);
  // three rows carry no `kind` at all; they must answer to `task`
  assert.equal(filterLedger(rows, { kind: ["task"] }, NOW).length, 3);
});

test("facets are counted from the data, never from a fixed list", () => {
  // `status` is free text — an agent may write a word nobody predicted, and a
  // hardcoded set of chips would hide exactly those rows.
  const f = ledgerFacets([...rows, { id: "zzzz", entity: "q", status: "blocked-on-legal", updatedAt: NOW }]);
  assert.ok(f.status.some((s: any) => s.value === "blocked-on-legal" && s.count === 1));
  assert.equal(f.kind.find((k: any) => k.value === "task")?.count, 4);
  // biggest first, so the chip bar opens on what the table is mostly made of
  assert.deepEqual([...f.status].sort((a: any, b: any) => b.count - a.count)[0], f.status[0]);
});

test("sorting: recent, least-recently-confirmed, and by name", () => {
  assert.deepEqual(filterLedger(rows, { sort: "recent" }, NOW).map((r: any) => r.id), ["a1b2", "c3d4", "e5f6", "beef", "7890"]);
  // the stale order is the one you hunt with: oldest CONFIRMATION first
  assert.deepEqual(filterLedger(rows, { sort: "stale" }, NOW).slice(0, 2).map((r: any) => r.id), ["7890", "c3d4"]);
  assert.equal(filterLedger(rows, { sort: "entity" }, NOW)[0].entity, "cron guard news lost on a failed delivery");
  // an unknown sort falls back rather than throwing — the control is a string
  assert.equal(filterLedger(rows, { sort: "nope" } as any, NOW).length, rows.length);
});

test("the UI's option lists come from the module, so the two cannot drift", () => {
  assert.ok(LEDGER_AGES.every((a: any) => a.value && a.label));
  assert.ok(LEDGER_SORTS.every((s: any) => s.value && s.label));
  for (const s of LEDGER_SORTS) assert.doesNotThrow(() => filterLedger(rows, { sort: s.value }, NOW));
});
