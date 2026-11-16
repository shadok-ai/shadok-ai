/**
 * Agent families — the pure core behind the parent/child tree of the agents
 * column. The link itself is the server's (`parent` on the channel, validated
 * by src/kinship.ts); this only decides how to DRAW it. Nothing is stored: the
 * tree is recomputed from the links on every layout, so it follows an agent
 * that spawns another without anyone arranging anything. ESM, browser + tests.
 */

/**
 * Who each agent is drawn under. `items` are `{ id, parent, slot }` in column
 * order: `id` the agent's session id (null for a tab that has none yet — it is
 * always a root), `parent` the session it reports to, `slot` the place it was
 * filed in (its group and folder).
 *
 * A child nests under its parent ONLY when both sit in the same slot. Filing is
 * a deliberate act — a folder, a group with its own members — and a derived
 * tree must never move an agent out of where someone put it. So a child filed
 * elsewhere, or whose parent is closed, is simply a root where it stands.
 *
 * Returns `Map<id, parentId>` holding the nested agents only.
 */
export function familyParents(items) {
  const byId = new Map();
  for (const it of items || []) if (it && it.id != null) byId.set(String(it.id), it);
  const shown = new Map();
  for (const it of byId.values()) {
    if (it.parent == null) continue;
    const p = byId.get(String(it.parent));
    if (!p || p === it || (p.slot ?? null) !== (it.slot ?? null)) continue;
    shown.set(String(it.id), String(p.id));
  }
  // The server refuses a cycle, but a list caught mid-update could carry one,
  // and a cycle has no root: every member would be drawn under another and the
  // whole loop would vanish from the column. Cut it — its members become roots.
  for (const start of [...shown.keys()]) {
    const seen = new Set([start]);
    let cur = shown.get(start);
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      cur = shown.get(cur);
    }
    // Only when the walk comes back to where it started: an agent hanging OFF
    // the loop is not part of it and keeps its parent.
    if (cur === start) for (const id of seen) shown.delete(id);
  }
  return shown;
}

/**
 * The same links, read downwards: `kids(id)` → the ids drawn directly under
 * `id`, in column order. `kids(null)` is not the roots — callers know theirs.
 */
export function familyChildren(items, shown) {
  const out = new Map();
  for (const it of items || []) {
    if (!it || it.id == null) continue;
    const p = shown.get(String(it.id));
    if (p == null) continue;
    if (!out.has(p)) out.set(p, []);
    out.get(p).push(String(it.id));
  }
  return (id) => out.get(String(id)) || [];
}

/** Every agent drawn under `id`, at any depth — what a folded parent hides. */
export function familyDescendants(kids, id) {
  const all = [];
  const walk = (cur) => {
    for (const k of kids(cur)) {
      all.push(k);
      walk(k);
    }
  };
  walk(id);
  return all;
}
