/**
 * The two-column navigation: groups on the left (the "rail"), the selected
 * group's agents beside it. Pure, so the browser and test/group-nav.test.ts
 * share it.
 *
 * The rail is a VIEW over the agents column, never a second copy of the groups:
 * the order, names and membership still live in the agents column's DOM, which
 * is what `persistGroups` / `persistChannels` read. So nothing here owns state.
 */

/** Icons a new group draws from; any emoji can be typed in instead. */
export const GROUP_ICONS = [
  "📁", "🚀", "🧪", "🛠", "📦", "🎯", "🧭", "🔬", "🌱", "⚡",
  "🧩", "📊", "🔒", "🎨", "📣", "🐛", "🗂", "🛰", "🔥", "💡",
];

/** The view a group is selected under; the agents with no group have their own. */
export const UNGROUPED = "ungrouped";

/** A random icon from GROUP_ICONS. `rand` is injectable for the tests. */
export function randomGroupIcon(rand = Math.random) {
  const i = Math.floor(rand() * GROUP_ICONS.length);
  return GROUP_ICONS[Math.min(Math.max(i, 0), GROUP_ICONS.length - 1)];
}

/**
 * The view to show, from what was saved and the groups that exist now. A saved
 * group that was dissolved (here or on another device) falls back to the
 * ungrouped view rather than to an empty column.
 */
export function resolveGroupView(saved, groupIds) {
  const ids = (groupIds || []).map(String);
  return saved != null && ids.includes(String(saved)) ? String(saved) : UNGROUPED;
}

/**
 * One mood for a whole group, from its agents' moods — what the rail shows for
 * a group that is not on screen. Ordered by how much it needs you: a question
 * waiting beats an unread answer, which beats work in progress.
 */
export function groupMood(moods) {
  const set = new Set(moods || []);
  for (const m of ["needs-answer", "unread", "working"]) if (set.has(m)) return m;
  return null;
}

/**
 * A typed icon, trimmed and kept short: one emoji may be several code points
 * (a flag, a skin tone, a ZWJ family), so the cap is on graphemes when the
 * runtime can count them. Empty → null, so the caller keeps the old one.
 */
export function cleanGroupIcon(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)];
    return seg.slice(0, 2).map((x) => x.segment).join("");
  }
  return [...s].slice(0, 2).join("");
}

/**
 * Which group an agent should sit in after a /channels poll, and what this tab
 * now believes the server holds. `local` is where the tab shows it, `synced` the
 * group last agreed with the server (undefined = never agreed: a tab this page
 * just created), `server` what /channels says.
 *
 * A tab whose `local` differs from `synced` has a move of its own the server
 * has not confirmed yet — keep it, the push will land. Otherwise a different
 * `server` is a move made in ANOTHER tab or device, and this tab follows it:
 * without that, it kept the old group for ever and wrote it back on its next
 * push, which is how a dragged agent "went back" to where it was.
 */
export function reconcileTabGroup(local, synced, server) {
  const srv = server ?? null;
  if ((local ?? null) === srv) return { move: false, synced: srv };
  if (synced === undefined || (local ?? null) !== synced) return { move: false, synced };
  return { move: true, synced: srv };
}

/** Does this tab's push carry `group`? Only when it moved the agent itself —
 *  an omitted key leaves the server's value alone (mergeChannels). */
export function groupIsDirty(local, synced) {
  return synced === undefined || (local ?? null) !== synced;
}

/**
 * Which agent to focus when a group view becomes current. Switching groups used
 * to snap to the TOP agent every time; instead we return to the one you last had
 * focused in that group (`rememberedId`), so flipping between groups no longer
 * loses your place. Falls back to the first agent when nothing is remembered yet
 * or the remembered one has since gone (closed, or moved to another group), and
 * to `null` for an empty group. `idsInView` is the group's agent session ids, in
 * display order.
 */
export function focusTarget(idsInView, rememberedId) {
  const ids = idsInView || [];
  if (rememberedId != null && ids.includes(rememberedId)) return rememberedId;
  return ids.length ? ids[0] : null;
}

/**
 * Why an agent may NOT be moved from one group to another, or null when it may.
 * The twin of the server's `groupMoveRefusal` (src/groups.ts), which enforces
 * it; this copy is what lets the drop say so at once instead of the agent
 * silently sliding back on the next sync. `from`/`to` are `{id, name, nature}`
 * or null for the commons (the "Main" view).
 *
 * On a multi-tenant instance a group's NATURE decides which OS user an agent
 * runs as: every public group (Main included) shares the commons user, a
 * Private or Personal group has its own. Moving between two groups of the
 * commons changes nothing about the running agent; moving across that wall
 * would need a different process, home and history, so it is refused.
 */
export function groupMoveRefusal(from, to) {
  const walled = (g) => !!g && g.nature !== "public";
  const same = (from ? String(from.id) : null) === (to ? String(to.id) : null);
  if (same) return null;
  const label = (g) => (g.nature === "private" ? "Personal" : `the private group “${g.name}”`);
  if (walled(from))
    return `This agent can’t leave ${label(from)}: it runs there under that space’s own system account, with its files and history. Create a new agent where you want it instead.`;
  if (walled(to))
    return `An agent can’t be moved into ${label(to)}: that space is walled off (its own system account, its own files). Create the agent from inside it instead.`;
  return null;
}

