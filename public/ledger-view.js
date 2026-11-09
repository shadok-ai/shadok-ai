// Filtering and sorting for the read-only ledger viewer.
//
// The table is small enough to send whole (`GET /ledger`) and large enough that
// a flat list stops being readable: 144 rows on the instance that develops
// shadok, 498 on a sibling one day later, and it only grows with the number of
// live topics. So the narrowing happens client-side, over rows already in hand
// — no endpoint, no pagination, no round trip per keystroke.
//
// Pure, and in its own module for the usual reason (invariant 10's family): the
// browser loads it AND `test/ledger-view.test.ts` imports it, so the rules below
// are exercised without a DOM.

/** Case- and ACCENT-insensitive, because a sibling instance's rows are written
 *  in French: searching `hopital` must find `hôpital`, or the box is a trap for
 *  exactly the people whose rows need it most. */
export function ldgNorm(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Everything a row can be found by. The id is in there on purpose: it is the
 *  handle the pushed block and the CLI both print, so pasting `a1b2` back in
 *  has to land on the row it names. */
export function ledgerHaystack(e) {
  return ldgNorm([e?.id, e?.entity, e?.status, e?.kind, e?.note, e?.source].filter(Boolean).join(" "));
}

/**
 * How many days since the row's claim was last CONFIRMED — `verifiedAt` when it
 * exists, else `updatedAt`. Same two-clock rule the CLI and the block use: an
 * edit is not an observation, and the staleness judgement rests on the latter.
 * Counted in CALENDAR days, so it agrees with the date the row shows rather
 * than with a rolling 24 hours.
 */
export function ledgerAge(e, now = Date.now()) {
  const t = e?.verifiedAt ?? e?.updatedAt;
  if (!t) return null;
  const d = new Date(t);
  const n = new Date(now);
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const n0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  return Math.max(0, Math.round((n0 - d0) / 86400000));
}

/** The age windows offered, as data so the <select> is built from them and the
 *  filter reads the same list. `stale` is the inverse of the others and the one
 *  with operational value: a row nobody has re-confirmed in a month is exactly
 *  what the hedge in the skill is about. */
export const LEDGER_AGES = [
  { value: "any", label: "any age" },
  { value: "today", label: "today", max: 0 },
  { value: "7", label: "last 7 days", max: 7 },
  { value: "30", label: "last 30 days", max: 30 },
  { value: "stale", label: "not confirmed in 30d", min: 31 },
];

export const LEDGER_SORTS = [
  { value: "recent", label: "most recent" },
  { value: "stale", label: "least recently confirmed" },
  { value: "entity", label: "name (A→Z)" },
];

/** The distinct values really present, with their counts — never a hardcoded
 *  list: `status` is free text (an agent may write anything), so a fixed set of
 *  chips would silently hide whatever word it did not predict. */
export function ledgerFacets(entries) {
  const tally = (pick) => {
    const m = new Map();
    for (const e of entries ?? []) {
      const v = pick(e);
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };
  return {
    status: tally((e) => e.status),
    // `task` is the default and nearly the whole table, so it is a chip like the
    // others here (unlike the block, where tagging it would be noise on a line
    // the reader did not ask for) — in a filter bar the reader DID ask.
    kind: tally((e) => e.kind || "task"),
  };
}

/**
 * Narrow and order. An empty selection means "no constraint on that dimension",
 * never "nothing" — a filter bar that can be driven into an empty list by doing
 * nothing is a bug report waiting to happen.
 *
 * Every search term must match (AND), which is how a search box is expected to
 * behave: typing more words narrows.
 */
export function filterLedger(entries, query = {}, now = Date.now()) {
  const { text = "", status = [], kind = [], age = "any", sort = "recent" } = query;
  const terms = ldgNorm(text).split(/\s+/).filter(Boolean);
  const window = LEDGER_AGES.find((a) => a.value === age) ?? LEDGER_AGES[0];
  const out = (entries ?? []).filter((e) => {
    if (status.length && !status.includes(e.status)) return false;
    if (kind.length && !kind.includes(e.kind || "task")) return false;
    if (window.max != null || window.min != null) {
      const d = ledgerAge(e, now);
      // A row with no date at all is NOT quietly dropped by an age window: it
      // is a row we know nothing about, and hiding it is how it stops existing.
      if (d != null) {
        if (window.max != null && d > window.max) return false;
        if (window.min != null && d < window.min) return false;
      }
    }
    if (terms.length) {
      const hay = ledgerHaystack(e);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const by = {
    recent: (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    stale: (a, b) => (ledgerAge(b, now) ?? -1) - (ledgerAge(a, now) ?? -1) || (a.updatedAt ?? 0) - (b.updatedAt ?? 0),
    entity: (a, b) => String(a.entity ?? "").localeCompare(String(b.entity ?? "")),
  };
  return out.sort(by[sort] ?? by.recent);
}
