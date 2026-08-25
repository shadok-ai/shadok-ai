// Pure core of the shadok-ledger skill: a STATE TABLE of entities, NOT an
// append-only log. One current row per entity; a write SUPERSEDES it, so size
// is bounded by the number of live topics, not by activity. Kept deliberately
// tiny — see docs/superpowers/specs/2026-08-25-shared-ledger-design.md.
//
// This file is the single source of the logic: the CLI (ledger.mjs) imports it,
// and test/ledger.test.ts imports it too — no duplication to drift.

/** Normalise an entity name for matching/dedup: lowercased, collapsed spaces. */
export function normEntity(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Upsert by normalised entity — SUPERSEDE the existing row, never append a twin.
 * `now` (epoch ms) is injected so the core stays pure/testable.
 */
export function upsertEntry(entries, patch, now) {
  const key = normEntity(patch.entity);
  if (!key) throw new Error("entity is required");
  const row = {
    entity: String(patch.entity).trim(),
    status: String(patch.status ?? "").trim(),
    ...(patch.note ? { note: String(patch.note).trim() } : {}),
    ...(patch.source ? { source: String(patch.source).trim() } : {}),
    updatedAt: now,
  };
  return [...entries.filter((e) => normEntity(e.entity) !== key), row];
}

/**
 * Rows whose entity OR note contains the query (case-insensitive), most-recent
 * first. An empty query returns the whole table (for `list`).
 */
export function findEntries(entries, query) {
  const q = normEntity(query);
  const rows = q
    ? entries.filter(
        (e) => normEntity(e.entity).includes(q) || normEntity(e.note ?? "").includes(q),
      )
    : entries.slice();
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Whole days since a row was last touched — the freshness the reflex hedges on. */
export function ageDays(entry, now) {
  return Math.floor((now - (entry.updatedAt ?? now)) / 86_400_000);
}
