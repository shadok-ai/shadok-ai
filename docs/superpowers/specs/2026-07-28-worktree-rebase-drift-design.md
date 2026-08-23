# Design — Agent worktrees no longer drift from main

Date: 2026-07-28
Status: **agreed (brainstorming), implementation deferred** — an explicit
decision of 2026-07-28: we keep the design on the shelf, we do not code it now.
**Except section 1 ("remove `baseSha`"), delivered on 2026-08-09**: it stands on
its own, it settles pain #3 without any rebase, and it removes a field of state.
Sections 2 to 5 and the open questions stay as they are.

> **Re-posted on 2026-08-08.** This file was written before the migration to
> `shadok-ai/shadok-ai` and had never been merged: the new history has no common
> ancestor with the branch that carried it, so it was **copied over**, not
> rebased. The design's content is unchanged.
>
> Its code citations now carry **symbol names only**. The original version gave
> line numbers and they drifted **three times** in ten days — `src/server.ts` went
> from ~1200 to 2244 lines, one and the same reference moving from 181 to 338 and
> then to 611. A wrong number is worse than none: it sends the reader into the
> wrong function with an air of precision. (`CLAUDE.md`, the Conventions section,
> now asks for the same thing everywhere.)

## Problem

An agent's worktree is forked from the repo's `HEAD` **at spawn time**
(`createWorktree`, `src/worktree.ts`) and `baseSha` is frozen once and for all.
Nothing in the code ever revisits that base: no `fetch`, no `rebase`, no
`merge-base`. Every agent lives in the repo's past.

Observed on 2026-07-28: `shadok-ai/0e330518` is 4 days old, `main` is at
`3cbb520`, several PRs landed in between.

The four pains, all kept as things to address:

1. **Conflicts at landing time** — main moved, and the merge goes into conflict.
2. **An agent working on stale code** — it rewrites code already fixed on main,
   or starts from an API that no longer exists.
3. **An unreadable diff** — `gitDiff` does `git diff <baseSha>`
   (`src/worktree.ts`, called from `src/server.ts`) against a SHA several days
   old, so the panel also shows what main changed.
4. **Agents stepping on each other** — two parallel agents touch the same files
   without knowing it.

## The path rejected (and why)

**Rebasing server-side, in a window while the agent is idle.** Rejected.

The available idleness signals are not solid enough to justify mutating the disk
under an agent:

- `turn-done` does not mean "the agent is done", only "this turn is done". The
  "spontaneous resume" (`src/server.ts`) exists precisely because the model
  starts again on its own, with no client prompt.
- `!s.busy` can mean "suspended on a dialog": in `finishTurn`, when
  `detectDialog` matches, we set `busy = false` anyway (`src/server.ts`).
