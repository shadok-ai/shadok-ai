# Reload-to-apply: telling when a long-lived agent is behind

## Problem

Everything shadok injects into an agent is fixed **at spawn**: the pilot prompt
(`--append-system-prompt`), the profile guardrails, the permission mode, the
injected secret names, the list of seeded skills, and the bootstrap auth cookie.
A running `claude` keeps all of that for its whole life — and a tmux agent
survives server restarts, so it keeps it across **auto-updates too**.

Consequences an operator reported, all silent:

- An instance launched months ago runs that month's pilot prompt forever. If a
  release added a capability or a safety paragraph, the old agent never got it.
- The injected auth cookie expires after a week (invariant 33). Past that, the
  agent's own `pilotctl` / vault / scheduler calls `401` with nothing in the
  log — the agent's report ("nothing changed on my side") is accurate.
- A profile edit (guardrails) or a newly-seeded skill doesn't reach the running
  process at all.

There was no way to see which agents were stale. The only robust fix — reload —
had no trigger.

## Why not a version number

The operator's own constraint, and it's correct: **a version bump is neither
necessary nor sufficient.** A release can change `server.ts` internals and touch
none of the injected context (would false-positive), and a profile edit or a
secret change bumps no version at all (would false-negative). The signal has to
be the **content** the agent is running versus the content a fresh spawn would
produce.

## Design

### Detection (pure, `src/preprompt.ts`)

`prepromptFingerprint(parts)` — a stable, order-sensitive hash of the preprompt
sections (`prepromptParts`, which already enumerates role / guardrails / mode /
secret names / capabilities / pilot prompt / ledger reflex).

`stalenessReasons(input)` — version-independent, three reasons, each only when
the inputs allow it (so a probe failure never invents a reason):

- `preprompt`: stored spawn fingerprint ≠ current fingerprint.
- `auth`: a GUI password is set **and** the spawn is older than the cookie TTL.
- `claude`: the `claude` version at spawn ≠ the one installed now.

Fully unit-tested, including the "unknown" cases (null fingerprint / null
version / null spawn time never flag).

### The anchor must be DURABLE and adoption-aware (`src/channels.ts`, `src/server.ts`)

The spawn snapshot `prepromptById` is **in memory**, and that is exactly wrong
here: when a surviving tmux pane is re-adopted after a restart
(`TmuxPilot.start()`), `makePilot` re-captures the snapshot from **current**
state while the process is still the old one — hiding the very drift an
auto-update just created. So the fingerprint, spawn time and claude version are
persisted **on the channel** (`spawnFp` / `spawnAt` / `spawnClaudeVer`,
server-owned, on disk, removed when the agent closes).

`recordSpawnFingerprint(s)` runs after `attachPilot` and writes the anchor **only
for a process we actually spawned** (`!pilot.attached`). On adoption it leaves
the stored anchor alone — or, the first time it meets a pre-feature agent with
no anchor, seeds `"legacy"`, which reads as stale until that agent is reloaded.
This is what lets the indicator light up the operator's *existing* old agents,
not just future ones.

A restart re-records the anchor (clearing `legacy`), which is what makes the
indicator go dark after a reload.

### Delivery

A `stale` reason list rides every `ready`, is broadcast on change, and is
recomputed by a **60 s sweep** over live sessions (one cached `claude --version`
per sweep) — so a profile edit or a freshly-installed binary reaches an idle
agent's tab with no traffic on it.

### UI (`public/index.html`)

Reuses the existing Claude-Code-update presentation (`updateState` → the per-tab
`↻` badge, the chan-bar button, and the version-menu "reload N agents" button).
`tabReloadInfo(tab)` merges the two sources — the screen-scraped binary update
and the server `staleReasons` — into one badge, dropping the server's `claude`
reason when the screen scrape already says the same thing. The version-menu
button counts tabs needing a reload from **either** source and reloads them one
at a time (never a herd of `--resume`).

## Verified

- `npx tsx --test test/*.test.ts` green, including the new staleness tests.
- Real browser on a free port against a live agent: fresh agent → badge hidden
  (empty reasons from the real server); injected `stale` on the real client
  socket → `↻ reload to apply` with all three reasons in the tooltip, version
  menu *Reload 1 agent to apply changes*; zero console errors.
