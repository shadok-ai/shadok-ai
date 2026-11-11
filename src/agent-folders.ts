/**
 * Agent folders: a purely VISUAL arrangement of the agents INSIDE a group —
 * folders that hold agents and other folders. Never an ACL: a folder changes
 * nothing about who sees or drives an agent, nor which OS user it runs as (the
 * group's nature owns that, src/groups.ts). Each folder belongs to exactly one
 * group (`group`, null = Main), so its visibility is simply its group's.
 * See docs/superpowers/specs/2026-11-10-agent-folders-design.md.
 *
 * Pure and dependency-free (bar the commons id), so the whole merge/visibility
 * rule is unit-tested.
 */
import { MAIN_GROUP_ID } from "./groups.js";

export interface Folder {
  id: string;
  name: string;
  icon?: string;
  /** Another folder's id (in the SAME group), or null for the group's root. */
  parent: string | null;
  /** The group the folder lives in; null = Main (the commons). */
  group: string | null;
}

/** An agent as far as folders care: its id and the folder it is filed in. */
export interface FiledItem {
  id: string;
  folder?: string | null;
}

/** How deep a chain of folders may go. The agents column is narrow: past this
 *  the indentation eats the names, and a cap keeps every walk below bounded. */
export const MAX_FOLDER_DEPTH = 8;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 60;

/** null and "main" both mean the commons — one spelling on disk. */
export function folderGroupKey(g: unknown): string | null {
  if (typeof g !== "string" || !g || g === MAIN_GROUP_ID) return null;
  return g;
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.trim().slice(0, NAME_MAX) : "";
  return s || "folder";
}
function cleanIcon(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= 16 ? s : undefined;
}

/**
 * Coerce whatever is on disk (or in a body) into folders whose parent chains are
 * sound: a dangling parent, a parent in ANOTHER group, a loop, or a chain deeper
 * than MAX_FOLDER_DEPTH is re-rooted rather than trusted. Duplicate ids keep the
 * first row.
 */
export function sanitizeFolders(raw: unknown): Folder[] {
  if (!Array.isArray(raw)) return [];
  const out: Folder[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const f: Folder = {
      id,
      name: cleanName(row.name),
      parent: typeof row.parent === "string" && row.parent !== id ? row.parent : null,
      group: folderGroupKey(row.group),
    };
    const icon = cleanIcon(row.icon);
    if (icon) f.icon = icon;
    out.push(f);
  }
  const byId = new Map(out.map((f) => [f.id, f]));
  for (const f of out) {
    const p = f.parent !== null ? byId.get(f.parent) : undefined;
    if (f.parent !== null && (!p || p.group !== f.group)) f.parent = null;
  }
  // Break loops and over-deep chains: walk up; if we revisit or exceed the cap,
  // this folder goes to the root. Re-rooting one node of a loop opens it, so
  // the next folders on it then resolve.
  for (const f of out) {
    const visited = new Set<string>([f.id]);
    let p = f.parent;
    let depth = 1;
    while (p !== null) {
      if (visited.has(p) || depth >= MAX_FOLDER_DEPTH) {
        f.parent = null;
        break;
      }
      visited.add(p);
      depth++;
      p = byId.get(p)?.parent ?? null;
    }
  }
  return out;
}

/** Is `ancestorId` `id` itself or one of its ancestors? (Guards a move into itself.) */
export function isSelfOrAncestor(folders: readonly Folder[], ancestorId: string, id: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur: string | null = id;
  for (let i = 0; cur !== null && i <= folders.length; i++) {
    if (cur === ancestorId) return true;
    cur = byId.get(cur)?.parent ?? null;
  }
  return false;
}

/** Is a folder of group `group` visible to a viewer who sees `visibleGroups`?
 *  Main (null) is everyone's. */
const groupVisible = (group: string | null, visibleGroups: ReadonlySet<string>) =>
  group === null || visibleGroups.has(group);

/** The folders a viewer gets back from `GET /agent-folders`: those of the groups
 *  it can see. A folder's name may mean something ("COMEX"), so a folder of a
 *  group hidden from the viewer stays hidden too. */
export function foldersForViewer(folders: readonly Folder[], visibleGroups: ReadonlySet<string>): Folder[] {
  return folders.filter((f) => groupVisible(f.group, visibleGroups));
}

/**
 * The merge behind `PUT /agent-folders`. The client sends the whole list it
 * knows; it may edit, create and delete only folders of groups it can SEE. A
 * folder of a hidden group is carried through untouched, whatever the body says —
 * a filtered read needs a matching write (invariant 58), or a viewer could
 * delete (by omission) or rename a folder it was never shown. A folder never
 * changes group: its group is fixed at creation.
 */
export function mergeFoldersPut(
  stored: readonly Folder[],
  incoming: unknown,
  visibleGroups: ReadonlySet<string>,
): Folder[] {
  const storedById = new Map(stored.map((f) => [f.id, f]));
  const rows = sanitizeFolders(incoming);
  const incomingById = new Map(rows.map((f) => [f.id, f]));
  const out: Folder[] = [];
  for (const f of stored) {
    if (!groupVisible(f.group, visibleGroups)) {
      out.push(f); // another group's: untouched
      continue;
    }
    const next = incomingById.get(f.id);
    if (!next) continue; // visible and omitted: deleted
    const merged: Folder = { ...f, name: next.name, parent: next.parent };
    if (next.icon) merged.icon = next.icon;
    else delete merged.icon;
    out.push(merged);
  }
  for (const r of rows) {
    if (storedById.has(r.id) || !groupVisible(r.group, visibleGroups)) continue;
    out.push(r);
  }
  // sanitize re-roots a parent that sits in another group (which also covers a
  // parent in a group the caller cannot see).
  return sanitizeFolders(out);
}

/**
 * After folders were removed, every agent filed in a removed one moves to the
 * nearest SURVIVING ancestor (via the OLD tree) — including agents the deleter
 * cannot see, which would otherwise point at a dead id. Returns the agents that
 * changed (id → new folder), so the caller writes only when needed.
 */
export function refileItems(
  items: readonly FiledItem[],
  before: readonly Folder[],
  after: readonly Folder[],
): Map<string, string | null> {
  const alive = new Set(after.map((f) => f.id));
  const oldById = new Map(before.map((f) => [f.id, f]));
  const changes = new Map<string, string | null>();
  for (const it of items) {
    const cur = typeof it.folder === "string" ? it.folder : null;
    if (cur === null || alive.has(cur)) continue;
    let p: string | null = oldById.get(cur)?.parent ?? null;
    for (let i = 0; p !== null && !alive.has(p) && i <= before.length; i++) p = oldById.get(p)?.parent ?? null;
    changes.set(it.id, p !== null && alive.has(p) ? p : null);
  }
  return changes;
}

/**
 * The folder an agent may be filed in: `folder` only when it exists AND lives in
 * the agent's own group — a stale id (deleted, or left over from a move to
 * another group) files it at its group's root instead.
 */
export function channelFolder(folders: readonly Folder[], folder: unknown, group: unknown): string | null {
  if (typeof folder !== "string" || !folder) return null;
  const f = folders.find((x) => x.id === folder);
  return f && f.group === folderGroupKey(group) ? f.id : null;
}