- `screenShowsWork` (`src/detect.ts`) is screen scraping, documented as fragile
  (CLAUDE.md, gotcha #2). A false negative currently costs a blinking gauge;
  wired to a `git rebase`, it would cost a tree rewritten under an agent that is
  editing.
- `Bash` calls launched in the background keep writing while the screen is idle.

One decisive argument on top: a server-side `git rebase` that hits a conflict has
nobody to settle it — all it can do is `--abort`. The agent, on the other hand,
is the only actor that knows what its own change meant.

*(A variant noted should the subject come back: not **detecting** idleness but
**manufacturing** it, taking `s.busy` as a mutex — prompts are already refused
when the session is busy — the two `hasExited || s.busy` guards in
`src/server.ts`. Not adopted: it does not solve conflicts, and covers neither
background bash calls nor the human typing directly into the `sk-*` tmux.)*

## The decision: the act to the agent, the signal and the accounting to the server

- **The agent** rebases, resolves the conflicts, or gives up and asks the human.
  It acts in its own flow, so **no idleness detection, no mutex, no scraping**.
- **The server** is the only one that sees the repo and every worktree: it detects
  the lag, announces it, and keeps the diff's accounts.

A prompt alone is not enough, for three structural reasons:

1. **The agent does not know main moved** — no event reaches it. An instruction
   "remember to rebase regularly" decays over a multi-day session, especially
   after compaction.
2. **`baseSha` breaks** as soon as the agent rewrites its history (see below).
3. **The current guardrails half-forbid it** (see "Prompts").

## Design

### 1. Server — remove `baseSha`, compute the base live

`baseSha` is frozen state that becomes wrong at the first rebase. The replacement
is simpler than what exists: compute the base **live**.

- `gitDiff` diffs three-dot — `git diff <base>...HEAD` — or equivalently against
  `git merge-base <base> HEAD`.
- The result: the panel shows **exactly** the agent's work, whether it rebased,
  merged, or did nothing.
- We **remove a field of state** instead of adding one. `Worktree`'s `baseSha`
  field (`src/worktree.ts`) and its use (`src/server.ts`) disappear.
- A corollary: pain #3 (an unreadable diff) is settled **even without a rebase**.
  That is the one piece with value on its own.

The same treatment for `listPastSessions`, which counts `commits`/`hasChanges`
against `base` two-dot (`src/worktree.ts`).

### 2. Server — detect the lag and inject it into the prompt

- Compare the worktree's branch to the repo's current branch (as
  `listPastSessions` already does, `src/worktree.ts`):
  `git rev-list --count <branch>..<base>`.
- When the lag is > 0, **prefix the next prompt** with a note along the lines of
  "`main` has moved N commits ahead of your fork".
- Why injecting into the prompt rather than a static line in
  `context/pilot-prompt.md`: the context is **fresh at the moment it matters**,
  does not decay with compaction, and **disappears on its own** once there is no
  lag left. No polling, no detection.
- Also show the lag on the channel in the cockpit.

### 3. Skill — the rebase procedure

A dedicated skill (`.claude/skills/shadok-rebase/`) carries the procedure, to
keep `pilot-prompt.md` short:

1. **A WIP commit first, never a stash.** `git rebase` refuses a dirty tree, so
   the agent has to do something with its work in progress. A `wip:` commit on
   its own branch is visible in the diff panel, survives everything, and comes
   undone with `reset --soft`. A stash is invisible from the cockpit and is lost
   for good if the rebase goes wrong — that would violate invariant #5 ("work is
   never thrown away").
2. **Rebase, not merge.** These branches are disposable and destined to land in
   main; a linear history reviews and lands infinitely better than a
   `Merge branch 'main' into shadok-ai/xxx` every other day. The only argument for
   merging was "it does not break `baseSha`" — and that falls away with the move
   to the merge-base.
3. **On a conflict**: the agent resolves it when the conflict belongs to its own
   change. Otherwise `git rebase --abort` — which restores exactly the previous
   state — and it asks the human. So the worst case is "nothing happened".
4. **Re-run the build** after a rebase (`npm run build`), since the base changed
   under the work in progress.

### 4. Timing: at the start of the turn, on the agent's own initiative

The agent rebases **of its own accord** when told about the lag, without being
asked, and **before** handling the human's request.

Rebasing afterwards would mean resolving conflicts on code just written — twice
the surface. Since the server only informs the agent when it really is behind,
the case stays rare.

### 5. Prompts — removing the ambiguity that would make it all fail

Two texts will make the agent refuse to rebase if they stay as they are:

- `context/pilot-prompt.md`: "never merge into the main checkout or another
  worktree".
- The Shadok-dev role (`src/profiles.ts`): "never merge into main yourself".

Both speak of pushing **into** main. An agent will over-read them and refuse the
opposite — pulling main **into** its branch. It has to be explicitly allowed.

Also worth noting: `Bash(git rebase:*)` is in `READONLY_DENY`
(`src/profiles.ts`). That is correct and to be kept — the marketing and support
profiles must not rebase.

## Open questions

Raised, not settled at the time of deferral:

1. **Is "the start of the turn" acceptable?** It can delay an urgent request by
   several minutes. An alternative: rebase only on request, or only past a lag
   threshold.
2. **Should the server `git fetch origin` on its own**, or settle for `main` as
   it stands on disk? The local one is enough if the human pulls their PRs;
   otherwise the lag is underestimated.

## Success criteria

1. The diff panel of an agent that rebased shows only its own work, not main's.
2. The same for an agent that did not rebase and whose base is several days old
   (the merge-base fix stands on its own).
3. An agent that is behind receives the information in its prompt, with no
   polling.
4. An agent with uncommitted work that rebases loses nothing: the WIP is visible
   in the diff panel before as well as after.
5. A rebase with an unresolvable conflict leaves the worktree **exactly** as it
   was and raises the question to the human.
6. A read-only profile (marketing/support) still cannot rebase.
7. `npm run build` OK, verified **on a free port alongside** (never by taking
   over 3789 — invariant 8; see "Running YOUR build" in `CLAUDE.md`), in the
   browser.
