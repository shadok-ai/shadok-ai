# Instance-wide mute (freeze the favicon)

Status: built. `src/config.ts` + `src/server.ts` (`/mute`) + `public/index.html`.

## Problem

A single agent can be muted from its menu (`Channel.muted`) — it then raises no
favicon pip, title badge, blink or chime. There was no way to silence a WHOLE
instance at once. The ask: an option so 100% of an instance is muted and the
favicon never changes.

## Decisions

- **Reuse the existing mute semantics, applied to all.** `notifyState`
  (`public/notify.js`) already skips any channel marked `muted`. An instance
  mute therefore needs no change to that module: `attentionInput` in
  `index.html` ORs a single `cockpitMuted` flag into every channel's `muted`, so
  a fully-muted instance resolves to the idle state — favicon frozen (the
  "working" pump stops too), no title badge, no blink. `ding` gets the same
  guard, so the chime is silenced as well: "100% muted" means sound included.

- **Per instance, server-owned, like the name and palette — not per browser.**
  The admin framed it as "an instance", so it is a per-launch-dir config field
  (`cockpitMuted`, `mutedForCwd`/`setMutedForCwd`) with a `GET`/`PUT /mute`
  endpoint, mirroring `/theme` and `/title`. It applies to every tab and device
  viewing that instance and survives a reload. (The pre-existing *sound* mute and
  light/dark mode stay per-browser localStorage — those are personal comfort, a
  cockpit-wide silence is the instance's state.)

- **No agent restart.** Unlike `POST /ledger`, flipping the mute changes nothing
  server-side beyond the stored flag — it is purely a client display preference.
  The toggle lives in the version menu beside the other per-instance switches
  (auto-update, auto mode, shared ledger), loaded on boot like `/theme`.

- **`false` is stored as absent.** The default is "not muted"; `setMutedForCwd`
  deletes the key rather than writing `false`, keeping the config minimal — the
  same convention as the palette's default.

## Trade-offs / scope

- **No live push.** A change propagates to OTHER already-open tabs on their next
  reload (they boot-fetch `/mute`), exactly like the name and palette. The tab
  that flipped it applies immediately. A live broadcast was not worth a new
  channel for a rarely-touched preference.
- **The per-agent mute is untouched.** The two compose: an instance mute hides
  everything; a per-agent mute still silences one agent while the instance is
  otherwise live.

## Verification

- `mutedForCwd` unit tested (`test/config.test.ts`): per-dir, unset → false,
  explicit false → false. Full suite green.
- Real server (free port): `GET /mute` defaults `{muted:false}`; `PUT` true
  persists and reads back; `PUT` false clears. The key is per-cwd, so another
  instance's cwd entry (e.g. prod) is untouched.
- Browser (Playwright): with a blocked agent the favicon changes and the title
  shows "● "; turning the instance mute ON returns the favicon to the exact idle
  baseline and drops the title badge while the agent is STILL blocked; the server
  reads `{muted:true}`; after a reload the checkbox is still on and the favicon
  stays idle (boot-fetched). Zero console errors; prod on 3789 untouched.
