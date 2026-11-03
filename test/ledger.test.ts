import assert from "node:assert/strict";
import test from "node:test";
// The skill is the single source of the logic; the repo suite tests it directly.
import {
  normEntity,
  upsertEntry,
  searchEntries,
  ageDays,
  resolveId,
  rowKind,
  normKind,
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

// A table big enough for the IDF and the table-derived stopwords to mean
// something — the scoring is relative to the corpus, so a 3-row fixture would
// exercise none of it.
const TABLE = [
  { id: "aa01", entity: "claude-launcher-stub-breaks-spawns", status: "resolved", note: "the npm placeholder", updatedAt: 10 },
  { id: "aa02", entity: "onboarding: home agent greets and reads the project", status: "decided", updatedAt: 20 },
  { id: "aa03", entity: "fork-follow (transcript context overflow)", status: "in-progress", note: "the Apple Ads chat froze on it", updatedAt: 30 },
  { id: "aa04", entity: "vps1 disk space", status: "resolved", note: "pruned the old images", updatedAt: 40 },
  { id: "aa05", entity: "nightly import", status: "fixed", note: "restarted the job de la nuit", updatedAt: 50 },
  { id: "aa06", entity: "landing page rework", status: "paused", note: "on hold de facto", updatedAt: 60 },
  { id: "aa07", entity: "staging budget", status: "learned", note: "capped it de nouveau", updatedAt: 70 },
  { id: "aa08", entity: "web accounts (named logins)", status: "resolved", note: "invitations de bienvenue", updatedAt: 80 },
  { id: "aa09", entity: "pr-merge cron guard", status: "resolved", note: "bounded every call de bout en bout", updatedAt: 90 },
  { id: "aa10", entity: "ledger viewer dates", status: "resolved", note: "real date de mise a jour", updatedAt: 100 },
  { id: "aa11", entity: "restart-all thundering herd", status: "resolved", note: "sequential respawn de tous", updatedAt: 110 },
  { id: "aa12", entity: "public repo leaks private project name", status: "resolved", note: "scrubbed de partout", updatedAt: 120 },
];
const ids = (list: any[]) => list.map((e: any) => e.id);

test("search finds a row by WORD OVERLAP when no substring matches", () => {
  // The reported bug: the caller has to know the exact wording, i.e. it only
  // answers when you do not need it. Not one word of this query is a substring
  // of the row, yet it is plainly the row being asked about.
  const { strong } = searchEntries(TABLE, "claude launcher stub spawn failure");
  assert.equal(strong[0].id, "aa01");
  // "spawn" reaches "…-spawns": a trailing plural must not lose the match
  assert.ok(ids(searchEntries(TABLE, "stub spawn").strong).includes("aa01"));
});

test("a verbatim substring still wins outright — the old behaviour is a subset", () => {
  const { strong } = searchEntries(TABLE, "disk space");
  assert.equal(strong[0].id, "aa04");
  assert.deepEqual(ids(searchEntries(TABLE, "aa07").strong), ["aa07"]); // id lookup
});

test("a match living only in the NOTE can still be strong", () => {
  // The field weight BOOSTS the entity, it must not cap the note: a query fully
  // covered by a note is still an answer.
  const { strong } = searchEntries(TABLE, "apple ads chat froze");
  assert.equal(strong[0].id, "aa03");
});

test("a query whose SUBJECT is absent gets no strong match, however many filler words it shares", () => {
  // This is the whole reason `check` has two tiers. Half this table carries the
  // French "de"; scoring the overlap alone made "recette de cuisine au chocolat"
  // a PERFECT match on a cooking question. "Nothing recorded is UNKNOWN, not
  // 'not done'" only survives if an absent subject can still come back empty.
  assert.deepEqual(searchEntries(TABLE, "recette de cuisine au chocolat").strong, []);
  assert.deepEqual(searchEntries(TABLE, "kubernetes helm chart rollout").strong, []);
  assert.deepEqual(searchEntries(TABLE, "kubernetes helm chart rollout").weak, []);
});

test("stopwords are DERIVED from the table, never a hand-written list", () => {
  // "de" is ubiquitous HERE and carries nothing; "ledger" is rare here and
  // carries a lot. No list of English/French stopwords would know either.
  assert.deepEqual(searchEntries(TABLE, "de").strong, []);
  assert.equal(searchEntries(TABLE, "ledger viewer").strong[0].id, "aa10");
});

test("a partial overlap lands in WEAK, offered as a lead and not as an answer", () => {
  // Two topics in one question, each only half-covered by a row: there is no
  // answer here, only leads. The caller prints these under a heading that says
  // so, and keeps the UNKNOWN sentence above them.
  const { strong, weak } = searchEntries(TABLE, "budget for the ledger dashboard");
  assert.deepEqual(strong, []);
  assert.deepEqual(ids(weak), ["aa10", "aa07"]);
});

test("results are ranked, best first", () => {
  const { strong } = searchEntries(TABLE, "public repo private project name leak");
  assert.equal(strong[0].id, "aa12");
});

test("empty query lists the whole table, recent-first", () => {
  const { strong, weak } = searchEntries(TABLE, "");
  assert.equal(strong.length, TABLE.length);
  assert.equal(strong[0].id, "aa12"); // updatedAt 120, the newest
  assert.deepEqual(weak, []);
});

test("normEntity collapses case and whitespace", () => {
  assert.equal(normEntity("  Nightly   IMPORT "), "nightly import");
});

test("ageDays is whole days since updatedAt", () => {
  assert.equal(ageDays({ updatedAt: 0 }, 3 * 86_400_000 + 5), 3);
  assert.equal(ageDays({ updatedAt: 100 }, 100), 0);
});

/* ---------------------------------------------------------------- *
 * kind: a task, a fact, or a decision — and the two clocks that go with it.
 * Spec: docs/superpowers/specs/2026-10-13-ledger-kind-and-headline.md
 * ---------------------------------------------------------------- */

test("kind is READ off an old row, never written back into it", () => {
  // The rows recorded before kinds existed carry none. `decided` was always a
  // kind wearing a status's clothes, so that is what it reads as; everything
  // else is a task. Nothing is rewritten — 138 rows keep their bytes.
  assert.equal(rowKind({ entity: "x", status: "decided" }), "decision");
  assert.equal(rowKind({ entity: "x", status: "resolved" }), "task");
  assert.equal(rowKind({ entity: "x", status: "open" }), "task");
  assert.equal(rowKind({ entity: "x", status: "resolved", kind: "fact" }), "fact");
  // an unparseable stored kind must not invent a fourth one
  assert.equal(rowKind({ entity: "x", status: "open", kind: "nonsense" }), "task");
});

test("an unknown kind is REFUSED, not stored", () => {
  // A typo that silently became a fourth kind would be invisible for exactly as
  // long as nobody went looking.
  assert.throws(() => normKind("fakt"));
  assert.throws(() => upsertEntry([], { entity: "x", status: "open", kind: "fakt" }, 1, "aa"));
  assert.equal(normKind(""), null); // absent is fine — the inference covers it
  assert.equal(normKind("  FACT "), "fact");
});

test("a lifecycle-less kind supplies its own status, so none has to be invented", () => {
  const f = upsertEntry([], { entity: "nightly window", kind: "fact", note: "03:00 Paris" }, 1000, "bb");
  assert.equal(f[0].status, "current"); // not "" — every reader still sees a status
  assert.equal(f[0].kind, "fact");
  const d = upsertEntry([], { entity: "supersede, not append", kind: "decision" }, 1000, "cc");
  assert.equal(d[0].status, "decided");
  // an explicit status still wins
  const e = upsertEntry([], { entity: "z", kind: "fact", status: "stale" }, 1000, "dd");
  assert.equal(e[0].status, "stale");
});

test("kind belongs to the ENTITY: a supersede keeps it, like the id", () => {
  let rows: any[] = upsertEntry([], { entity: "nightly window", kind: "fact" }, 1000, "bb");
  rows = upsertEntry(rows, { entity: "nightly window", status: "stale" }, 2000, "zz");
  assert.equal(rows[0].kind, "fact"); // not silently demoted to a task
  assert.equal(rows[0].status, "stale");
});

test("promoting a row by id to a lifecycle-less kind drops its stale lifecycle word", () => {
  // `--id X --kind fact` must not leave "resolved" sitting on a fact.
  let rows: any[] = upsertEntry([], { entity: "nightly window", status: "resolved" }, 1000, "bb");
  rows = upsertEntry(rows, { id: "bb", kind: "fact" }, 2000);
  assert.equal(rows[0].kind, "fact");
  assert.equal(rows[0].status, "current");
});

test("an EDIT moves updatedAt; only an OBSERVATION moves verifiedAt", () => {
  // The defect this fixes: `ageDays` read `updatedAt`, so rewording a note
  // rejuvenated a row nobody had re-checked in a month — which silently
  // switched off the reflex's "a stale record → confirm before acting" hedge.
  let rows: any[] = upsertEntry([], { entity: "x", status: "open" }, 1000, "aa");
  assert.equal(rows[0].verifiedAt, 1000);

  rows = upsertEntry(rows, { id: "aa", note: "reworded, nothing re-checked" }, 9000);
  assert.equal(rows[0].updatedAt, 9000);
  assert.equal(rows[0].verifiedAt, 1000); // NOT rejuvenated

  // re-asserting a status IS confirming it, even when the value is unchanged
  rows = upsertEntry(rows, { id: "aa", status: "open" }, 20_000);
  assert.equal(rows[0].updatedAt, 20_000);
  assert.equal(rows[0].verifiedAt, 20_000);
});

test("--verified alone moves verifiedAt and leaves updatedAt put — so it stays OUT of the delta", () => {
  // Deliberate: the pushed delta selects on `updatedAt`, and "I re-checked,
  // nothing changed" is not news. Pushing it to every sibling agent is exactly
  // the noise a state table exists to avoid.
  let rows: any[] = upsertEntry([], { entity: "x", status: "current", kind: "fact" }, 1000, "aa");
  rows = upsertEntry(rows, { id: "aa", verified: true }, 50_000);
  assert.equal(rows[0].updatedAt, 1000); // unmoved → not in anyone's delta
  assert.equal(rows[0].verifiedAt, 50_000);
  assert.equal(rows[0].status, "current"); // nothing else touched
});

test("a row that predates verifiedAt inherits its old updatedAt as the last observation", () => {
  // The migration, lazy and per row: the row WAS last observed when it was last
  // written, so that is the truth to freeze — never `now`, which would claim a
  // check that never happened.
  const legacy = [{ id: "aa", entity: "x", status: "open", updatedAt: 1000 }];
  const rows: any[] = upsertEntry(legacy, { id: "aa", note: "reworded" }, 9000);
  assert.equal(rows[0].verifiedAt, 1000);
});

test("ageDays is days since the claim was CONFIRMED, not since it was written", () => {
  const day = 86_400_000;
  assert.equal(ageDays({ updatedAt: 9 * day, verifiedAt: 2 * day }, 10 * day), 8);
  // no verifiedAt → fall back to updatedAt, so older rows are unaffected
  assert.equal(ageDays({ updatedAt: 7 * day }, 10 * day), 3);
});

/* ---- Task 13 (PIVOT): one table, per-row authoring group, server-mediated ----
 *
 * The first attempt used a FILE PER GROUP with a `--public` mirror into Main.
 * That broke on the OS-user wall (a privilege-dropped `sk-<id>` agent cannot
 * write the server's 0600 ledger → EACCES + a half-published row), let a bare
 * record DELETE another group's public row, and leaked Main-private rows through
 * `GET /ledger`. The model is now ONE table per instance; each row carries its
 * AUTHORING `group`; reads/writes are scoped SERVER-SIDE. `upsertEntry`'s
 * `scope` threading is unchanged and still covered just above; these pin the new
 * one-table cores. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deltaSince, scopeVisible, recordIntoTable } from "../src/ledger.ts";

test("upsertEntry carries scope; absent scope is NOT written (reads as group)", () => {
  const pub: any[] = upsertEntry([], { entity: "A", status: "open", scope: "public" }, 1, "a1");
  assert.equal(pub[0].scope, "public");
  const bare: any[] = upsertEntry([], { entity: "B", status: "open" }, 1, "b1");
  assert.equal(bare[0].scope, "group"); // the SAFE default, stored explicitly
  const upd: any[] = upsertEntry(pub, { id: "a1", note: "n" }, 2);
  assert.equal(upd[0].scope, "public"); // an edit that omits scope keeps it
  const demote: any[] = upsertEntry(pub, { id: "a1", scope: "group" }, 3);
  assert.equal(demote[0].scope, "group");
});

test("deltaSince with a visibleScope drops another group's private rows, keeps public", () => {
  const rows: any[] = [
    { id: "1", entity: "mine", status: "open", updatedAt: 10, group: "g1", scope: "group" },
    { id: "2", entity: "theirs", status: "open", updatedAt: 11, group: "g2", scope: "group" },
    { id: "3", entity: "shared", status: "open", updatedAt: 12, group: "g2", scope: "public" },
    { id: "4", entity: "legacy", status: "open", updatedAt: 13, group: "g2" }, // no scope = group
  ];
  const d = deltaSince(rows, 0, 10, { groupId: "g1", includePublic: true });
  assert.deepEqual(d.rows.map((r) => r.id).sort(), ["1", "3"]);
  assert.equal(d.total, 2);
  const noPub = deltaSince(rows, 0, 10, { groupId: "g1", includePublic: false });
  assert.deepEqual(noPub.rows.map((r) => r.id), ["1"]);
  assert.equal(deltaSince(rows, 0, 10).total, 4); // unscoped call unchanged
});

test("deltaSince: a commons row (group null) normalises to Main — a mono-tenant push still sees it", () => {
  // In mono-tenant every row's authoring group is null; the push asks with
  // groupId "main". Without the null→Main normalisation the delta came back
  // empty, which is the whole-feature-off failure.
  const rows: any[] = [
    { id: "x", entity: "legacy commons row", status: "open", updatedAt: 10 }, // no group, no scope
    { id: "y", entity: "explicit main row", status: "open", updatedAt: 11, group: "main" },
  ];
  const d = deltaSince(rows, 0, 10, { groupId: "main", includePublic: true });
  assert.deepEqual(d.rows.map((r) => r.id).sort(), ["x", "y"]);
});

test("scopeVisible: own-group rows ∪ public; another group's group-scoped rows are dropped", () => {
  const rows: any[] = [
    { id: "a", entity: "a-private", status: "open", group: "A", scope: "group" },
    { id: "b", entity: "b-private", status: "open", group: "B", scope: "group" },
    { id: "p", entity: "b-public", status: "open", group: "B", scope: "public" },
    { id: "m", entity: "main-private", status: "open", scope: "group" }, // group null → Main
  ];
  // Group A: its own rows + every public row; never B's private one.
  assert.deepEqual(scopeVisible(rows, new Set(["A"]), true).map((r) => r.id).sort(), ["a", "p"]);
  // Group B: its own private AND public rows.
  assert.deepEqual(scopeVisible(rows, new Set(["B"]), true).map((r) => r.id).sort(), ["b", "p"]);
  // A member who can see Main sees the Main-private row and public, not A/B.
  assert.deepEqual(scopeVisible(rows, new Set(["main"]), true).map((r) => r.id).sort(), ["m", "p"]);
  // includePublic false → strictly own group (the push's "no public" variant).
  assert.deepEqual(scopeVisible(rows, new Set(["A"]), false).map((r) => r.id), ["a"]);
});

test("recordIntoTable: stamps the authoring group, scopes the upsert to it", () => {
  let rows: any[] = [];
  ({ rows } = recordIntoTable(rows, "A", { entity: "thing", status: "open" }, 100, "a1"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, "A"); // stamped from the caller, not the patch
  assert.equal(rows[0].scope, "group"); // group-private by default
  // --public flips scope, group unchanged
  ({ rows } = recordIntoTable(rows, "A", { id: "a1", public: true }, 200, "zz"));
  assert.equal(rows[0].scope, "public");
  assert.equal(rows[0].group, "A");
});

test("recordIntoTable: a bare record by group A never supersedes OR deletes group B's row with the same entity", () => {
  // The per-group-file demotion bug: A recording the entity B also tracks wiped
  // B's public row. One table, scoped upsert → A gets its OWN row, B's is untouched.
  let rows: any[] = [
    { id: "b1", entity: "shared topic", status: "resolved", group: "B", scope: "public", updatedAt: 1 },
  ];
  const out = recordIntoTable(rows, "A", { entity: "shared topic", status: "open" }, 100, "a1");
  rows = out.rows;
  assert.equal(rows.length, 2); // a NEW row for A, B's still there
  const b = rows.find((r) => r.group === "B");
  assert.equal(b.scope, "public"); // B's public row survives, unchanged
  assert.equal(b.status, "resolved");
  const a = rows.find((r) => r.group === "A");
  assert.equal(a.entity, "shared topic");
  assert.equal(a.scope, "group");
});

test("recordIntoTable: an --id edit cannot touch a row authored by another group", () => {
  const rows: any[] = [
    { id: "b1", entity: "theirs", status: "open", group: "B", scope: "group", updatedAt: 1 },
  ];
  // A tries to edit B's row by its (quotable) id → refused, never a cross-group overwrite.
  assert.throws(() => recordIntoTable(rows, "A", { id: "b1", status: "resolved" }, 100, "a1"));
  // B editing its own row is fine.
  const ok = recordIntoTable(rows, "B", { id: "b1", status: "resolved" }, 100, "zz");
  assert.equal(ok.row.status, "resolved");
  assert.equal(ok.row.group, "B");
});

test("CLI off-server fallback: one file, --public stored as scope (no mirror file)", () => {
  // With no SHADOK_PORT/SHADOK_SESSION_KEY the CLI writes the local file directly
  // (hand-run / mono-tenant). This is the path that must behave exactly as before
  // the scope work, minus the removed per-group mirror.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledcli-"));
  const file = path.join(dir, "ledger.json");
  const run = (...a: string[]) =>
    spawnSync(process.execPath, ["context/ledger-skill/ledger.mjs", ...a], {
      encoding: "utf8",
      // No PORT/KEY → fallback. Strip any inherited ones so the test is hermetic.
      env: { ...process.env, SHADOK_LEDGER_FILE: file, SHADOK_PORT: "", SHADOK_SESSION_KEY: "" },
    });
  assert.equal(run("record", "--entity", "secret thing", "--status", "open").status, 0);
  assert.equal(run("record", "--public", "--entity", "shared thing", "--status", "open").status, 0);
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(rows.find((r: any) => r.entity === "secret thing").scope, "group");
  assert.equal(rows.find((r: any) => r.entity === "shared thing").scope, "public");
  assert.equal(rows.length, 2); // ONE file, both rows in it — no separate commons file
  assert.ok(!fs.existsSync(path.join(dir, "commons.json")));
  // list shows both; the public one is marked
  const ls = run("list");
  assert.match(ls.stdout, /shared thing/);
  assert.match(ls.stdout, /secret thing/);
  assert.match(ls.stdout, /· public/);
});
