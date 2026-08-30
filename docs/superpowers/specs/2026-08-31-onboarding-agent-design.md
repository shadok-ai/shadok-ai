# The home agent introduces itself, reads the ground, and offers

**Status:** design, not built. Written after a design conversation; nothing here
has been implemented.

## Problem

A fresh cockpit opens on one channel named `general`, running `Shadok-Boss`,
which then says nothing until it is spoken to. The newcomer meets a blank chat
and has to guess what any of this is for.

Four distinct failures hide behind that, and they do not have the same fix.

**The lead prompt assumes it is inside shadok-ai.** `Shadok-Boss` is told to
"read the repo, `CLAUDE.md`, `docs/` and its specs". Those are *this* project's
conventions, and they are true for exactly one instance in the world. Everyone
who launches shadok in a Rails app, an Xcode project or a folder of marketing
copy gets an agent hunting for a structure that is not there. This is a bug, not
a missing feature, and it is the cheapest of the four to fix.

**The lead never acts unprompted.** Its prompt already carries a KNOW job — read
before you answer — and it discharges it only on request. The single most useful
thing it could do on a new project (read it, and say what it is) is the thing it
never volunteers.

**The guided tour cannot cover this.** `tour-steps.js` walks the interface. It
knows nothing about the repository it is running in and it configures nothing.
A tour narrates; what is missing here is something that *acts*.

**Discovery is one-shot and lands wrong.** Someone who launches shadok in a code
repository is never told it also runs paid campaigns, writes content, or answers
support. They classify it as a dev tool on the first day, and nothing later
corrects that.

## Design

### 1. Repair the premise

`Shadok-Boss` stops naming shadok-ai's own conventions. It reads whatever
convention file the project actually has, and treats their absence as
information rather than as a failed lookup.

### 2. Read the ground deterministically

A shell pass, not a model call: version control, stack markers, CI
configuration, an `.xcodeproj`, the absence of code at all.

This is the project's own signature move — the cron guard runs the cheap
deterministic check first and only wakes the model when there is something to
say. Onboarding gets the same treatment, and for the same reason: recognising a
`Gemfile` is not reasoning.

### 3. Three registers, chosen by confidence

The hard part is not being present, it is being **right**. A greeting that
misreads the project costs trust at the exact moment there is none in reserve —
worse than silence.

| What the pass found | What the agent does |
|---|---|
| A stack it knows **and** a shadok mechanism that fits | names what it saw, offers **one** thing |
| A stack it knows, nothing obvious to offer | names what it saw, then asks — an *informed* question |
| Nothing recognisable | one honest line about what shadok is for, then asks |

Only the first register speaks with specificity. Pretending in the third is how
this feature would become the thing people disable.

### 4. The introduction is generated from the profile list

Not prose in a prompt. The agent reads the profiles that exist **in this
cockpit**, including ones the user minted, and describes those.

A profile added later appears in the greeting with nobody editing any text, and
the introduction cannot promise a role that does not exist. Hardcoding the list
would reproduce the drift `CLAUDE.md` documents half a dozen times: a
description that outlives the thing it describes.

Two rules for the copy:

- **The detected use case is expanded; the others get one line each.** Breadth
  informs, specificity converts, and they compete for the same first message.
- **The breadth items are outcomes, never feature names.** "Paid campaign
  management" is a feature word. "Run your ads and tell you each morning what
  moved" is something a newcomer can evaluate.

### 5. The universal opener needs no detection at all

> *Want me to read this project and tell you what it is?*

It works in a Rails app, an Xcode project, a marketing folder and a repository
cloned five minutes ago. It delivers something in two minutes. It is also
already the lead's stated KNOW job.

Ground reading does not make the *first* message possible — it makes the
*second* one good: not "shadok can schedule things" but "you have fourteen open
pull requests; here is the schedule that tells you when one becomes mergeable".

### 6. Three new profiles

