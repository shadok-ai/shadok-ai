# Agent folders — design

## Problem

A group with many agents is one flat list in the agents column, and people
asked to "group agents inside a group" — sub-groups, nested.

A first version put folders in the groups column (folders of GROUPS). It was
the wrong place: what needs arranging is the agents you look at once you are IN
a group, not the handful of groups in the rail. That version is gone.

A group is not only a label: it is the unit of visibility and, on a
multi-tenant instance, of isolation (its own OS user). Real nested *groups*
would mean deciding whether a parent's members see its children, which OS user a
sub-group runs as — the whole access model. That is not what was asked for.

## Decision: folders are a VIEW, never an ACL

A **folder** is a purely visual container inside one group's agents column. It
holds that group's agents and other folders, nested up to `MAX_FOLDER_DEPTH` = 8.
It changes nothing about who sees or drives an agent, nor which OS user an agent
runs as. Filing an agent in a folder is a cosmetic write, like renaming it.

## Data

- `<store>/folders` (per launch dir, like `groups`):
  `[{id, name, icon?, parent, group}]`. `group` is the group the folder lives in
  (null = Main; "main" is folded to null). `parent` is another folder of the SAME
  group, or `null` (the group's root). A folder never changes group.
- An agent (a `/channels` row) carries an optional cosmetic `folder`. Like
  `group`, a tab sends it only when it filed the agent itself (`groupIsDirty`),
  an omitted key keeps the stored value (`mergeChannels`), and a move made on
  another device is followed on the poll (`reconcileTabGroup`).
  `PUT /channels` checks it names a folder of the agent's own group
  (`channelFolder`), else files the agent at the root.
- Whether a folder is folded is a **per-browser** preference
  (`localStorage`, dir-scoped `cp.folderCollapsed`), not shared state.

Dangling references are resolved, never trusted: an agent whose folder no
longer exists (or belongs to another group after a move) shows at its group's
root; a folder whose parent is missing, in another group, loops, or runs deeper
than the cap is re-rooted (`sanitizeFolders`).

## Visibility (invariant 58: a filtered read needs a matching write)

A folder's NAME can carry meaning ("COMEX"), and the folders file is shared by
everyone on the instance. Since a folder belongs to one group, it is visible
exactly where that group is: `GET /agent-folders` returns the folders of the
groups the viewer can see (`canSeeGroup`), plus Main's.

`PUT /agent-folders` is browser-only + instance-guarded (as `PUT /groups`), and
merges: a viewer may create, edit or delete only folders of groups it can see;
the others are carried through untouched. When a folder is deleted, every agent
filed in it — including ones the deleter cannot see — moves to the nearest
surviving ancestor (`refileItems`), so no agent points at a dead id.

## UI (agents column)

- At each level of a group: its sub-folders (alphabetical), then its agents
  (manual order). A folder's body is indented with a guide line.
- Folder header: caret, icon (📂/📁), name, mood dot + agent count of the whole
  subtree when folded; click folds/unfolds, double-click on the name renames,
  double-click on the icon picks an icon, ＋ makes a sub-folder, × removes it
  (contents move up a level, nothing is lost — no confirmation).
- Drag an agent onto a folder header → it goes inside. Onto another agent → it
  sits beside it (in that agent's folder). Drag a folder onto a folder header →
  nested; onto an agent or the group's empty space → beside it / to the root. A
  folder can't leave its group, nor go into itself or a descendant.
- "📁 new folder" sits under "＋ new agent" and creates in the group on screen
  (Main on a phone, which has no groups column).
- A folded folder that holds the agent on screen is outlined, so the selection
  is never lost from sight.

The DOM stays the source of truth for ORDER (as before for groups and tabs);
`layoutFolders` only nests it, and is a no-op when the column already matches —
so it runs on every repaint of the column.
