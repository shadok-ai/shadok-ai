# The PR-handling agent — design

**Date:** 2026-07-28
**Goal:** an agent that brings `shadok-ai/shadok-ai`'s PRs to a merge on its own,
without ever breaking `main` or stepping on a live agent.

## Context

- `main` is protected: the `verify` check is required, in **strict** mode (the
  branch must be up to date with `main` before merging), 0 reviews required.
- Many shadok-ai agents work in parallel in durable worktrees. So a PR's branch
  may **still be held by a live session**.
- `main`'s history is squash-merged, with the title `Title (#N)`.
- Gotcha #8 of CLAUDE.md (blind merges, conflict markers in `main`) is the #1
  source of past breakage. This design exists so as not to repeat it.

## Shape

A **loop inside the cockpit's session**, every **5 minutes**. No cron, no skill:
the human sees every turn go by and can interrupt.

## Approach: server-side first, local only when necessary

The most common case is "green but behind `main`" (a direct consequence of strict
mode). We handle it with `gh pr update-branch`, which **merges `main` into the
branch on GitHub's side, without rewriting history**.

We do not rebase and force-push: that would break the local checkout of agents
still holding those branches. We only go local — in a **dedicated** worktree,
`~/.shadok-ai/worktrees/pr-bot`, never somebody else's — for a real conflict or a
CI repair.

Rejected alternatives:

- **Rebase everything locally + force-push.** Uniform, but it rewrites history
  under live agents.
- **GitHub's native auto-merge.** Lightweight, but it can neither resolve a
  conflict nor repair a red run, and it short-circuits the quick review.

## Entry filter

A PR is a candidate only when **all** these hold:

1. it is not a draft;
2. its base is `main`;
3. its author is on the allowlist: `shadok-ai-dev`, plus the bots
   (`dependabot[bot]`, `github-actions[bot]`, app bots);
4. it does not carry the `hold` label.

Everything else — first and foremost **PRs coming from a fork** — is reported and
never touched.

## The decision, per PR

| State | Action |
|---|---|
| Green + up to date | Quick review → squash-merge |
| Green, behind `main` | `gh pr update-branch` → the CI is checked on the next pass |
| A **simple** conflict | Resolve in the dedicated worktree → push → green CI → merge |
| A **large** conflict | Stop, show the conflict to the human |
| A **simple** red run | Fix → push → green CI → merge |
| A **large** red run | Stop, show the diagnosis to the human |

### Simple vs large

It is **large** as soon as one of these holds:

- both sides of the conflict change the same logic;
- more than 2 files are touched by the resolution;
- the failing test reveals a real design problem, not a mechanical oversight;
- the resolution does not fit in one explainable sentence.

**Doubt counts as large.** A *simple* conflict looks like: two additions to the
same list, import blocks, adjacent independent functions, a CHANGELOG. A *simple*
red run looks like: a type error, a missing import, a typo, a test assertion the
PR forgot to update.

## The "live session" guardrail

Before **any push** to a PR's branch, query `localhost:3789/live` and compare the
active worktrees' branches to the PR's head. If a session is running on that
branch: **do not push**, report it to the human.

Merging stays allowed in that case — a merge does not change the source branch.

## Quick review before merging

A scan of the diff, ~30 s, looking for:

- hardcoded secrets or tokens;
- files outside the subject the PR announced;
- unjustified mass deletions;
- leftover conflict markers;
- forgotten debug traces;
- a `package.json` with a changed `version` — forbidden, the CI computes it;
- any change to `.github/workflows/` → **always ask the human**, even when the
  rest is clean.

If something looks off, we do not merge: we report it.

## The merge

Squash, title `Title (#N)`. The remote branch is **not deleted**: worktrees are
durable (invariant #5), and cleaning them up stays an explicit gesture.

## Absolute prohibitions (without the human's explicit agreement)

Merging a fork or an author off the allowlist; force-pushing to `main`; changing
the workflows; deleting a branch or a worktree; restarting the shadok-ai server.

## Report

One line per PR handled on each pass. If nothing moved since the previous pass,
the loop stays silent.
