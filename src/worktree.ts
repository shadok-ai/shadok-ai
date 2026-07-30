import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions } from "./extract.js";

export interface Worktree {
  /** Working directory of the isolated checkout. */
  path: string;
  /** Branch created for this session. */
  branch: string;
  /** Commit the branch forked from (diff baseline). */
  baseSha: string;
  /** The original repository the worktree belongs to. */
  repo: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** True if `cwd` is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/**
 * Creates an isolated git worktree off the repo's current HEAD, on a fresh
 * branch, so an agent's edits stay contained until the user merges them.
 * The checkout lives under ~/.shadok-ai/worktrees to avoid polluting the repo.
 */
export function createWorktree(repo: string, tag: string): Worktree {
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  const repoName = path.basename(path.resolve(repo)).replace(/[^a-zA-Z0-9._-]/g, "-");
  const branch = `shadok-ai/${tag}`;
  const dir = path.join(os.homedir(), ".shadok-ai", "worktrees", `${repoName}-${tag}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, ["worktree", "add", "-b", branch, dir, baseSha]);
  return { path: dir, branch, baseSha, repo };
}

/**
 * Removes a worktree only if it has no uncommitted changes (git refuses a
 * dirty removal without --force, which we intentionally don't pass — work is
 * never discarded automatically).
 */
export function removeWorktreeIfClean(wt: Worktree): void {
  try {
    git(wt.repo, ["worktree", "remove", wt.path]);
  } catch {
    // Dirty or has commits: leave it in place for the user to merge/inspect.
  }
}

/**
 * Cleanup when a session ends: remove its worktree checkout if it has no
 * uncommitted changes (`git worktree remove` without --force refuses a dirty
 * tree — work is never discarded), and delete its branch only if it has NO
 * commits beyond the base (an agent that did nothing). A branch with commits
 * survives so the work stays recoverable (listPastSessions / the recover panel).
 * Returns what happened, for logging. A repo-root session (no `shadok-ai/`
 * branch) is a no-op.
 */
export function pruneWorktree(repo: string, branch: string | null | undefined): "removed" | "kept" | "none" {
  if (!branch || !branch.startsWith("shadok-ai/")) return "none";
  const tag = branch.replace(/^shadok-ai\//, "");
  const repoName = path.basename(path.resolve(repo)).replace(/[^a-zA-Z0-9._-]/g, "-");
  const dir = path.join(os.homedir(), ".shadok-ai", "worktrees", `${repoName}-${tag}`);
  // 1) Remove the checkout, but only if it's clean (no uncommitted changes).
  if (fs.existsSync(dir)) {
    try {
      git(repo, ["worktree", "remove", dir]);
    } catch {
      return "kept"; // dirty → preserve the whole worktree (and its branch)
    }
  } else {
    try {
      git(repo, ["worktree", "prune"]);
    } catch {
      /* ignore */
    }
  }
  // 2) Delete the branch only if it carries no commits beyond the base.
  try {
    const base = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const ahead = Number(git(repo, ["rev-list", "--count", `${base}..${branch}`]) || "0");
    if (ahead === 0) {
      git(repo, ["branch", "-D", branch]);
      return "removed";
    }
  } catch {
    /* ignore */
  }
  return "kept"; // checkout gone but the branch (with commits) stays recoverable
}

/**
 * Ensures a worktree checkout exists at `dir` for `branch`, recreating it
 * from the branch if it was removed. Lets a past session be reopened even
 * after its folder was reclaimed (the branch always survives).
 */
export function ensureWorktreeCheckout(repo: string, branch: string, dir: string): boolean {
  if (fs.existsSync(dir)) return true;
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, ["worktree", "add", dir, branch]);
    return true;
  } catch {
    return false;
  }
}

export interface PastSession {
  branch: string;
  /** Full session id (from the transcript), or null if none was recorded. */
  sessionId: string | null;
  /** Worktree checkout path (may not exist on disk). */
  cwd: string;
  dirExists: boolean;
  /** First user prompt of the session, for recognition. */
  preview: string;
  /** Commits ahead of the base branch. */
  commits: number;
  /** Whether the branch has any diff vs the base. */
  hasChanges: boolean;
  /** Last activity (ms since epoch). */
  mtime: number;
}

/**
 * Lists every past shadok-ai worktree session of a repo — recoverable from
 * their branch even if the checkout was reclaimed — newest first, so
 * unfinished work can be reopened and continued.
 */
export function listPastSessions(repo: string): PastSession[] {
  let base = "main";
  try {
    base = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return [];
  }
  let branches: string[];
  try {
    branches = git(repo, ["branch", "--list", "shadok-ai/*", "--format=%(refname:short)"])
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  const repoName = path.basename(path.resolve(repo)).replace(/[^a-zA-Z0-9._-]/g, "-");
  const out: PastSession[] = [];
  for (const branch of branches) {
    const tag = branch.replace(/^shadok-ai\//, "");
    const cwd = path.join(os.homedir(), ".shadok-ai", "worktrees", `${repoName}-${tag}`);
    // The transcript lives in the worktree's project dir even if the checkout
    // was removed — read the full session id and preview from there.
    const sess = listSessions(cwd)[0] ?? null;
    let commits = 0;
    let hasChanges = false;
    try {
      commits = Number(git(repo, ["rev-list", "--count", `${base}..${branch}`]) || "0");
      hasChanges = git(repo, ["diff", "--shortstat", base, branch]).trim() !== "";
    } catch {
      // ignore
    }
    out.push({
      branch,
      sessionId: sess?.id ?? null,
      cwd,
      dirExists: fs.existsSync(cwd),
      preview: sess?.preview ?? "",
      commits,
      hasChanges,
      mtime: sess?.mtime ?? 0,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export interface DiffResult {
  status: string;
  diff: string;
  branch: string | null;
}

/**
 * Returns the changes made in `cwd`: `git status` plus the full diff. With a
 * known baseline (worktree), diffs against the fork point so committed work
 * shows too; otherwise diffs the working tree against HEAD.
 */
export function gitDiff(cwd: string, baseSha?: string | null): DiffResult {
  let status = "",
    diff = "",
    branch: string | null = null;
  try {
    branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    status = git(cwd, ["status", "--short"]);
    diff = git(cwd, ["diff", baseSha ?? "HEAD"]);
    // Include untracked files (diff doesn't show them).
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean);
    if (untracked.length) {
      const shown = untracked.map((f) => {
        try {
          const body = git(cwd, ["diff", "--no-index", "/dev/null", f]);
          return body;
        } catch (e: any) {
          // --no-index exits non-zero when files differ; its stdout has the diff.
          return e?.stdout ? String(e.stdout).trimEnd() : `+++ ${f} (untracked)`;
        }
      });
      diff = [diff, ...shown].filter(Boolean).join("\n");
    }
  } catch {
    // not a repo, or git error — return whatever we gathered
  }
  return { status, diff, branch };
}
