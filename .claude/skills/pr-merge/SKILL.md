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

`isCrossRepository: true` (a fork) → **never merged**, reported. One thing the
loop may do for it: unblock its CI — see "Approving a fork's workflows" below.

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
**without an LLM**, and its output is prepended to the prompt, so a quiet
repository costs **0 tokens** and leaves nothing in the thread.

It sorts open PRs into two kinds, because they do not deserve the same
treatment:

- **ACT** — non-draft, onto `main`, not a fork, not conflicted. The loop can
  merge it, so it is printed **every** pass. Repeated wakes are self-limiting:
  the PR leaves the list once merged.
- **TELL** — a **fork** (a "Tweak Shadok-AI" delivery is one, and on a public
  repo anyone can open one) or a **conflicted** PR. The loop never merges these;
  a human decides. They are printed **only when their state changed**, tracked in
  `~/.shadok-ai/checks/pr-open.state`.

That split exists because both extremes were tried and both were wrong. Printing
everything meant one stuck PR woke the agent every minute, forever, to answer
"not mine". Filtering forks out entirely removed the noise *and* the signal — a
Tweak delivery then sat unseen. Change detection keeps the news and drops the
repetition.

State is rewritten on every pass, including for PRs that left the list: a PR
reopened later must be announced again, not swallowed because it was seen once.

It also watches **the release path**, which nothing else does, in two ways: a
publish run that FAILED, and a merge that produced no published version at all —
the second one caught #123, which landed while neither Publish nor CI ever
started. The comparison is the tip of `main` against the commit npm records for
its newest version (`gitHead`), so it needs no knowledge of the numbering rule,
and it waits **15 minutes** before counting a gap: publishing takes a few
minutes, so a fresh tip is normal rather than news.

Use the newest published VERSION, never the `alpha` tag, as the high-water mark.
A publish that completes late sets the tag to its own, older version — 0.6.1
landed after 0.6.2 and dragged `alpha` backwards — so the tag can move down while
the registry only ever moves up. A failed publish
is silent: `verify` was green on the PR, the merge went through, and the version
simply never appears on npm. 0.4.115 died exactly that way and went unnoticed for
four merges — by the time a publish fails, its PR is closed, so a watcher looking
at open PRs cannot see it. Only the LAST run counts, and only while it is
failing; it is reported once per run id, so a broken release does not re-wake the
agent every minute. When a later run goes green, the state is cleared and the old
failure stops being news.

Two traps learned the hard way:

- **The executed copy lives outside the repo**, in `~/.shadok-ai/checks/`. A
  versioned path (`.claude/skills/…`) breaks as soon as an agent changes the root
  checkout's branch — the file disappears and the guard fails silently. The source
  of truth stays here; copy it over after a change.
- **A session loop (`/loop`) is not enough**: it dies with the session, expires
  after 7 days, and wakes the LLM at every slot even with no PR.

## Approving a fork's workflows

A fork PR arrives with **no checks at all**: GitHub holds its workflows until a
maintainer clicks *Approve workflows to run*. `statusCheckRollup` is empty, and
`mergeStateStatus` reads `UNSTABLE` — which looks exactly like "CI is running"
and is not. Left alone the PR sits forever, neither green nor red, so nobody can
tell a sound delivery from a broken one. Both happened on the same day: one Tweak
delivery was fine, the next failed its own test.

The loop approves the run when — and only when — **the PR touches no file under
`.github/`**:

```bash
sha=$(gh pr view N --json headRefOid --template '{{.headRefOid}}')
gh api "repos/shadok-ai/shadok-ai/actions/runs?head_sha=$sha" \
  --jq '.workflow_runs[] | select(.conclusion=="action_required") | .id'
gh api -X POST repos/shadok-ai/shadok-ai/actions/runs/<id>/approve
```

That condition is the whole safety of it. Approving runs the fork's code in our
CI, with the repository's own permissions; a fork that also **edits a workflow**
could run anything it likes there. A fork that only changes application code is
confined to what the existing workflows already do — install, build, test.

Approving is not merging. It buys a verdict, nothing else: the PR still comes
from a fork, so it still waits for a human.

## After a merge: record it in the ledger

A merged PR is a **state change** sibling agents will not otherwise see: they do
not re-read `main`, so work already shipped keeps coming back in their reports
and their plans. After each merge:

```bash
node ~/.claude/skills/shadok-ledger/ledger.mjs record \
  --entity "<the subject, not the PR title>" --status resolved \
  --note "<what it changes, and what stays open>" --source "PR#<n> / PR loop"
```

The **entity is the subject**, not the number: "web forms overshoot on tmux",
never "PR 173" — a number means nothing to an agent hitting the same symptom
next week. It is a state TABLE: re-recording an entity **supersedes** its row,
so a follow-up PR updates the existing line (`--id <id>`) instead of forking a
second one, and a row an authoring agent already left as `in-progress` gets
closed rather than duplicated.

Worth a row: a behaviour fix, a failure class closed, a version promotion, a
decision. Not worth one: an isolated cosmetic tweak.

Say what stays OPEN too. "Merged, but macOS is only unit-tested" is what stops
the next agent asserting the whole thing is covered.

## Red flags — stop and ask the human

- The PR touches `.github/workflows/` — **always**, even if the rest is clean.
- The author is off the allowlist, or the PR comes from a fork. (Unblocking a
  fork's CI is the one exception, and it is bounded — see "Approving a fork's
  workflows". Merging it never is.)
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
