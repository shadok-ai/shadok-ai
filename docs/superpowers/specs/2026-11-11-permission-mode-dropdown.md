# Permission-mode dropdown in the version menu

**Date:** 2026-11-11
**Status:** implemented

## Problem

The version menu offered a single **Auto mode** checkbox that flipped the
instance-wide spawn permission mode between `auto` and `default`. The server
(`POST /permission-mode`, `src/profiles.ts` `PERMISSION_MODES`) already accepted
every real `claude --permission-mode` value — `acceptEdits`, `auto`,
`bypassPermissions`, `manual`, `dontAsk`, `plan` — but the UI could not reach
them. In particular there was no one-click way to run agents with **zero
permission prompts** (`bypassPermissions`, the equivalent of
`--dangerously-skip-permissions`), which an operator explicitly wanted.

## Decision

Replace the checkbox with a **Permissions `<select>`** in the version menu,
exposing the useful autonomy ladder:

| value | label | meaning |
|---|---|---|
| `default` | Ask before each action | Claude's own default (no flag) |
| `acceptEdits` | Auto-apply edits | auto-apply file edits, ask for the rest |
| `auto` | Auto mode — no prompts | Shift+Tab auto mode; classifier still guards risky ops |
| `bypassPermissions` | Bypass — 0 questions ⚠️ | NO permission checks at all |

Only these four are listed (the common ladder). `manual` / `dontAsk` / `plan`
stay reachable via the API/config; if the instance is on one of them, the select
renders a transient read-through option (`data-extra`) so the menu reflects
reality instead of snapping to a mode nobody chose.

## Why bypass is gated, not just offered

Agents are **not sandboxed** — they run as the same OS user and read untrusted
content (web pages, cloned repos, Telegram messages). In `bypassPermissions` a
prompt injection can run any command with no barrier. So the UI:

- paints the hint **red** (`.vm-hint.danger`) whenever `bypassPermissions` is the
  selected mode, and
- asks for an explicit `confirm()` before switching **into** it (same native
  confirm the rest of the cockpit uses for End agent / Restart all); cancel
  reverts the select.

The server side is unchanged and already correct: `POST /permission-mode` is
**admin-only** (`accountAdmin`), validates via `isPermissionMode`, persists to
`config.json`, and broadcasts the new `version` state to every client. The
change only affects agents spawned *after* it; a running agent keeps its launch
mode.

## Scope

UI-only (`public/index.html`): the select markup, a `.vm-hint.danger` rule, and
`renderPermMode()` (shared by `renderVerMenu` and the change handler). No server,
protocol, or test-contract change. The profile `deny`/`allow` guardrails remain a
separate, independent layer from the permission mode.

## Verified

- `tsc` clean; `test/csp`, `test/esm-bridge`, `test/ws-url`, `test/profiles`,
  `test/route-guards` green.
- Headless Chromium against a bench instance: no console errors; the four options
  render with the right labels and hints; the hint turns red only on
  `bypassPermissions`; the confirm-gated switch round-trips through the real
  `POST /permission-mode`.