The catalogue has to cover what people actually do here, but a profile that
duplicates another costs more than a missing one — nobody can choose between
near-identical roles.

**A profile earns its place on guardrails, secrets, or method. Never on topic.**
Two roles differing only in subject matter are one role with two briefs.

| Role | What distinguishes it |
|---|---|
| `Shadok-QA` | reproduces and tests; wants to write `test/` and not `src/` — a guardrail shape no existing role has |
| `Shadok-Release` | ships to production, whatever production is — see below |
| `Shadok-Product` | writes specs, not code: read-only on `src/`, writes `docs/`, and interrogates before proposing |

`Shadok-Release` is deliberately **general**, not an Apple/Fastlane role. Cut
that narrowly it would have rested on its secrets alone; cut generally it gets
the strongest justification of the three: **it is the only role whose mistakes
are already in front of users by the time anyone notices them.** A dev agent's
error sits in a worktree. A release agent's error is live.

Two consequences follow, and they are the role, not decoration:

- **It prepares, verifies and reports. It never decides to ship.** A human pulls
  the trigger, exactly as landing a branch is a human-reviewed step and as an
  agent may not restart the server (invariant 8).
- **Its guardrails are shaped the other way round from `Shadok-dev`**: it may run
  the deployment path and may not edit the source it is deploying. Changing what
  you ship while shipping it is how a release becomes unreproducible.

Its secrets still distinguish it — registry tokens, cloud credentials, signing
certificates — and secrets remain the one thing an agent cannot grant itself.

A UI/UX design role is **deliberately deferred**: it overlaps `Shadok-Product`
heavily, and its output is visual, which is the hardest kind for an agent to
verify alone.

## Boundaries kept

- **Not a blocking first-run screen.** `claude-home.ts` exists to delete those —
  the trust dialog, the fullscreen upsell, the auto-mode environment scan.
  Adding one back has to clear a high bar, and an offer that costs three lines
  when declined clears it where a mandatory question does not.
- **No new trigger is needed.** Channels are stored per launch directory, so
  `firstAgentPlan`'s "no channel at all" is already evaluated per project: the
  greeting fires once per directory, not once per installation.
- **Project knowledge belongs to the channel, not the profile.** Profiles are
  global (`~/.shadok-ai/profiles.json`) while projects are per-directory.
  Writing what-this-repo-is into a profile would rewrite every cockpit's roles
  on every directory change.
- **The lead prompt stays managed, not frozen.** `withManagedPrompt` and
  `promptOrigin` already give "shipped by default, forkable if you insist, and
  it says when your fork went stale" — which is strictly better than hardcoding.

## Out of scope (deliberate)

- **Renaming `general`.** It is forced in `channels.ts` and is structural on the
  Telegram side: `isHomeChannel` recognises the home base by `threadId == null
  && chatId < 0`, and `mergeChannels` forces the name for a board's General.
  Renaming means separating the **display name** from the **binding rule** in
  three places that agree today by coincidence of string. Worth doing, but after
  we know what the agent *is* — not before.
- **A UI/UX design profile.**
- **Continuous observation** ("you have spawned four dev agents by hand this
  week; a schedule would do that"). Genuinely valuable and a different mechanism
  from a greeting — it needs the agent to read channel and cron lists over time,
  and it deserves its own design rather than riding in on this one.

## Verification

- The ground-reading pass is pure and unit-tested against fixture directories:
  an Xcode project, a Node repo, a git repo with no recognisable stack, and an
  empty folder — the fourth being the one that must produce the honest register
  rather than an invented offer.
- The generated introduction is asserted to name only profiles returned by
  `GET /profiles`, so it cannot promise a role this cockpit does not have.
- End to end, in a container with no channels: the greeting arrives unprompted,
  and declining it leaves a working cockpit rather than a half-configured one.
- `test/` locks the copy rules that a refactor can silently undo, the way
  `tweak-role.test.ts` locks the tweak agent's prose: breadth items phrased as
  outcomes, and exactly one expanded offer.
