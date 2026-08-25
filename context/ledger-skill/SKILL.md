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
node ~/.claude/skills/shadok-ledger/ledger.mjs check "<topic or entity>"
```

- a row says **resolved / done** → do NOT re-raise or re-act; report it as handled.
- **nothing recorded** → treat as **UNKNOWN**, not as "not done": ask the human
  or hedge (« de mémoire, à faire — dis-moi si c'est déjà réglé »), don't assert.
- a **stale** row (many days old) → hedge and confirm before acting.

This fires on status-dependent claims (a bug being open, a PR unmerged, a task
undone, a campaign live). A **durable lesson/constraint** (« ne pas acheter le
mot-clé de sens inverse ») is not a status — use it freely, don't gate it.

## When you resolve, decide, or change something notable

Record it so the next agent doesn't redo it:

```
node ~/.claude/skills/shadok-ledger/ledger.mjs record \
  --entity "<name>" --status <resolved|open|in-progress|decided> \
  --note "<one line>" --source "<PR#, session, who>"
```

Re-recording the same entity **supersedes** its row (no duplicates). Log facts —
resolutions, decisions, state changes, launched actions — never chatter.

## To consult the whole table

```
node ~/.claude/skills/shadok-ledger/ledger.mjs list
```
