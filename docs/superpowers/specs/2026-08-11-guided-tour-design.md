# Guided tour: a welcome screen and a spotlight walk through the cockpit — design

Date: 2026-08-11 · Status: approved

## Goal

Someone opening shadok-ai for the first time sees a dark cockpit with an empty
middle, a column of two buttons, and six unlabelled icons in the header. Nothing
is wrong, and nothing tells them where to start.

This adds a **welcome screen** explaining what shadok-ai is, followed by a short
**spotlight tour** that points at the real controls — with a skip that means
skip, and a way to replay it later.

## Out of scope

- **A first-boot machine report** ("Claude signed in as X, SSH key generated,
  tmux detected"). Considered and dropped: the welcome screen teaches the
  *concept*, which is what a newcomer lacks. A status report answers a different
  question ("what is running here"), and the sign-in card already handles the one
  state that actually blocks work.
- **Tooltips or a help mode.** The controls already carry `title` attributes.
- **Any change to what the buttons do.** This feature only points at them.

## Design

### The sequence — six screens, five spotlights

Grouped deliberately: a spotlight can frame a **region**, not just one control,
which covers nine landmarks in four stops. A tour with a step per button is a
tour people abandon.

| # | Screen | Target |
|---|---|---|
| 1 | **Welcome** — every agent is a real Claude Code session, in its own directory and branch, driven from here or from Telegram | `null` (centred card) |
| 2 | **The agents column** — create an agent, group them, and the *Tweak Shadok-AI* card at the bottom | `#tabbar` |
| 3 | **An agent's tab and its ⋯ menu** — mute, reload, rename, change profile, mirror to Telegram, close | `.tab.active` |
| 4 | **Scheduled prompts and the guard** — a recurring prompt plus a shell check that runs *without the model*: silent means the agent is never woken, at zero tokens | `.tab.active` |
| 5 | **The toolbar** — 🔑 secrets, 👤 profiles, Telegram, 🔔 notifications, ⋯ diff | `.hdr-tools` |
| 6 | **The quota dials** — 5h / 7d usage and the pace guard; the bubble also *names* the version badge next to the cockpit name (`#verView`) rather than spotlighting it | `["#quota5h", "#quota7d"]` |

**Step 4 breaks the grouping rule on purpose, and it is the one exception.**
Everything else in the tour is a landmark; a schedule is the reason to open the
cockpit again tomorrow. It shipped as the last clause of the toolbar step —
sixth in a list of six — so the single capability no competing cockpit has was
the least prominent sentence in the tour, and a first-time visitor met agents, a
menu, a toolbar and a gauge, all of which the alternatives also have, then left
without meeting this one.

It reuses step 3's target rather than pointing at something of its own, because
that is where it genuinely lives: inside an agent's ⋯ menu. Two consecutive
stops on the same rectangle is the cost of not opening a menu on the visitor's
behalf mid-tour. `test/tour-steps.test.ts` locks the order — this step must
follow the one that introduced the menu, or the bubble refers to a ⋯ nobody has
been shown yet.

`target` is therefore `string | string[] | null`. The array form exists for a
concrete reason rather than generality: the two dials are separate sibling
elements with no wrapper, so the spotlight frames the **union** of their rects.
`unionRect(rects)` is pure and tested alongside the placement maths. The version
badge is deliberately *not* in that union — it sits at the far left, inside the
brand, and a rectangle spanning the whole header would frame everything and
therefore nothing.

### The rule that keeps it honest

**A step whose target is not visible is skipped, never faked.**

One rule, three problems solved at once:

- On a phone the agents column is replaced by a selector in the channel bar, so
  step 2 has no target.
- On a cockpit with no agent open, step 3 has nothing to point at.
- A control moved by future work leaves a spotlight on empty space — the failure
  mode that makes a tour worse than none.

The counter therefore reads over the **retained** steps ("2/4"), computed after
filtering, not over the five theoretical ones. Visibility is decided by the
element existing, being non-`hidden`, and having a non-zero bounding rect.

### The spotlight, mechanically

One `#tourOverlay` carrying `.overlay` (invariant 18), in two modes:

- **Centred mode** (step 1): exactly what `.overlay` already does — dimmed
  backdrop, card in the middle.
- **Spotlight mode**: a `.spotlight` modifier turns the overlay's own background
  transparent, and a child "hole" element positioned over the target's bounding
  rect does the dimming with `box-shadow: 0 0 0 9999px rgba(…)`. One element, no
  SVG mask, no clip-path arithmetic.

The bubble is positioned by **`bubblePlacement(target, bubble, viewport)` — pure
and unit-tested**, living in `public/tour-steps.js` (ESM, loaded by the browser
and imported by the test, like `gauge-dial.js` and `notify.js`). It returns
`{top, left, side}`: below the target by default, flipped above when it would
overflow the bottom, and clamped to the viewport on both axes. This is
arithmetic, and arithmetic is what silently breaks on a screen size nobody tried.

The step list itself is data (`TOUR_STEPS`), also in that module: `{id, title,
body, target}` where `target` is a CSS selector or `null`. Keeping it pure makes
"does this step survive filtering?" testable without a browser.

### Skip, escape, replay

- **Skip** is on every step and ends the tour for good.
- **Escape** and a click outside the bubble do the same. Nobody is trapped in a
  tutorial.
- **Replay** is a "Guided tour" entry in the existing ⋯ menu, next to Diff. No
  new chrome to design, and it is where a user already looks for extras.

### Persistence

A `localStorage` flag (`shadok.tourSeen`), not server state. The tour is a
preference of *this browser*, not of the instance: a new device is often a new
person, and that person is exactly who the tour is for. It also costs no
endpoint and no `/channels`-style merge rule.

### Order on a brand-new instance: tour first, sign-in after

A fresh instance is signed out, so the sign-in card would otherwise be the very
first thing anyone sees — asking someone to authorise an OAuth flow before they
know what the thing is. So on first load the order is **welcome → tour →
sign-in card**.

The card is **deferred, not skipped**. Signing in is not optional: whether the
tour is completed or skipped, the card opens the moment it ends. What changes is
only *when*, never *whether*.

Three consequences worth stating, because each is a way to get this wrong:

- The deferral applies **only to the auto-open on load**. A spawn refused with
  `code: "logged-out"` mid-session still opens the card immediately — there is no
  tour in the way, and the user just asked for something that cannot happen.
- A browser that has already seen the tour gets the card straight away. The
  deferral is tied to the tour actually running, not to the instance being new.
- During the tour the cockpit is signed out, so the controls being pointed at
  would refuse to work if clicked. That is acceptable — the tour explains, it
  does not ask anyone to click — and step 3 (`.tab.active`) is skipped anyway on
  an instance with no agent, by the visibility rule above.

## Testing

**Unit (pure, no browser):** `bubblePlacement` — below by default; flipped above
when the target sits low; clamped left and right; a target taller than the
viewport still yields an on-screen bubble. `unionRect` — two adjacent rects give
the enclosing one; a single rect is returned unchanged; an empty list yields
`null` so the caller skips rather than framing `0,0`. `visibleSteps(steps,
isVisible)` — drops steps whose target is missing, keeps `target: null` steps
always, and renumbers so the counter matches what the user will actually see.

**The ordering, against a signed-out instance:** on first load the welcome
screen appears and the sign-in card does **not**; skipping the tour opens the
card immediately; completing it opens the card at the end; reloading afterwards
(tour flag now set) opens the card straight away with no tour. This is the part
a unit test cannot reach, so it is checked in the browser.

**Browser, on a side instance (port 3899, `SHADOK_VERSION_CHECK_MIN=0`):**
screenshots of each step at 1280×900 **and** at 390×844, reading the console
back — a CSP violation or a failed import is invisible in the DOM (invariants 10
and 12). Specifically checked: the phone run skips step 2 and renumbers, the
spotlight hole lands on the right element, and no step causes horizontal
overflow.

## Documentation shipped with the change

- `README.md` — the tour and how to replay it.
- `CLAUDE.md` — `public/tour-steps.js` in the architecture map.
