---
name: pr-merge
description: Use when PRs are open on shadok-ai/shadok-ai and need bringing to a merge — a periodic pass over the PRs, a green PR to merge, a PR behind main (strict mode), a rebase conflict, a red CI verify to repair, or doubt about whether a PR is eligible for automatic merging.
---

# pr-merge — bringing shadok-ai's PRs to a merge

## Overview

`main` is protected in **strict** mode: the `verify` check must pass **and** the
branch must be up to date. Many agents work in parallel in durable worktrees, so
**a PR's branch may still be held by a live session**.

Principle: never break `main`, never push out from under an agent.

Rationale and rejected alternatives:
`docs/superpowers/specs/2026-07-28-pr-merge-agent-design.md`.

## Entry filter

A PR is a candidate only when **all four** hold:

1. `isDraft: false`;
2. `baseRefName: main`;
3. author ∈ {`shadok-ai-dev`, bots (`dependabot[bot]`, `github-actions[bot]`, app bots)};
4. no `hold` label.

`isCrossRepository: true` (a fork) → **never touched**, reported.

```bash
gh pr list --state open --limit 50 --json \
  number,title,author,isDraft,mergeStateStatus,headRefName,baseRefName,labels,isCrossRepository
```

## The decision, by `mergeStateStatus`

| Status | Meaning | Action |
|---|---|---|
| `CLEAN` | green + up to date | quick review → `gh pr merge N --squash --subject "<title> (#N)"` |
| `BEHIND` | behind `main` | `gh pr update-branch N` → wait for `verify`, then merge **in the same pass** |
| `DIRTY` | conflict | simple → resolve; large → show the human |
| `UNSTABLE` | checks failing **or still running** | read `statusCheckRollup`: running → wait; failing → simple → fix, large → show |
| `BLOCKED` | missing review, other blocker | report, force nothing |

After any push: **wait for `verify` to go green again before merging**. Never
merge on a stale green.

**Do not hand back control between the steps.** `main` moves faster than a pass
every 5 minutes: a PR updated on pass N is often `BEHIND` again on pass N+1, and
the loop spins without ever merging anything — that happened three times in a
row. A PR whose CI is already green is carried through in one go:
`update-branch` → wait for `verify` → review → merge. We only stop if `verify`
fails or a red flag appears.

## Simple vs large

**Doubt counts as large.** It is large as soon as one of these holds:

- both sides of the conflict change the same logic;
- the resolution touches more than 2 files;
- the failing test reveals a real design problem, not a mechanical oversight;
- the resolution does not fit in one explainable sentence.

Simple looks like: two additions to the same list, import blocks, adjacent
independent functions, a type error, a missing import, a typo, an assertion a PR
forgot to update.

## The "live session" guardrail — before a LOCAL push

```bash
curl -s localhost:3789/live | jq -r '.[].cwd' | while read -r d; do
  printf '%s\t%s\n' "$d" "$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
done
```

If the PR's branch shows up → **do not push a local commit to it**, report it.

This guardrail targets pushing (and a fortiori force-pushing), not these two,
which stay allowed even on a held branch:

- **`gh pr merge`** — does not change the source branch;
- **`gh pr update-branch`** — merges `main` into the branch **on GitHub's side**:
  no history rewrite, the agent's checkout is untouched. At worst it will have to
  `git pull` before its next push.

Extending the rule to `update-branch` left three green PRs sitting for nothing,
waiting on sessions that were no longer touching them.

Local fixes (a conflict, a red CI) happen in a **dedicated** worktree,
`~/.shadok-ai/worktrees/pr-bot` — never somebody else's, never the root repo. We
merge `main` into the branch; we do not rebase and force-push (that would break
the checkout of agents still holding those branches).

## Quick review before merging (~30 s)

`gh pr diff N`, then look for: hardcoded secrets or tokens · files outside the
announced subject · unjustified mass deletions · leftover conflict markers ·
debug traces · a changed `version` in `package.json` (forbidden, the CI computes
it).

Something looks off → do not merge, report it.

## Did the docs ship with it?

