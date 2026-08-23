# Draggable tabs and tab groups — design

Date: 2026-07-20
File concerned: `public/index.html` (the whole UI lives there).

## Goal

In the "Channels" sidebar:
1. Reorder the tabs (channels) by drag & drop.
2. Create named groups, drag tabs into them, rename them, collapse them.
3. Reorder the groups themselves by dragging their header.

User decisions: creation via a "+ new group" button, collapsible groups,
reorderable groups.

## DOM structure

```
nav#tabbar
  .label.side-label            (unchanged)
  div#ungrouped                ← tabs outside any group
  div#groups                   ← one div.group per group
    div.group[data-gid]
      div.group-head           (draggable, click = collapse, dblclick = rename, × = dissolve)
        span.caret  span.gname  span.gclose
      div.group-body           ← the group's tabs (hidden when collapsed)
  button#newTab                (unchanged)
  button#newGroup              "+ new group"
```

`createTab()` adds the tab to `#ungrouped` by default (or to the group named
during a restore).

## Drag & drop

Native HTML5 (`draggable`), a "live sort" pattern: during `dragover` the dragged
element is moved directly in the DOM (no separate indicator).

- A dragged tab: over another tab → inserted before/after depending on the
  vertical half; over a group header → added to the group (a collapsed group
  expands automatically); over an empty area (`#ungrouped` or an empty
  `.group-body`) → added to that area.
- A dragged group (by its header): over another group → inserted before/after.
- During a drag, empty areas become visible (dashed border, min-height) via a
  class on `body`.
- `dragend` always persists (the `drop` may not fire).
- `draggable` is disabled during an inline rename (otherwise selecting text
  starts a drag).

## Persistence (localStorage, like the existing code)

- `cp.groups`: `[{ id, name, collapsed }]` in DOM order.
- `cp.channels`: each entry gains `group: <id|null>`; the list's order = the
  tabs' DOM order (the source of truth read at persist time, not maintained in
  the `tabs` array).

On load: recreate the groups, then the channels inside their group (a vanished
group → `#ungrouped`). Empty groups are kept.

## Related behaviours

- Dissolving a group (×): its tabs are moved into `#ungrouped` and the group is
  removed (no session is closed).
- Collapsing: hides `.group-body`; the active tab may become hidden, the
  transcript stays displayed.
- Renaming a group: the same inline pattern as renaming a tab.

## Out of scope

No group colour, no context menu, no server sync (purely local persistence, like
the channel names).

## Verification

No test infrastructure in the project (`npm test` = a placeholder). Manual
verification: `npm run build && npm run web`, then in the browser — reorder,
create/rename/collapse/dissolve/reorder groups, reload the page and check the
restore.
