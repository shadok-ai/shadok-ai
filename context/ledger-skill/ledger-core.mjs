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

/* --------------------------------------------------------------------- *
 * Recall: answering a QUESTION, not demanding the exact wording.
 *
 * `check` used to match the whole query as a SUBSTRING of the id, entity or
 * note — so it answered only when the caller already knew how a sibling had
 * phrased the row, which is exactly when they did not need to ask. Measured on
 * the live 64-row table against fifteen queries agents really typed: ZERO
 * returned anything, while the matching row sat there in plain sight
 * ("claude launcher stub spawn failure" vs `claude-launcher-stub-breaks-spawns`).
 * Each got "(nothing recorded — treat as UNKNOWN)", which the reflex reads as
 * "there is nothing here" — the very silo the ledger exists to close.
 *
 * So: word overlap weighted by IDF, computed over the table itself.
 * Design and the tuning sweep: docs/superpowers/specs/2026-09-09-ledger-recall.md
 * --------------------------------------------------------------------- */

/** A hit in the entity is worth more than one in the details — but the details
 *  are still evidence, so this BOOSTS rather than caps: a query fully covered by
 *  a note must still be able to be a strong match. */
const FIELD_WEIGHT = { entity: 1, note: 0.7, source: 0.7 };
/** A word the table has never seen is DISCOUNTED, not ignored. Ignoring it
 *  outright let a query whose subject is absent score a perfect match on the
 *  filler words it happened to share with a note; counting it in full threw away
 *  long real queries whose subject IS recorded under other words. */
const UNKNOWN_TERM_PENALTY = 0.2;
/** Two tiers, because "nothing recorded is UNKNOWN" is load-bearing: a search
 *  that always returns SOMETHING would quietly erase that third state. */
const STRONG = 0.55;
const WEAK = 0.25;

/** Words, not substrings: lowercased, split on non-alphanumerics, 1-char tokens
 *  dropped, a trailing plural stripped — which is what lets "spawn failure"
 *  reach "…-breaks-spawns". */
export function tokenize(s) {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Document frequency per term over the whole table — the corpus the scoring is
 *  relative to, so it self-tunes and needs no domain vocabulary. */
function docFreq(entries) {
  const df = new Map();
  for (const e of entries) {
    const seen = new Set([...tokenize(e.entity), ...tokenize(e.note), ...tokenize(e.source)]);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

/**
 * Rows matching `query`, split into `strong` (this is your answer) and `weak`
 * (this merely shares words with your question), each ranked best-first and
 * capped. An empty query returns the whole table in `strong`, recent-first.
 *
 * The caller MUST keep the two apart: a weak row is a lead, never a status to
 * assert on.
 */
export function searchEntries(entries, query, opts = {}) {
  const strongAt = opts.strong ?? STRONG;
  const weakAt = opts.weak ?? WEAK;
  const byRecency = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const q = normEntity(query);
  if (!q) return { strong: entries.slice().sort(byRecency), weak: [] };

  // An id is a durable handle an agent quotes from the pushed block: it must
  // resolve whatever the corpus thinks of it as a word. Before the term guard,
  // which would drop it as a term the table has never seen.
  const byId = resolveId(entries, q);
  if (byId) return { strong: [byId], weak: [] };

  const df = docFreq(entries);
  const N = entries.length || 1;
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) ?? 0)));
  // A term in most of the table cannot discriminate. Derived, never listed:
  // "to" is a stopword in one table and "ledger" in none of ours, and no
  // hand-written list would have known that.
  const terms = [...new Set(tokenize(query))].filter((t) => !((df.get(t) ?? 0) >= 4 && df.get(t) > 0.4 * N));
  const known = terms.filter((t) => df.get(t));
  if (!known.length) return { strong: [], weak: [] };
  const denom =
    known.reduce((a, t) => a + idf(t), 0) +
    UNKNOWN_TERM_PENALTY * terms.filter((t) => !df.get(t)).reduce((a, t) => a + idf(t), 0);

  const scored = entries
    .map((e) => {
      // A verbatim substring is the old behaviour and still wins outright, so
      // what `check` used to answer it still answers, identically.
      if (String(e.id ?? "").toLowerCase() === q || `${e.entity} ${e.note ?? ""}`.toLowerCase().includes(q))
        return { e, score: 1 };
      const F = { entity: tokenize(e.entity), note: tokenize(e.note), source: tokenize(e.source) };
      let matched = 0;
      for (const t of known) {
        const w = F.entity.includes(t)
          ? FIELD_WEIGHT.entity
          : F.note.includes(t)
            ? FIELD_WEIGHT.note
            : F.source.includes(t)
              ? FIELD_WEIGHT.source
              : 0;
        matched += idf(t) * w;
      }
      return { e, score: denom ? matched / denom : 0 };
    })
    .sort((a, b) => b.score - a.score || byRecency(a.e, b.e));

  return {
    strong: scored.filter((x) => x.score >= strongAt).slice(0, 5).map((x) => x.e),
    weak: scored.filter((x) => x.score < strongAt && x.score >= weakAt).slice(0, 3).map((x) => x.e),
  };
}

/** Whole days since a row was last touched — the freshness the reflex hedges on. */
export function ageDays(entry, now) {
  return Math.floor((now - (entry.updatedAt ?? now)) / 86_400_000);
}