One extra question on the same diff, because this is the last moment it is cheap:

> **Does this PR change something a document describes, without changing that
> document?**

- a user-visible feature, flag, Telegram command, HTTP endpoint or WS message
  → `README.md`;
- a new or reshaped subsystem, or a design trade-off worth remembering
  → `docs/architecture.md`;
- a new module, or an invariant learned the hard way → `CLAUDE.md`.

**This is not a merge blocker.** Sending a green PR back for a doc line costs a
CI round trip and stalls the queue, which is worse than the gap. Merge it, then
**say so in the report** — name the file that should have moved. A doc gap that
is written down gets closed; one that is noticed silently does not.

The cost of skipping this: `docs/architecture.md` once went 48 commits without
an update. It was then missing entire subsystems, and its line references were
hundreds of lines off — confidently wrong, and read as current.

## Running the pass continuously

A shadok channel cron, **with a deterministic guard** — not a session loop:

```bash
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs add \
  --schedule every:5m \
  --check "sh $HOME/.shadok-ai/checks/pr-open.sh" \
  --prompt "PRs are open on shadok-ai/shadok-ai (listed above). Apply the pr-merge skill's procedure. If there turns out to be nothing to do, write exactly NOTHING TO SHOW."
```

The guard is `scripts/check-open-prs.sh` (this folder). The server runs it
**without the LLM**: it only prints when a PR the loop can ACT on exists, and its
output is prepended to the prompt. A quiet repo therefore costs **0 tokens** and
leaves no trace in the thread.

So on top of drafts and bases ≠ `main`, it discards **forks and `DIRTY` PRs**: in
both cases the loop's answer is invariably "not mine". Without that sort, a
single stuck PR woke the agent at every slot — one LLM turn per minute to do
nothing. The filter stays **stateless**: as soon as a PR becomes mergeable again
it reappears on its own, so there is nothing to remember and nothing to forget.

What the guard discards is not what the **entry filter** discards. A PR off the
allowlist or carrying a red flag is a decision to explain in the report; it
therefore keeps waking the agent.

Two traps learned in use:

- **The executed copy lives outside the repo**, in `~/.shadok-ai/checks/`. A
  versioned path (`.claude/skills/…`) breaks as soon as an agent changes the root
  checkout's branch — the file disappears and the guard fails silently. The source
  of truth stays here; copy it over after a change.
- **A session loop (`/loop`) is not enough**: it dies with the session, expires
  after 7 days, and wakes the LLM at every slot even with no PR.

## Red flags — stop and ask the human

- The PR touches `.github/workflows/` — **always**, even if the rest is clean.
- The author is off the allowlist, or the PR comes from a fork.
- It would take a force-push, deleting a branch or a worktree, or restarting the
  shadok-ai server.
- The conflict resolution does not explain itself in one sentence.

## Report

One line per PR handled, opened by a marker that is spottable while scrolling —
between two actions there can be twenty silent passes, and a line of plain text
drowns in them:

```
✅ MERGED #83 — <title> (`<sha>`) → 0.1.160
⏭ UPDATE-BRANCH #82 — behind main, CI checked on the next pass
⚠️ #77 — base `worktree-x`, not `main`: outside the filter, untouched
```

A merge's version is the one the CI will publish:
`major.minor.<number of commits on main>`, so after the merge

```bash
git fetch origin -q && git rev-list --count origin/main
```

The running server stays on the previous version for a few minutes, until the
auto-update goes through — that is not a symptom.

Nothing to do — no open PR, or nothing moved since the previous pass — → write
**exactly** this, alone, with nothing around it:

```
NOTHING TO SHOW
```

Nothing else: no "nothing to do", no parenthesised summary, no acknowledgement,
no added punctuation or emoji. It is a **marker, not a sentence**: the human
filters that exact string in the cockpit, so the slightest variant (a
translation, a rewording, lowercase) slips through and pollutes the thread.

Pure silence — a turn with no text at all — was tried and does not work: the
harness re-runs the agent demanding a visible answer. Hence this marker.

A loop running every 5 minutes must leave nothing else behind as long as it is
not acting.
