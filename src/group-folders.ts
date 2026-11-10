/**
 * Group folders: a purely VISUAL arrangement of the groups rail — folders that
 * hold groups and other folders. Never an ACL: a folder changes nothing about
 * who sees or drives an agent, nor which OS user it runs as (a group's nature
 * owns that, src/groups.ts). See docs/superpowers/specs/2026-11-10-group-folders-design.md.
 *
 * Pure and dependency-free, so the whole merge/visibility rule is unit-tested.
 */

export interface Folder {
  id: string;
  name: string;
  icon?: string;
  /** Another folder's id, or null for the root. */
  parent: string | null;
  /** The account that made it (null in mono-tenant, where nobody signs in). */
  createdBy?: string | null;
}

/** A group as far as folders care: its id and the folder it is filed in. */
export interface FiledGroup {
  id: string;
  folder?: string | null;
}

/** How deep a chain of folders may go. A rail is ~190px wide: past this the
 *  indentation eats the names, and a cap keeps every walk below bounded. */
export const MAX_FOLDER_DEPTH = 8;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 60;

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
 * sound: a dangling parent, a loop, or a chain deeper than MAX_FOLDER_DEPTH is
 * re-rooted rather than trusted. Duplicate ids keep the first row.
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
    };
    const icon = cleanIcon(row.icon);
    if (icon) f.icon = icon;
    if (typeof row.createdBy === "string") f.createdBy = row.createdBy;
    else if (row.createdBy === null) f.createdBy = null;
    out.push(f);
  }
  const byId = new Map(out.map((f) => [f.id, f]));
  for (const f of out) if (f.parent !== null && !byId.has(f.parent)) f.parent = null;
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

/**
 * Which folders a viewer may see: those with at least one VISIBLE group anywhere
 * under them, plus the ones the viewer created (so a fresh, empty folder shows to
 * its maker). A folder's name may mean something ("COMEX"), and the file is shared
 * by the whole instance, so a folder that only holds groups hidden from the viewer
 * stays hidden too. `visibleGroups` is the caller's already-filtered group list.
 */
export function visibleFolderIds(
  folders: readonly Folder[],
  visibleGroups: readonly FiledGroup[],
  viewerName: string | null,
): Set<string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Set<string>();
  for (const g of visibleGroups) {
    let cur = typeof g.folder === "string" ? g.folder : null;
    for (let i = 0; cur !== null && byId.has(cur) && !out.has(cur) && i <= folders.length; i++) {
      out.add(cur);
      cur = byId.get(cur)!.parent;
    }
  }
  for (const f of folders) if ((f.createdBy ?? null) === viewerName) out.add(f.id);
  return out;
}

/** The folders a viewer gets back from `GET /group-folders`. A visible folder
 *  whose parent is hidden from the viewer shows at its root, never under a hole. */
export function foldersForViewer(
  folders: readonly Folder[],
  visibleGroups: readonly FiledGroup[],
  viewerName: string | null,
): Folder[] {
  const vis = visibleFolderIds(folders, visibleGroups, viewerName);
  return folders
    .filter((f) => vis.has(f.id))
    .map((f) => ({ ...f, parent: f.parent !== null && vis.has(f.parent) ? f.parent : null }));
}

/**
 * The merge behind `PUT /group-folders`. The client sends the whole list it
 * knows; it may edit, create and delete only folders it can SEE (`visible`).
 * A folder hidden from it is carried through untouched, whatever the body says —
 * a filtered read needs a matching write (invariant 58), or a viewer could
 * delete (by omission) or rename a folder it was never shown.
 */
export function mergeFoldersPut(
  stored: readonly Folder[],
  incoming: unknown,
  visible: ReadonlySet<string>,
  actor: string | null,
): Folder[] {
  const storedById = new Map(stored.map((f) => [f.id, f]));
  const rows = sanitizeFolders(incoming);
  const incomingById = new Map(rows.map((f) => [f.id, f]));
  const out: Folder[] = [];
  for (const f of stored) {
    if (!visible.has(f.id)) {
      out.push(f); // hidden from the caller: untouched
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
    if (storedById.has(r.id)) continue;
    const f: Folder = { id: r.id, name: r.name, parent: r.parent, createdBy: actor };
    if (r.icon) f.icon = r.icon;
    out.push(f);
  }
  // A visible folder may not be parked under one the caller cannot see: that
  // would hide the caller's own folder from them, and file it inside someone
  // else's arrangement. New ids are fine (just created by this caller).
  const created = new Set(rows.filter((r) => !storedById.has(r.id)).map((r) => r.id));
  for (const f of out) {
    if (f.parent === null || !(visible.has(f.id) || created.has(f.id))) continue;
    if (!(visible.has(f.parent) || created.has(f.parent))) f.parent = storedById.get(f.id)?.parent ?? null;
  }
  return sanitizeFolders(out);
}

/**
 * After folders were removed, every group filed in a removed one moves to the
 * nearest SURVIVING ancestor (via the OLD tree) — including groups the deleter
 * cannot see, which would otherwise point at a dead id. Returns the groups that
 * changed (id → new folder), so the caller writes only when needed.
 */
export function reparentGroups(
  groups: readonly FiledGroup[],
  before: readonly Folder[],
  after: readonly Folder[],
): Map<string, string | null> {
  const alive = new Set(after.map((f) => f.id));
  const oldById = new Map(before.map((f) => [f.id, f]));
  const changes = new Map<string, string | null>();
  for (const g of groups) {
    const cur = typeof g.folder === "string" ? g.folder : null;
    if (cur === null || alive.has(cur)) continue;
    let p: string | null = oldById.get(cur)?.parent ?? null;
    for (let i = 0; p !== null && !alive.has(p) && i <= before.length; i++) p = oldById.get(p)?.parent ?? null;
    changes.set(g.id, p !== null && alive.has(p) ? p : null);
  }
  return changes;
}