/* ── Folders: a visual arrangement of the rail (src/group-folders.ts) ──────
 * A folder holds groups and other folders. It is never an ACL: nothing here
 * changes who sees an agent or which OS user it runs as. */

/** Same cap as the server's MAX_FOLDER_DEPTH. */
export const MAX_FOLDER_DEPTH = 8;

/** A fresh folder id the server accepts (`[A-Za-z0-9_-]{1,64}`). */
export function newFolderId(rand = Math.random) {
  return "f-" + Date.now().toString(36) + "-" + Math.floor(rand() * 1e9).toString(36);
}

/** Is `ancestorId` `id` itself or one of its ancestors? A folder can't be moved
 *  into itself or below itself. */
export function isSelfOrAncestor(folders, ancestorId, id) {
  const byId = new Map((folders || []).map((f) => [String(f.id), f]));
  let cur = id == null ? null : String(id);
  for (let i = 0; cur != null && i <= byId.size; i++) {
    if (cur === String(ancestorId)) return true;
    const f = byId.get(cur);
    cur = f && f.parent != null ? String(f.parent) : null;
  }
  return false;
}

/** How many folders deep `id` sits (1 for a root folder; 0 for null). */
export function folderDepth(folders, id) {
  const byId = new Map((folders || []).map((f) => [String(f.id), f]));
  let d = 0;
  let cur = id == null ? null : String(id);
  while (cur != null && byId.has(cur) && d <= byId.size) {
    d++;
    const p = byId.get(cur).parent;
    cur = p == null ? null : String(p);
  }
  return d;
}

/** The height of the folder subtree rooted at `id` (1 for a folder with no sub-folder). */
function subtreeHeight(folders, id) {
  const kids = folders.filter((f) => f.parent != null && String(f.parent) === String(id));
  return 1 + kids.reduce((m, k) => Math.max(m, subtreeHeight(folders, k.id)), 0);
}

/** May folder `id` be moved under `parent` (null = root)? Not into itself or a
 *  descendant, and not past MAX_FOLDER_DEPTH counting its own sub-folders. */
export function canMoveFolder(folders, id, parent) {
  if (parent == null) return true;
  if (isSelfOrAncestor(folders || [], id, parent)) return false;
  return folderDepth(folders, parent) + subtreeHeight(folders || [], id) <= MAX_FOLDER_DEPTH;
}

/**
 * The rail's rows, in display order: at each level the sub-folders
 * (alphabetical) then the groups (in their own manual order). A group whose
 * folder does not exist sits at the root; a folded folder's contents are left
 * out. `groups` is `[{id, folder}]` in display order; `collapsed` a Set of ids.
 * Rows: `{kind: "folder"|"group", id, depth}`.
 */
export function folderRows(folders, groups, collapsed) {
  const fl = folders || [];
  const ids = new Set(fl.map((f) => String(f.id)));
  const parentOf = (f) => (f.parent != null && ids.has(String(f.parent)) ? String(f.parent) : null);
  const folderOf = (g) => (g.folder != null && ids.has(String(g.folder)) ? String(g.folder) : null);
  const fold = collapsed || new Set();
  const rows = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    const subs = fl
      .filter((f) => parentOf(f) === parent && !seen.has(String(f.id)))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
    for (const f of subs) {
      const id = String(f.id);
      seen.add(id);
      rows.push({ kind: "folder", id, depth });
      if (!fold.has(id) && depth + 1 < MAX_FOLDER_DEPTH + 1) walk(id, depth + 1);
    }
    for (const g of groups || []) if (folderOf(g) === parent) rows.push({ kind: "group", id: String(g.id), depth });
  };
  walk(null, 0);
  return rows;
}

/** Every group id filed anywhere under folder `id` (for its mood and count). */
export function groupsUnder(folders, groups, id) {
  const fl = folders || [];
  const ids = new Set(fl.map((f) => String(f.id)));
  return (groups || [])
    .filter((g) => g.folder != null && ids.has(String(g.folder)) && isSelfOrAncestor(fl, id, g.folder))
    .map((g) => String(g.id));
}

/**
 * Removing folder `id`: its sub-folders and groups move up to its parent, so
 * nothing is lost. Returns the new folder list and the groups to refile
 * (`Map<groupId, newFolder>`).
 */
export function removeFolder(folders, groups, id) {
  const sid = String(id);
  const gone = (folders || []).find((f) => String(f.id) === sid);
  const up = gone && gone.parent != null ? String(gone.parent) : null;
  const next = (folders || [])
    .filter((f) => String(f.id) !== sid)
    .map((f) => (f.parent != null && String(f.parent) === sid ? { ...f, parent: up } : f));
  const refile = new Map();
  for (const g of groups || []) if (g.folder != null && String(g.folder) === sid) refile.set(String(g.id), up);
  return { folders: next, refile };
}
