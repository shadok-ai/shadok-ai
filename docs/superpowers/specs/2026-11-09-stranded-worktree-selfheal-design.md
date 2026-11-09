# Self-heal stranded worktrees after an interrupted MT migration

## Problem

The root→non-root multi-tenant migration (`migrate-groups.ts`) relocates each
agent's worktree into the drop user's own home and respawns it there. The run is
**one-shot**, gated by a marker (`groups-migrated.json`). When it is **interrupted**
— a container restart mid-run, where the `chown -R` is seconds long and the
respawn step kills and re-adopts panes — it leaves a *partial* state the marker
then freezes:

- some agents' worktrees stay under `/root/.shadok-ai/worktrees/…`, which the drop
  user cannot even traverse (`/root` is `0700`), so those agents can only run as
  **root** ("stuck on root");
- the launch repo (`process.cwd()`) can stay `root:root`, so a commons (`main`)
  agent hits git's *dubious ownership* and cannot write `.git` (no commits).

Measured live on the dogfood instance: `main`-owned worktrees trapped under
`/root`, launch repo `root:root`, a mix of working (`main`) and stuck (`root`)
agents, marker present.

## Fix (code, idempotent, marker-independent)

Two healers in `ensureGroupsProvisioned`, which already runs on every capable boot
(twins of `healCommonsStrandedScripts` / `healServerOwnedState`):

1. **`reassertCommonsRepoOwnership`** — if the launch repo is not `main`-owned
   (one `stat`), `chown -R` it to `main`. Completes the migration's core chown.

2. **`healStrandedWorktrees`** — `strandedWorktreePlan` (pure, `worktree-relocate.ts`)
   lists every channel whose drop user **cannot reach** its checkout, with the
   canonical home it belongs in (`<drop-home>/.shadok-ai/worktrees/<name>`). A
   working, already-migrated agent (reachable checkout) is never touched. For each
   stranded one: stop the pane, **copy** the checkout to the canonical home (copy,
   never move — a failure never loses work), `git worktree repair`, chown the
   checkout and the external git admin dir to the drop user, carry the transcript
   across (best-effort), repoint the channel `cwd`, then remove the stale source.
   The agent resumes as its drop user. Idempotent (reachable next boot → skipped),
   fail-safe per agent.

## Non-goals / limits

- Not a replacement for the migration; it finishes an interrupted one.
- `/home` on the overlay (not the volume) is an INFRA concern (mount the home base
  on the volume so relocated worktrees + login credentials survive a recreate) —
  orthogonal to this code.
- The privileged `cp`/`chown`/`git`/drop path only exercises on a real migrated
  container; the pure plan is unit-tested, the impure steps are best-effort and
  logged. Human-verify on a copy of a real migrated volume before relying on it.
