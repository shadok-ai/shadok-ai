# Continuous onboarding: a schedule that watches how the cockpit is used

**Status:** design, not built. Companion to
`2026-08-31-onboarding-agent-design.md`, which deliberately left this out.

## Problem

The greeting is one moment. Everything the home agent could teach after it is
currently taught by accident, or not at all.

Someone who spawns four dev agents by hand every week never learns that a
schedule would do it. Someone whose schedules all wake the model on every fire
never learns that a guard would make the quiet ones free. Someone who has run
the cockpit for a month with no profile on any agent never learns profiles
exist.

The gap is not knowledge — the tour and the README both explain crons. **It is
timing.** The moment to learn what a schedule does is the moment you are
visibly doing by hand what a schedule does, and nothing in the product notices
that moment.

## Design

### 1. It is a schedule on the home channel — the product applied to itself

No new mechanism: a cron, its guard, and the ledger. All three exist.

The pleasing part is not the economy, it is the demonstration. The feature that
teaches people about the zero-token guard is itself a zero-token guard, and on a
week where you have nothing to learn it costs nothing and says nothing.

### 2. The guard carries the threshold, in shell

This is the load-bearing decision.

A guard that simply fires every week wakes the model to look at data and
conclude, most weeks, that there is nothing to say — which is precisely the
expense the guard exists to prevent. Building the feature that way would make
it an argument *against* its own thesis.

So the threshold lives in the check. It is computable without a model: channels
and crons are two JSON files per launch directory. "Four channels in this
directory, same profile, and no schedule at all" is arithmetic.

**The consequence to accept: a product judgement now lives in a shell script.**
That is blunt, and it is honest — the alternative is paying a model every week
to re-derive the same judgement.

Signals worth encoding, each computable from those two files:

| Observed | What it suggests |
|---|---|
| N channels, same profile, same directory, no schedule | the work is repetitive enough to schedule |
| Schedules exist, none of them has a check | they wake the model on every fire; a guard would make the quiet ones free |
| Many channels, none carrying a profile | profiles have not been discovered |
| Exactly one channel mirrored to Telegram | mirroring has been found but not adopted |

### 3. The ledger carries the refusal

A schedule that spots the same pattern every week says the same thing every
week, and advice that repeats stops being advice. The feature's real failure
mode is not being wrong — it is being tiresome, which is how it gets turned off
in the third week.

So a suggestion that was declined is never raised again. "Suggested a schedule
for the dev loop, declined" is exactly a ledger row: per-instance, one row per
topic, **supersede rather than append**, bounded by live topics.

A suggestion that was *accepted* stops being a suggestion at all — the condition
that produced it is no longer true, so the guard falls silent on its own.

### 4. What it is allowed to say

- **At most one suggestion per fire.** Two is a lecture.
- **Never a declined one, ever again.**
- **Silence is the default and the success case**, exactly as it is for every
  other guard in the product.

## Boundaries kept

- **It reads structure, never content.** How many agents, which profiles, which
  schedules, which are mirrored. It does not read transcripts, prompts, answers
  or diffs. This is the line that makes "the cockpit watches how you work"
  something a user can accept: it counts, it does not eavesdrop.
- **Stated, not discovered.** The home agent says it observes usage, in the
  greeting, before it ever does. A property someone finds out about later is a
  betrayal even when it was harmless.
- **Its own launch directory only.** Both files are per-directory, so this falls
  out of the storage layout rather than needing to be enforced.
- **It suggests; it never configures.** The agent proposes the schedule and the
  human accepts it, the same rule as everywhere else in this product.

## Out of scope (deliberate)

- **Anything reading transcript content.** Not a later phase — a line this
  feature does not cross.
- **Cross-instance or cross-directory observation.** Comparing how you work in
  one repository with another is a different feature, with a different consent
  question.
- **Acting on what it sees.** A schedule that created other schedules would be
  the cockpit configuring itself, and nobody asked for that.

## Verification

- The guard is a pure function over fixture JSON: four directories reproducing
  each signal in the table, plus **one where nothing is remarkable** — the fifth
  is the important one, because a guard that always finds something is the
  failure this design is built to avoid.
- A quiet week creates no transcript at all, proved the way
  `2026-08-09-zero-token-proof.md` proved it: the session's `.jsonl` never comes
  into existence.
- A declined suggestion, re-run against unchanged fixtures, produces silence —
  the ledger row is what makes the second run differ from the first.
