# Agent creation box — profile-first

Date: 2026-07-29
Status: agreed, ready for an implementation plan

## Problem

The creation box (`#setup`, `public/index.html`) is a flat form of six blocks.
Three concrete defects:

1. **The profile is invisible.** Yet it is *the* structuring choice (role,
   guardrails, secrets, model), and it is reduced to a thin `<select>` placed
   second to last, after the worktree.
2. **The box overflows.** `#liveField` ("Agents running now") and `#recoverField`
   ("Reopen an unfinished session") are unfolded as soon as they have one item
   and push the Start button off screen. On mobile it is unreadable.
3. **The vocabulary lies.** The UI says "channel" / "new link" while the user's
   mental object is an **agent**.

And two more discreet traps:

- No shortcut from the box to editing profiles: you have to aim for the top bar's
  `Profiles` button, outside the creation flow.
- In `continue` / `resume` mode, the profile and the worktree stay active on
  screen but are **silently ignored** (`startActiveTab`, line ~2288: both are
  only set `if (mode === "new")`).

## Scope

Only the visible copy and the creation box. The WS protocol, the endpoints,
`src/channels.ts` and the persistence (`~/.shadok-ai/channels/`) do not change.
The `start` message keeps its `profile` field.

## 1. Renaming — UI copy only

| Where | Before | After |
|---|---|---|
| `nav .side-label` | `Channels` | `Agents` |
| `#newTab` | `＋ new channel` | `＋ new agent` |
| `#newTab[title]` | `New channel` | `New agent` |
| `#newGroup[title]` | `New tab group` | `New agent group` |
| `#setup h1` | `New link` | `New agent` |
| `#setup p.hint` | the "channel" text | rewritten around "agent" |
| `#startBtn` | `Start session` | `Start agent` |
| `src/telegram.ts` (`/tools`, `/cron` help) | "this channel" | "this agent" |

Code identifiers, file names, the `/channels` `/groups` endpoints,
`localStorage` keys and the main channel's forced `general` name: **unchanged**.
The renaming is cosmetic by construction, hence carries no risk of a persistence
regression (invariant 6 of `CLAUDE.md`).

## 2. The box's structure

```
New agent
A real Claude Code session, driven from here. Start as many agents as
you want working in parallel.

Which agent?                              ✎ edit profiles
┌──────────────┐ ┌──────────────┐
│ Shadok-dev   │ │ Shadok-Market│
│ senior soft… │ │ paid-market… │
│ [full access]│ │ [read-only]  │
└──────────────┘ └──────────────┘
┌──────────────┐ ┌──────────────┐
│ Shadok-Suppo │ │ ∅ No profile │
│ [read-only]  │ │ plain Claude │
└──────────────┘ └──────────────┘

Working directory  [/path/to/project                ]
☑ Isolate in a git worktree

▸ Advanced — resume an existing session
▸ Reopen a past session  (3)
▸ Agents running now  (1)

                              [ Start agent ]
```

The order: **who** (profile) → **where** (directory, worktree) → the rare stuff,
folded → the action.

### The three `<details>`

`#advancedField`, `#recoverField` and `#liveField` become `<details>` **closed by
default**, a single, predictable rule. The `<summary>` carries a counter (`(3)`)
rendered in amber when non-zero, so the "there is something here" information
survives the folding. The lists keep their current rendering and `max-height`.

`#advancedField` contains the existing Resume block as is: the `radio-row`
(`new session` / `latest in directory` / `by id`), `#resumeInput` and
`#sessionList`. The default mode stays `new`.

A corollary: `refreshLiveList` / `refreshRecoverList` no longer drive
`field.hidden` but the `<summary>`'s counter and the `<details>`'s presence — a
`<details>` with no item stays hidden as it does today.

### Mode ≠ `new`

When the mode switches to `continue` or `resume`, the profile grid and the
worktree checkbox take a `.na` class (`opacity:.45; pointer-events:none`) and a
one-line note "applies to new sessions only". `startActiveTab` keeps its current
logic — the UI simply stops lying.

## 3. Profile cards

A CSS grid `repeat(auto-fill, minmax(150px, 1fr))`, gap 8px. Each card is a
`<button role="radio">` inside a `role="radiogroup"` container: selection on
click, arrow-key navigation, Space/Enter activation, `aria-checked` kept up to
date. Selected = border and name in amber (`--amber`), like the rest of the
theme.

The content, **entirely derived from the existing `Profile` type** (no field
added to `src/profiles.ts`):

- **Name**: `profile.name`, mono font.
- **Blurb**: the first sentence of `systemPrompt`, stripped of the
  `You are <name>, ` / `You are <name> — ` prefix, truncated at ~90 characters
  with `…`, clamped to 2 lines in CSS. Empty when there is no `systemPrompt`.
- **Badges**: `read-only` when `deny?.length` (else `full access`), the model's
  name when `model` is set, `N secrets` when `secrets?.length`.

An `∅ No profile` card (subtitle "plain Claude") always closes the grid; it is
the default on first use, equivalent to today's `<option value="">`.

### A pure, testable module

`profileBlurb(profile)` and `profileBadges(profile)` go into
`public/profile-card.js` — the same pattern as `public/live-text.js`: an ESM
imported by the browser *and* by `test/profile-card.test.ts`. The DOM rendering
stays in `index.html`.

Cases covered by the tests: the `You are X,` prefix removed; no `systemPrompt` →
an empty blurb; a very long sentence → truncation with `…` without cutting
mid-word; empty `deny` → `full access`; non-empty `deny` → `read-only`; a
`secrets` of 1 → `1 secret` (singular); no `model` → no model badge.

## 4. Editing shortcuts

- **`✎ edit profiles`**, right-aligned with the "Which agent?" title, opens the
  existing `#profilesOverlay` (the same path as `#profilesBtn`).
- **A `✎` per card**, visible on hover/focus, opens the overlay **prefilled** on
  that profile through `fillProfileForm(p)`. `stopPropagation` so the card is not
  selected on the way.
- On **closing** the overlay (✕, Escape, a click on the backdrop), the grid
  re-renders from `profileCache`: a created profile appears immediately, the
  current selection is kept when the profile still exists, otherwise it falls
  back to `No profile`.
- **Zero profiles**: a single full-width card "Create your first profile →" that
  opens the empty overlay. Today you land on a mute `(none)`.

## 5. Remembering the last profile

When an agent starts, the chosen profile is written to
`localStorage["cp.profile:" + cwd]`. When the box opens (and on every change of
`#cwdInput`, which already refreshes the recover list), the matching card is
preselected; failing that, `cp.profile` (the last profile used, across all
directories); failing that, `No profile`. A remembered profile that no longer
exists is ignored silently.

The intended effect: the common case becomes **one click + Start**.

## 6. Errors

A failed `GET /profiles`, or a non-array response → the grid shows a
`couldn't load profiles` line and **the `No profile` card stays present and
selectable**, so an agent can still be started. That is already
`loadProfilesInto`'s defensive behaviour (`catch { profileCache = [] }`); we make
it visible.

## 7. Out of scope

Deliberately set aside, to be reopened if the need is confirmed:

- A quick-spawn menu on hovering `＋ new agent` (choosing a profile without
  opening the box).
- Colours / emoji per profile — that would take new fields on `Profile` and a
  form to fill in for the existing profiles.

## Verification

`npm run build`, `npm test`, then a check in the browser on a local build (see
"Running YOUR build" in `CLAUDE.md` — do not start a second server). To check by
eye: the whole box visible without scrolling on a short window, keyboard
selection, the overlay opening from both shortcuts, the remembered profile on the
second agent launched in the same directory.
