# Design — Decluttering the top bar (icon buttons + a ⋯ menu)

Date: 2026-07-28
Status: agreed (brainstorming)

## Problem

The header piles up too many text buttons on the right (🔔, Diff, Terminal,
Secrets, Profiles, ⏰ Schedule, Telegram, End session) → it overflows on windows
that are not very wide.

## Decisions (from the user)

- Turn the buttons into **icons** (the `title` tooltip kept for discoverability).
- **Diff** (never used) → tucked into a **⋯** menu (non-destructive, extensible).
- **Secrets** and **Profiles** → stay visible, as icons.

## Scope

Frontend only (`public/index.html`). No server change. The **button IDs are
kept** → every existing `addEventListener` handler stays wired; only the label
changes (→ an icon) and Diff gets wrapped in a menu.

## Design

The bar, on the right (after the 5h/7d quota gauges):

| Button (id unchanged) | Before | After |
|---|---|---|
| `toggleMachine` | Terminal | `⌨️` |
| `secretsBtn` | Secrets | `🔑` |
| `profilesBtn` | Profiles | `👤` |
| `cronBtn` | ⏰ Schedule | `⏰` |
| `telegramBtn` | Telegram | `✈️` |
| `muteNotif` | 🔔 | `🔔`/`🔕` (unchanged) |
| `moreBtn` (new) | — | `⋯` → menu |
| `stopBtn` | End session | `⏹️` (class `.stop`, alert tint on hover) |

Every icon button carries an explicit `title`.

**The ⋯ menu**: `#moreBtn` opens `#moreMenu` (absolute, under the button, right
aligned, `--bg-raised` background, `--line` border). Initial content: the **Diff**
button (`toggleDiff`, behaviour unchanged — toggles the diff panel). Closes on an
outside click and after an item is selected. Extensible (future rare settings).

### CSS

- `header button.icon`: reduced padding (`6px 8px`), `font-size: 14px`,
  `line-height: 1` for regular icon squares.
- `.more-wrap { position: relative }`; `#moreMenu` as an absolute dropdown,
  `z-index` above the content.
- `header button.stop:hover { border-color: var(--err); color: var(--err) }`.

### JS

- `#moreBtn` click → toggles `#moreMenu.hidden` (+ `stopPropagation` so it does
  not close again immediately).
- `document` click → closes `#moreMenu` (outside click; a click on an item
  bubbles up to the document → closes the menu, and the item's action still
  runs).

## Success criteria

1. The bar fits without overflowing: compact icons + a single `⋯`.
2. Every icon keeps its action (IDs unchanged) and shows its tooltip.
3. `⋯` opens/closes a menu containing Diff; Diff still toggles the panel.
4. The menu closes on an outside click and after clicking Diff.
5. `⏹️` (stop) stays visually distinct (alert tint on hover).
6. Frontend only, no asset added (emoji), no server change.

## Out of scope

Reworking the left-hand side (Status/Directory/Session/Branch), advanced
responsive work, custom SVG icons. We stay with emoji + a simple menu.
