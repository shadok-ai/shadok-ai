# Quota gauges — from 240° dial to a flat bar with a pace marker

Date: 2026-10-30
Status: implemented

## Problem

The two header quota gauges (`.quota`, `#quota5h` / `#quota7d` in
`public/index.html`) were a 240° speedometer dial (the design of
`2026-07-30-quota-dial-design.md`): a needle swung from "under pace" on the left,
through "on pace" straight up, to "exhausted" on the right, over a graduated arc.

It reads precisely once you know the convention, but a speedometer is an unusual
metaphor for "how much of my quota is gone", and the single most useful fact —
**how full the window is** — had no plain length to read it off. The ask was to
flatten it into something immediate:

> A flat bar representing the period (5h / 7d), filled with the % consumed, plus a
> white marker showing where we are in the elapsed time of the period (like the
> old pace tick).

## Design

One flat bar per window, in the instrument bar, the two stacked (`5h` then `7d`):

```
5h  [██████████▏   ╎      ]  42%
7d  [████████╎██████      ]  71%
          ↑ white pace marker
```

- **Length = `usedPercentage`** — the share of the quota spent, linear 0→100 %.
  This is the headline the dial lacked a plain reading for.
- **A white marker at `idealPacePct`** — the share of the window's *time* already
  elapsed, i.e. where consumption *should* be. It stands slightly proud of the
  bar with a small triangular cap so it reads on any fill colour. Hidden when
  there is no reset time (no pace to mark), exactly as the dial hid its tick.
- **Fill colour encodes ahead-of / behind-the-clock**, not magnitude: green when
  the fill is short of the marker (under pace), the accent when on it, red when
  the fill runs past it (burning faster than the clock). The *gap* between the
  fill's end and the marker is the signed deviation the old divergent bar and the
  dial both tried to show — here it is a literal distance on the bar.
- **Label left, `%` right**, the `%` tinted with the same colour as the fill.

Position AND colour carry the reading (never colour alone), and the multi-line
tooltip / `aria-label` states the deviation in words.

## What this reuses, what it drops

`public/gauge-dial.js` stays the pure core and keeps `dialPos` / `dialColor` /
`dialTitle`:

- `dialPos(used, pace)` → the piecewise pace position in `[-1, 1]` (−1 nothing,
  0 on pace, +1 exhausted). It no longer becomes a needle angle — it now keys the
  fill **colour** via `dialColor`. Its clamp and the `PACE_MIN ≤ PACE_EPSILON`
  property (the fill reddens before the guardrail blocks a send) are unchanged.
- `dialColor` / `dialTitle` — unchanged behaviour.

Removed (the dial geometry, now dead): `SWEEP_DEG`, `DIAL`, `dialAngle`,
`dialPoint`, `arcSegments`, and the `buildDialArcs()` / needle / tick / arc SVG
in `index.html`. The bar's length and marker position are the raw percentages, so
no geometry module is needed.

## Theme & accessibility

- The track is a faint wash of `var(--text)` and the marker is `var(--text)` with
  a `var(--page)`-coloured drop-shadow outline, so both read on the dark **and**
  the light palette (a literal `#fff` marker would vanish on the light theme — the
  old tick was `var(--text)` for the same reason; "white" describes the dark
  theme the cockpit ships in).
- `role="img"` + the worded `aria-label` keep it legible to a screen reader; the
  deviation is never colour-alone.
- On a phone the bar and label column shrink so the two stacked meters still fit
  the `nowrap` header beside the brand and the ⋯ menu (verified: no overflow at
  390 px).

## Scope

Only the two header quota gauges and the module that drives them. `/usage`,
`src/pace.ts`, `src/usage.ts` and the pace guardrail are **unchanged** — the
payload already carries `usedPercentage`, `idealPacePct`, `ratioPct` and
`resetsAt`, which is everything the bar needs.
