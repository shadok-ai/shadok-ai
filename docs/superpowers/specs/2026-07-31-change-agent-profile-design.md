# Changing a running agent's profile

Date: 2026-07-31
Status: agreed, implemented

## Problem

The profile is chosen at spawn and is **never changeable** afterwards. Yet it is
what defines an agent: role, permission guardrails, secrets, model. Picking the
wrong profile — or wanting to make an agent read-only after the fact — currently
means closing the channel and creating another one, which **loses the
conversation**.

The missing mechanism is nonetheless 90 % in place:

- `restart` (WS) respawns the agent in place with `s.profile`, preserving the
  history (`--resume`) and every attached client's references;
- a tab's context menu exists and **already shows** the current profile in its
  header;
- the profile card grid exists (the "New agent" box).

Only the change itself, and its confirmation, are missing.

## Constraint

`profile` is in `SERVER_OWNED` (`src/channels.ts:52`): a `PUT /channels` from the
browser can neither write nor clear it. That is deliberate — a stale client must
not be able to strip an agent of its guardrails. So the change goes through a
**dedicated server path**, not through channel persistence.

## Protocol

**client → server**: `{ type: "set-profile", profile: string | null, restart?: boolean }`

The server:
1. validates — `profile === null` or `getProfile(profile)` exists; else `error`;
2. persists it on the channel (`upsertChannel`), the only legitimate path for
   that field;
3. sets `s.profile` — the **desired** profile, the one the next spawn will use;
4. broadcasts `profile` to **every** client (other tabs, other devices);
5. if `restart: true`, chains into the existing `restart` path, unchanged.

**server → client**: `{ type: "profile", profile, applied }`

`applied` is the profile the **running process** actually received. It is set at
the only two places that call `makePilot`: `createSession` and the `restart`
handler. Without it, "saved" and "in force" would be indistinguishable and the UI
could not show the gap. Emitted right after `ready` too, so an arriving client
knows both values.

## UI

**The tab's context menu** gains a `👤 Change profile…` entry, under the header
that already shows the profile. It only appears when the tab has a `sessionId`:
an agent that was never launched is configured in the creation box.

When desired ≠ in force, the header says so: `👤 Shadok-dev (at next reload)`.

**The picker** reuses the box's cards. `renderProfileGrid` was hardwired to
`#profileGrid` and to the global `selectedProfile`; it is extracted as
`renderProfileCards(container, selected, onPick)`, used by both callers. No
duplication of the card logic.

**The confirmation** has **three** outcomes, hence not a native `confirm()`:

- `Restart` — persists and restarts right away;
- `Save only` — persists, applied at the next reload;
- `Cancel` / Escape — **changes nothing**. Closing a popin must never quietly
  change state.

If the agent is working, the popin adds "A turn is running — it will be
interrupted" and the restart button turns alert-coloured. We do not forbid it:
cutting an agent that went off track is precisely a use case.

## Long press (touch)

The context menu had **no** touch support — pre-existing, but it makes this
feature unreachable from a phone, which is also how the cockpit gets driven. A
500 ms long press on the tab opens the same menu; a finger movement cancels it
(that is a scroll, not a press). Rename / Mute / Mirror / Close benefit too.

## Out of scope

- An equivalent Telegram command.
- Changing the profile of a tab that was never launched (the creation box covers
  it).

## Tests

The server's WS has no unit-test harness in this repo; the pure cores do.

- `channels.test.ts`: a client `PUT /channels` cannot overwrite a channel's
  `profile` (the invariant the dedicated path protects).
- `profile-card.test.ts`: unchanged — the card logic does not move.
- The rest (menu, popin, restart, multi-client broadcast) is verified **in the
  browser** with Playwright, including with two tabs open to check the change
  propagates.
