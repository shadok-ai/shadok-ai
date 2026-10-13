---
name: shadok-ledger
description: Verify whether something is already resolved/decided before you assert or act on its status, and record resolutions/decisions so sibling agents don't re-surface them. Use before reporting a bug, proposing a feature, saying "X isn't done", or acting on a premise like "the PR isn't merged" — and whenever you resolve, decide, or change something notable. Not for code/PR status (use git/gh); for everything without a system of record (infra, marketing, site, ops, tasks).
---

# shadok-ledger

A shared **state table** across this instance's agents: **one current status per
entity** (a bug, a task, a campaign, an extraction job, a decision…). It exists
because agents run siloed and keep re-raising things another agent already
handled. It is a *table*, not a log: re-recording an entity **supersedes** its
row, so it stays small.

**Source of truth first.** For code and pull requests, the truth is `git` / `gh`
— check those, not this ledger. Use the ledger for everything that has **no
system of record**: infra changes, marketing actions, site activity, ops, tasks.

## Before you assert or act on a status

Run `check` and let it steer you:

```
node ~/.claude/skills/shadok-ledger/ledger.mjs check "<topic, in your own words>"
```

**Ask in plain language — don't try to guess how a sibling worded the row.** The
search ranks rows by word overlap, so `check "claude launcher stub spawn
failure"` finds `claude-launcher-stub-breaks-spawns`. Describing the topic in a
few words beats one lucky keyword; extra words that turn out to be absent cost
you nothing.

- a row says **resolved / done** → do NOT re-raise or re-act; report it as handled.
- **nothing recorded** → treat as **UNKNOWN**, not as "not done": ask the human
  or hedge ("from memory, still to do — tell me if it is already handled"),
  don't assert.
- **related rows — they may NOT answer your question** → exactly what it says:
  the search found no row that answers you, only rows sharing some words. You
  are still in the UNKNOWN case above. Read them as leads (they may point at the
  right topic under another name), never as a status to assert.
- a **stale** row (many days old) → hedge and confirm before acting. The age
  shown is when the row's claim was last **confirmed**, not when its text was
  last edited.
- a row tagged **`· fact`** has no lifecycle: it is `current` or `stale`, never
  "done". Do not read its status as a position in open → resolved, and do not
  close it because the work around it finished — it stays true.
- a row tagged **`· decision`** is a standing decision, not a phase of a task.
  It holds until something supersedes it.

This fires on status-dependent claims (a bug being open, a PR unmerged, a task
undone, a campaign live). A **durable lesson/constraint** ("don't buy the
opposite-intent keyword") is not a status — use it freely, don't gate it.

## When you resolve, decide, or change something notable

Record it so the next agent doesn't redo it:

```
node ~/.claude/skills/shadok-ledger/ledger.mjs record \
  --entity "<name>" --status <resolved|open|in-progress> \
  --note "<one line>" --source "<PR#, session, who>"
```

Re-recording the same entity **supersedes** its row (no duplicates). Log facts —
resolutions, decisions, state changes, launched actions — never chatter.

**Open the note with the one sentence that says what happened.** Its first
sentence is what siblings are shown in the `⟦ledger⟧` block pushed ahead of their
messages — the entity name alone cannot tell them what changed about it. Put the
consequence first, details after.

## Is it a task, a fact, or a decision?

A **task** has a lifecycle, so a status is the right thing to carry and closing
it is normal. That is the default and needs no flag. The other two do:

```
… record --entity "nightly import window" --kind fact \
    --note "Runs 03:00-03:40 Europe/Paris, after the extraction job."
… record --entity "ledger stays a state table" --kind decision \
    --note "Supersede, not append, so size is bounded by live topics."
```

`--kind` replaces `--status` for these two (they get `current` / `decided`), because
neither has phases to report. This matters: a **fact** marked `resolved` stops
being read by anything that filters on open work, while remaining perfectly true
— which is how a job finished on the 9th was still believed pending on the 12th.

When you re-check a row and nothing has changed, say so instead of rewriting it:

```
… record --id <id> --verified
```

That refreshes its freshness only. It deliberately does **not** enter anyone's
pushed block — "I looked, nothing moved" is not news. Conversely, editing a note
does **not** refresh freshness: only a status (or `--verified`) counts as having
looked.

Every row has a short **id** (shown as `[id]` in `check`/`list` and in the ledger
block pushed ahead of your messages). To update a row you already saw, quote its
id instead of retyping the name — no risk of a typo forking a second row:

```
node ~/.claude/skills/shadok-ledger/ledger.mjs record \
  --id <id> --status resolved --note "<one line>"
```

## To consult the whole table

```
node ~/.claude/skills/shadok-ledger/ledger.mjs list
```
