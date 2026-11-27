/**
 * Agent folders, client side — the pure core behind the folders of the agents
 * column (src/agent-folders.ts is the server's half). A folder belongs to ONE
 * group (`group`, null = Main) and holds that group's agents and sub-folders.
 * A visual arrangement only, never an ACL. ESM, browser + tests.
 */

/** Same cap as the server (src/agent-folders.ts). */
export const MAX_FOLDER_DEPTH = 8;

/** A fresh folder id the server accepts (/^[A-Za-z0-9_-]{1,64}$/). */
export function newFolderId(rand = Math.random, now = Date.now) {
  return "f-" + now().toString(36) + "-" + Math.floor(rand() * 1e9).toString(36);
}

const byIdOf = (folders) => new Map((folders || []).map((f) => [String(f.id), f]));

/** Is `ancestorId` `id` itself or one of its ancestors? */
export function isSelfOrAncestor(folders, ancestorId, id) {
  const byId = byIdOf(folders);
  let cur = id == null ? null : String(id);
  for (let i = 0; cur !== null && i <= (folders || []).length; i++) {
    if (cur === String(ancestorId)) return true;
    cur = byId.get(cur)?.parent ?? null;
  }
  return false;
}

/** 1 for a root folder, 2 for one inside it, … */
export function folderDepth(folders, id) {
  const byId = byIdOf(folders);
  let d = 0;
  let cur = id == null ? null : String(id);
  while (cur !== null && byId.has(cur) && d <= (folders || []).length) {
    d++;
    cur = byId.get(cur).parent ?? null;
  }
  return d;
}

/** How many levels a folder's subtree spans (1 = no sub-folders). */
function subtreeHeight(folders, id) {
  const kids = (folders || []).filter((f) => f.parent != null && String(f.parent) === String(id));
  return 1 + Math.max(0, ...kids.map((k) => subtreeHeight(folders, k.id)));
}

/**
 * May folder `id` move under `target` (null = its group's root)? Not into itself
 * or a descendant, not into another group's folder, and not past the depth cap.
 */
export function canMoveFolder(folders, id, target) {
  const byId = byIdOf(folders);
  const f = byId.get(String(id));
  if (!f) return false;
  if (target == null) return true;
  const t = byId.get(String(target));
  if (!t || (t.group ?? null) !== (f.group ?? null)) return false;
  if (isSelfOrAncestor(folders, f.id, t.id)) return false;
  return folderDepth(folders, t.id) + subtreeHeight(folders, f.id) <= MAX_FOLDER_DEPTH;
}

/** A group's folders, as a tree: `childrenOf(parentId|null)` → folders sorted by name. */
export function folderChildren(folders, group) {
  const g = group ?? null;
  const mine = (folders || []).filter((f) => (f.group ?? null) === g);
  return (parent) =>
    mine
      .filter((f) => (f.parent ?? null) === (parent ?? null))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
}

/**
 * The folder an agent shows in: `folder` if it exists in the agent's group,
 * else null (its group's root) — a stale id never hides an agent.
 */
export function effectiveFolder(folders, folder, group) {
  if (folder == null) return null;
  const f = byIdOf(folders).get(String(folder));
  return f && (f.group ?? null) === (group ?? null) ? f.id : null;
}

/**
 * Remove folder `id`: its sub-folders and its agents move up to its parent —
 * nothing is lost, so no confirmation is needed. `items` are `{id, folder}`.
 * Returns the new folder list and the agents to refile (id → new folder).
 */
export function removeFolder(folders, items, id) {
  const sid = String(id);
  const f = byIdOf(folders).get(sid);
  if (!f) return { folders: folders || [], refile: new Map() };
  const up = f.parent ?? null;
  const next = folders
    .filter((x) => String(x.id) !== sid)
    .map((x) => (x.parent != null && String(x.parent) === sid ? { ...x, parent: up } : x));
  const refile = new Map();
  for (const it of items || []) if (it.folder != null && String(it.folder) === sid) refile.set(String(it.id), up);
  return { folders: next, refile };
}

/** The anchor that names a folder, as another folder's `after`. */
export const folderAnchor = (id) => "f:" + id;

/**
 * One level of the agents column, in order: its root items interleaved with its
 * folders. `items` are the anchors of the level's root tabs in their own order
 * (`a:<sessionId>`, `r:<roomId>`, null for a tab not yet keyed); `kids` are the
 * level's folders, sorted by name. A folder sits right after its `after`; one
 * with no anchor, or an anchor that is not at this level (an agent closed or
 * moved elsewhere, an agent this viewer cannot see, a loop of folders) goes
 * first — where every folder sat before they could be placed among agents, so
 * nothing is ever hidden. Returns `{folder}` / `{item: index}` entries.
 */
export function levelOrder(items, kids) {
  const present = new Set((items || []).filter((k) => k != null));
  for (const f of kids || []) present.add(folderAnchor(f.id));
  const byAnchor = new Map();
  const first = [];
  for (const f of kids || []) {
    const a = f.after ?? null;
    if (a == null || a === folderAnchor(f.id) || !present.has(a)) first.push(f);
    else (byAnchor.get(a) || byAnchor.set(a, []).get(a)).push(f);
  }
  const done = new Set();
  const emitFolder = (out, f) => {
    if (done.has(f.id)) return;
    done.add(f.id);
    out.push({ folder: f });
    for (const g of byAnchor.get(folderAnchor(f.id)) || []) emitFolder(out, g);
  };
  const out = [];
  for (const f of first) emitFolder(out, f);
  (items || []).forEach((k, i) => {
    out.push({ item: i });
    if (k != null) for (const g of byAnchor.get(k) || []) emitFolder(out, g);
  });
  // Folders anchored on each other in a loop are reached from nothing: first.
  const lost = [];
  for (const f of kids || []) if (!done.has(f.id)) emitFolder(lost, f);
  return lost.length ? [...lost, ...out] : out;
}

/**
 * The anchors a level's folders get from where they sit on screen — the DOM is
 * the source of the order, as for agents. `entries` in screen order are
 * `{folder: id}` / `{item: anchor|null}`; each folder anchors on the nearest
 * KEYED entry above it, or nothing when it leads the level.
 */
export function anchorsFromOrder(entries) {
  const out = new Map();
  let prev = null;
  for (const e of entries || []) {
    if (e.folder != null) {
      out.set(String(e.folder), prev);
      prev = folderAnchor(e.folder);
    } else if (e.item != null) prev = e.item;
  }
  return out;
}
