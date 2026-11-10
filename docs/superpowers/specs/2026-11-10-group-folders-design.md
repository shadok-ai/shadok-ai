# Group folders — design

## Problem

The groups column (the "rail") is flat: one row per group. With many groups
there is no way to arrange them, and people asked for "groups of groups".

A group is not only a label: it is the unit of visibility and, on a
multi-tenant instance, of isolation (its own OS user). Nesting *groups* would
mean deciding whether a parent's members see its children, whether a private
group may live inside a public one, which OS user a sub-group runs as — the
whole access model. That is not what was asked for.

## Decision: folders are a VIEW, never an ACL

A **folder** is a purely visual container in the rail. It holds groups and
other folders, nested to any depth (capped at `MAX_FOLDER_DEPTH` = 8). It
changes nothing about who sees or drives an agent, nor which OS user an agent
runs as. Moving a group into a folder is a cosmetic write, like its icon.

## Data

- `<store>/folders` (per launch dir, like `groups`): `[{id, name, icon?, parent, createdBy?}]`.
  `parent` is another folder's id or `null` (root).
- A group carries an optional cosmetic `folder` (a folder id or null), merged by
  `PUT /groups` like `icon` / `collapsed` / `order`.
- Whether a folder is folded is a **per-browser** preference
  (`localStorage`, dir-scoped `cp.folderCollapsed`), not shared state: one
  person folding a folder must not fold it for everyone.

Dangling references are resolved, never trusted: a group whose folder no longer
exists sits at the root; a folder whose parent no longer exists, or whose parent
chain loops or runs deeper than the cap, is re-rooted (`sanitizeFolders`).

## Visibility (invariant 58: a filtered read needs a matching write)

A folder's NAME can carry meaning ("COMEX"), and the folders file is shared by
everyone on the instance. So `GET /group-folders` returns a folder only when the
viewer can see at least one group somewhere under it, or created it. In
mono-tenant (no accounts) every folder has the same `createdBy: null` as every
viewer, so everything is visible, as before.

`PUT /group-folders` is browser-only + instance-guarded (as `PUT /groups`), and
merges: a viewer may edit or delete only the folders it can see; folders hidden
from it are carried through untouched. When a folder is deleted, every group
filed in it — including ones the deleter cannot see — moves to the nearest
surviving ancestor (`reparentGroups`), so no group is stranded on a dead id.

## UI (desktop rail)

- Each level lists its sub-folders (alphabetical) then its groups (manual order).
  Rows are indented by depth.
- Folder row: caret, icon (📂/📁), name, aggregate mood dot + agent count of the
  whole subtree; click folds/unfolds, double-click on the name renames,
  double-click on the icon picks an icon, ＋ makes a sub-folder, × removes it
  (contents move up a level, nothing is lost — no confirmation).
- Drag a group or folder onto a folder → it goes inside. Onto a group row → it
  becomes that group's sibling. Onto "Main" → root. A folder can't go into
  itself or a descendant.
- "＋ new folder" sits under "＋ new group".
- A folded folder that contains the group on screen is outlined, so the
  selection is never lost from sight.

The phone layout (no rail) is unchanged: folders are a desktop arrangement.
