# Blinking notifications + per-channel mute

**Date:** 2026-07-29
**State:** agreed, to be implemented

## The problem

Since `666a62b` the cockpit already signals that a channel wants attention: a
coloured pip on the favicon, a `●` prefix in the title, and a sound when an agent
blocks on a question. The signal is **static**. In a window loaded with twenty
tabs, a motionless 7 px pip on a 16 px icon goes unnoticed: the agent waits, and
nobody comes.

Symmetrically, there is no way to silence **one** channel. An agent asking
questions in a loop, or a chatty cron, pollutes the global signal — and the only
recourse today is the header's 🔔 button, which mutes the sound for everyone and
touches neither the pip nor the title.

## What we build

1. The attention badge **blinks** when something really demands an action, and
   only then.
2. Each channel can be **muted** individually, persistently.
3. A **context menu** on the tab, hosting the mute and two already existing
   actions.

## A. The blinking

### Trigger condition

> **Fixed on 2026-07-30.** v1 read `document.hidden` alone, and therefore
> **never** blinked in real use: `document.hidden` stays false as long as the
> window is displayed, even when another application has focus — and that is
> exactly how the cockpit is used (a window open on a screen, the user in their
> terminal). The trigger is now `away = document.hidden || !document.hasFocus()`,
> a superset. Verified in the browser, not only in unit tests.

The badge blinks if and only if:

- **you are not on the page** — hidden tab, minimised window, or a visible window
  without focus;
- **and** at least one **unmuted** channel is in `needs-answer`.

An unread answer (`unread`) does not blink: it keeps the steady amber pip.
Blinking means "something must be done", not "something happened".

### What blinks

The favicon's pip **and** the title's prefix, on the same tick (~900 ms). The
favicon counts at least as much as the title: a background tab in a loaded window
is reduced to its icon, and the title is no longer readable.

### Both phases stay visible

The alternation does **not** go from "badge" to "nothing". It goes from one
visible state to another:

| Phase | Favicon pip | Title |
|---|---|---|
| high | `#e07a6a` (bright red) | `● ` |
| low | `#8a4034` (dark red) | `◉ ` |

**Why:** Chrome throttles a hidden tab's timers — clamped to 1 s, then *intensive
throttling* down to one wake per minute after ~5 min. With an on/off, a timer
frozen on the "off" phase would leave the page perfectly calm while an agent
waits: the signal would disappear exactly when it is needed most. With two
visible phases, the worst case is a slow blink. That degradation must be checked
in a real browser, not inferred.

### The timer's life cycle

No timer runs when nothing blinks. `refreshBadge()` starts or stops the loop
depending on the condition above; a `visibilitychange` listener re-evaluates it.
Coming back to the tab stops the blinking immediately and restores the static
badge — not on the next tick.

## B. Per-channel mute

### State and persistence

A `muted` boolean carried by the tab on the client side, persisted in the server
registry through the `Channel.muted` field (`src/channels.ts`). It is a
**client-driven** field, like `name` and `group`: it therefore does **not** join
`SERVER_OWNED`, and a PUT from the browser is authoritative over it. The intended
consequence: the mute survives a reload and follows the other devices.

### Effect

- `attentionColor()` ignores muted channels → no pip, no `●`, no blinking.
- The `ding()` triggered from `setTabMood` is skipped for a muted channel.
- The tab **keeps** its own state colour (`working` / `needs-answer` / `unread`):
  muting cuts the global signals, it does not make the channel invisible.
- A discreet 🔕 shows next to a muted channel's name, so the silence is
  explainable rather than suspicious.

## C. The context menu

Right-click on a tab → a small floating menu positioned at the cursor, modelled
on `#verMenu`: same style, same closing logic (a click elsewhere, Escape, or
choosing an entry). The browser's native menu is suppressed on the tab only.

v1's entries:

| Entry | Behaviour |
|---|---|
| 🔕 Mute / 🔔 Unmute | toggles `muted`, persists, refreshes the badge |
| Rename | reuses `inlineRename` (the existing double-click stays) |
| Close agent | the existing ✕'s action; absent on `general` |

The menu is where the next per-channel actions will go — that is half its value.

## D. Split and tests

The notification decision is extracted into the pure module `public/notify.js`:

```js
notifyState(channels, { hidden, phase }) → { color, badge, blink }
```

`channels` is a list of `{ mood, muted }` — the module knows nothing of the DOM
or of tabs. It is loaded by the browser **and** imported by
`test/notify.test.ts`, exactly like `live-text.js` and `profile-card.js`.

Cases covered by the tests:

- an unmuted `needs-answer` channel, tab hidden → `blink: true`, red;
- the same, tab visible → `blink: false`, steady red;
- the same, **muted** → no colour, no blinking;
- `unread` alone → amber, never blinking;
- a muted `needs-answer` + an unmuted `unread` → steady amber (the muted one does
  not surface);
- all muted → `color: null`;
- both phases return a non-null colour when `blink` is true (that is the
  invariant protecting against a throttled timer).

**Gotcha #10 of CLAUDE.md:** the `<script type="module">` that exposes the
function on `window` runs after the document is parsed, while the classic script
runs during it. Any call at load time must wait for `DOMContentLoaded` or guard
on `window.notifyState` — otherwise the failure is silent.

## Out of scope

- System notifications (the `Notification` API): the badge + the sound are enough
  for now, and the browser permission is a subject of its own.
- Muting on the Telegram side: the bridge has its own silence rules.
- A temporary mute ("for 1 h"): to be considered only if the permanent mute turns
  out to be too coarse in use.
