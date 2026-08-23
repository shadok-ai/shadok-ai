# Design — Notifications: favicon badge + title badge + sound

Date: 2026-07-28
Status: agreed (brainstorming)

## Problem

When a background agent asks for attention (it is **blocked** on a
question/permission) or has produced an unread answer, nothing signals it at the
browser level: the cockpit tab may be hidden or on another channel. We want a
passive signal (favicon + title) and an active one (sound) for the urgent cases.

## Scope

Frontend only (`public/index.html`). No server change. Everything hangs off
`setTabMood(tab, mood)` — the single crossing point every channel state change
already goes through ("working" | "needs-answer" | "unread" | null).

## Triggers

- **needs-answer** = an agent is **blocked** waiting for a decision (a TUI
  dialog: a choice, a permission, "continue?"). Urgent.
- **unread** = a background channel **finished** a turn (an unread answer). Info.

Differentiated handling (the user's choice):

| Signal | needs-answer | unread |
|---|---|---|
| Favicon badge | ✅ **red** dot | ✅ **amber** dot (when no needs-answer) |
| Title badge (`● `) | ✅ | ✅ |
| Sound (chime) | ✅ **when you are not already watching** that channel | ❌ |

"You are not already watching" = `document.hidden` (browser tab hidden) **or**
the channel concerned is not the active one (`tab !== active`). The sound only
plays on the **transition** into needs-answer (not on every re-render).

## Components (a `notify` module, self-contained in index.html)

- `faviconSVG(dot)` → an SVG data-URI: the base mark (an amber `›` chevron on a
  dark `#14161d` background, rounded corners) + a coloured `dot` in the corner
  when given. No binary asset.
- `attentionColor()` → walks `tabs`: red (`--err` #e07a6a) when a channel is in
  needs-answer; else amber (`--amber` #f0a848) when a channel is unread; else
  `null`. (needs-answer wins.)
- `refreshBadge()` → sets `favicon.href = faviconSVG(color)` and
  `document.title = (color ? "● " : "") + titleBase`. `titleBase` is the current
  title without the badge (maintained by the existing token counter).
- Sound: the Web Audio API, a 2-note chime (880 Hz → 1320 Hz, ~160 ms envelope),
  no file. `ding()` honours the mute. The AudioContext is **unlocked** on the
  first user gesture (pointerdown/keydown) — the browsers' autoplay constraint.
- Mute: a `🔔`/`🔕` button in the header, the preference persisted
  (`localStorage["cp.muteNotif"]`).

## Integration points

- `<head>`: add `<link rel="icon" id="favicon">`.
- `setTabMood`: remembers the previous needs-answer state, applies the classes,
  then (transition into needs-answer + not being watched) → `ding()`, and in all
  cases → `refreshBadge()`.
- The token counter (which already updates `document.title`): now writes into
  `titleBase` and calls `refreshBadge()` (the badge survives token updates).
- Header: the mute button + its handler.

## Success criteria

1. A channel goes needs-answer while the tab is hidden / another channel is
   active → red dot on the favicon, `● ` in the title, **one** chime.
2. A channel goes unread in the background → amber dot on the favicon + `● ` in
   the title, **no** sound.
3. Watching the channel (making it active / coming back to the tab) clears its
   state → `refreshBadge()` removes the dot/title once nothing is waiting.
4. Mute `🔕` → no more sound; the preference survives a reload.
5. No sound when you are already watching the channel that is asking.
6. The badge coexists with the token counter in the title.
7. Frontend only; the favicon as an SVG data-URI (no asset added).

## Out of scope (YAGNI)

Native OS notifications (the Notification API), a numeric counter in the badge,
customisable sounds. We keep favicon + title + one chime + mute.
