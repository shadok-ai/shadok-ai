# Per-tab composer draft

Date: 2026-07-20 · Status: approved

## Problem

The composer textarea (`#promptInput`) is shared by every channel tab. Text
typed for one channel stays visible (and can be sent) when switching to
another channel, and there is no notion of a per-channel draft.

## Design

All changes live in `public/index.html`; no server change.

- Each `tab` object gains a `draft` string (default `""`).
- `activate(tab)` saves `promptInput.value` into the previously active tab's
  `draft`, then restores the new tab's `draft` into the textarea (with the
  auto-height recomputed).
- The textarea `input` listener mirrors the value into `active.draft` and
  persists it (lightly debounced) to `localStorage` under `cp.drafts`, an
  object keyed by session id — same model as `cp.names`.
- A successful submit clears the textarea, the tab's `draft`, and the
  `cp.drafts` entry.
- On session `ready`, when the session id becomes known, a persisted draft is
  restored into the tab if it has no in-memory draft yet (covers the
  restore-channels-on-load path, where session ids only arrive with `ready`).
  Drafts of tabs without a session id (still in setup) stay in memory only.
- Closing a tab deletes its `cp.drafts` entry: closing means abandoning the
  draft.
