import path from "node:path";

/**
 * Self-heal for a PARTIALLY-migrated multi-tenant instance.
 *
 * The root→non-root migration relocates a commons/group agent's state into the
 * drop user's OWN home and respawns it there. When that migration is interrupted
 * (a container restart mid-run — the `chown -R` is seconds long, and the respawn
 * kills and re-adopts panes), some agents are left with their worktree stranded
 * under the SERVER's tree (e.g. `/root/.shadok-ai/worktrees/…`), which the drop
 * user cannot even traverse (`/root` is mode 700). The agent then can only run as
 * root — "stuck on root" — and the marker is already written, so the one-time
 * migration will not re-run to finish the job.
 *
 * This module computes WHICH worktrees are stranded and WHERE each must move, so
 * a boot reconcile can finish what the migration started, idempotently.
 */

export interface RelocatableChannel {
  sessionId?: string | null;
  cwd?: string | null;
  group?: string | null;
  repo?: string | null;
  branch?: string | null;
}

export interface WorktreeRelocation {
  sessionId: string;
  from: string;
  to: string;
  user: string;
  repo: string | null;
  branch: string | null;
}

export interface StrandedPlanDeps {
  /** The OS user this channel's agent drops to (commons `main`, a group's
   *  `sk-*`), or null for a public/server-run agent that needs no relocation. */
  dropUserFor: (groupId: string | null | undefined) => string | null;
  /** The drop user's own state HOME (`agentStateHome(user)`), under which its
   *  worktrees belong (`<home>/.shadok-ai/worktrees/<name>`). */
  stateHomeFor: (user: string) => string;
  /** Can that user actually reach AND write this checkout right now? A working,
   *  already-migrated agent answers true and is left untouched; only a truly
   *  unreachable (stranded) worktree is relocated. Injected so the pure plan is
   *  testable without a filesystem. */
  canReach: (user: string, cwd: string) => boolean;
  /** Is this cwd a per-agent worktree at all (not the launch dir itself, which
   *  has no worktree to move)? Injected for the same reason. */
  isWorktreeCwd: (cwd: string) => boolean;
}

/** The canonical home for a worktree currently at `cwd`, for drop user `user`:
 *  same basename, under the user's own `.shadok-ai/worktrees`. */
export function canonicalWorktreeTarget(stateHome: string, cwd: string): string {
  return path.join(stateHome, ".shadok-ai", "worktrees", path.basename(cwd));
}

/**
 * Pure: the worktrees that must be relocated to un-strand their agents.
 *
 * A channel is relocated when ALL hold: it has a session and a worktree cwd; it
 * drops to a real OS user; that user CANNOT currently reach the checkout
 * (stranded); and the canonical target differs from where it sits (a worktree
 * already at its canonical path but still unreachable cannot be helped by a
 * move — left for the caller to log, never relocated onto itself).
 */
export function strandedWorktreePlan(
  channels: readonly RelocatableChannel[],
  deps: StrandedPlanDeps,
): WorktreeRelocation[] {
  const out: WorktreeRelocation[] = [];
  for (const ch of channels) {
    const sessionId = ch.sessionId?.trim();
    const cwd = ch.cwd?.trim();
    if (!sessionId || !cwd) continue;
    if (!deps.isWorktreeCwd(cwd)) continue; // the launch dir has no worktree to move
    const user = deps.dropUserFor(ch.group);
    if (!user) continue; // public / server-run: nothing to drop or relocate
    if (deps.canReach(user, cwd)) continue; // a working agent — never touch it
    const to = canonicalWorktreeTarget(deps.stateHomeFor(user), cwd);
    if (path.resolve(cwd) === path.resolve(to)) continue; // already canonical; a move cannot fix it
    out.push({ sessionId, from: cwd, to, user, repo: ch.repo ?? null, branch: ch.branch ?? null });
  }
  return out;
}
