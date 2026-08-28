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
 * Resolve a short id — exact match, else a UNIQUE prefix — to its row, or null.
 * Empty and ambiguous both resolve to null (never guess), the same rule the cron
 * ids follow (invariant 17). The id is a durable HANDLE an agent can quote from
 * the pushed ledger block to update a row without retyping its (long) entity.
 */
export function resolveId(entries, idOrPrefix) {
  const q = String(idOrPrefix ?? "").trim().toLowerCase();
  if (!q) return null;
  const exact = entries.find((e) => e.id === q);
  if (exact) return exact;
  const pre = entries.filter((e) => typeof e.id === "string" && e.id.startsWith(q));
  return pre.length === 1 ? pre[0] : null;
}

/**
 * Upsert a row, two ways:
 *  - `patch.id` present → UPDATE that exact row in place (resolved via resolveId),
 *    keeping its id AND its entity (a rename only if `patch.entity` is given).
 *    An unknown id THROWS — an update must never silently spawn a new row.
 *  - else → upsert by normalised entity: supersede the existing twin, PRESERVING
 *    its id (the handle is durable across every write), or create a new row with
 *    `newId`.
 * `now` (epoch ms) and `newId` are injected so the core stays pure/testable.
 */
export function upsertEntry(entries, patch, now, newId) {
  if (patch.id != null && String(patch.id).trim()) {
    const cur = resolveId(entries, patch.id);
    if (!cur) throw new Error(`no ledger entry with id "${patch.id}"`);
    const row = {
      id: cur.id,
      entity:
        patch.entity != null && String(patch.entity).trim() ? String(patch.entity).trim() : cur.entity,
      status:
        patch.status != null && String(patch.status).trim() ? String(patch.status).trim() : cur.status,
      ...((patch.note ?? cur.note) ? { note: String(patch.note ?? cur.note).trim() } : {}),
      ...((patch.source ?? cur.source) ? { source: String(patch.source ?? cur.source).trim() } : {}),
      updatedAt: now,
    };
    return [...entries.filter((e) => e.id !== cur.id), row];
  }

  const key = normEntity(patch.entity);
  if (!key) throw new Error("entity is required");
  const existing = entries.find((e) => normEntity(e.entity) === key);
  const row = {
    id: existing?.id ?? newId,
    entity: String(patch.entity).trim(),
    status: String(patch.status ?? "").trim(),
    ...(patch.note ? { note: String(patch.note).trim() } : {}),
    ...(patch.source ? { source: String(patch.source).trim() } : {}),
    updatedAt: now,
  };
  return [...entries.filter((e) => normEntity(e.entity) !== key), row];
}

/**
 * Rows whose id, entity OR note contains the query (case-insensitive), most-
 * recent first. An empty query returns the whole table (for `list`).
 */
export function findEntries(entries, query) {
  const q = normEntity(query);
  const rows = q
    ? entries.filter(
        (e) =>
          String(e.id ?? "").toLowerCase().includes(q) ||
          normEntity(e.entity).includes(q) ||
          normEntity(e.note ?? "").includes(q),
      )
    : entries.slice();
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Whole days since a row was last touched — the freshness the reflex hedges on. */
export function ageDays(entry, now) {
  return Math.floor((now - (entry.updatedAt ?? now)) / 86_400_000);
}
