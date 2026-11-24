import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions } from "./extract.js";
import { foreignOwner, gitAs, gitIn, type Owner } from "./git-exec.js";

export interface Worktree {
  /** Working directory of the isolated checkout. */
  path: string;
  /** Branch created for this session. */
  branch: string;
  /** The original repository the worktree belongs to. */
  repo: string;
}

// Through `gitIn`: under multi-tenant the server is root and these checkouts
// belong to a drop user, which git refuses as "dubious ownership" (src/git-exec.ts).
function git(cwd: string, args: string[]): string {
  return gitIn(cwd, args, {
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
 * What an agent's work is measured against: the tip of whatever the repo itself
 * has checked out (a branch lives in one worktree only, so this is never the
 * agent's own). One definition of "the base", shared by the diff panel and the
 * recover list. Resolved to a commit rather than a name so a detached repo HEAD
 * doesn't yield the literal ref "HEAD" — which, read from inside a worktree,
 * would point at the agent's own tip and hide all of its committed work.
 */
function baseRef(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * The fork point of `ref` off the base branch, computed LIVE rather than
 * frozen at spawn. A stored base sha starts lying the moment the branch is
 * rebased onto a moved base — and a diff against the base's *tip* credits the
 * agent with everything the base did meanwhile. The merge-base is right in
 * both cases.
 */
function forkPoint(cwd: string, repo: string, ref: string): string {
  return git(cwd, ["merge-base", baseRef(repo), ref]);
}

/**
 * The directory a repo's worktree for `tag` lives in — ONE definition shared by
 * create / prune / list so they can never disagree, and PARAMETERISED on the
 * state home. `stateHome` is the server's own home in mono-tenant (and for the
 * commons before migration), but the DROPPED agent's own home (`/home/<user>`)
 * once agents run as a non-root OS user: the server's home is `/root` (mode
 * 0700), which that user cannot even TRAVERSE, so a worktree created there
 * strands the agent on Claude Code's invalid-settings screen — every
 * Tweak-Shadok-AI agent, and any dropped agent given a worktree. Pure. See
 * CLAUDE.md invariant on dropped-agent state homes.
 */
export function worktreeDir(stateHome: string, repo: string, tag: string): string {
  const repoName = path.basename(path.resolve(repo)).replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(stateHome, ".shadok-ai", "worktrees", `${repoName}-${tag}`);
}

/**
 * Creates an isolated git worktree off the repo's current HEAD, on a fresh
 * branch, so an agent's edits stay contained until the user merges them.
 * The checkout lives under `<stateHome>/.shadok-ai/worktrees` (see `worktreeDir`
 * for why that is the DROP USER's home, not always the server's) to avoid
 * polluting the repo. The caller owns making the result writable by the drop
 * user (git runs here as the server); `worktreeDir` only fixes WHERE it lands.
 */
export function createWorktree(repo: string, tag: string, stateHome: string = os.homedir()): Worktree {
  // Resolve HEAD instead of forking off the symbolic name: a commit landing in
  // the repo between these two calls must not move the fork point.
  const head = git(repo, ["rev-parse", "HEAD"]);
  const branch = `shadok-ai/${tag}`;
  const dir = worktreeDir(stateHome, repo, tag);
  const created = fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A repo another user owns is driven AS that user (`gitIn`), so the parent the
  // root server just made must be theirs too, or `worktree add` dies on
  // "could not create leading directories … Permission denied". Only what THIS
  // call created, and only when the repo is not root's: a root-owned repo keeps
  // today's path (the caller chowns the finished checkout).
  const owner = created ? foreignOwner(repo) : null;
  if (created && owner) {
    for (let d = path.dirname(dir); ; d = path.dirname(d)) {
      fs.chownSync(d, owner.uid, owner.gid);
      if (d === created || d === path.dirname(d)) break;
    }
  }
  git(repo, ["worktree", "add", "-b", branch, dir, head]);
  return { path: dir, branch, repo };
}

/**
 * Pure: must an agent running as `user` get a CLONE rather than a worktree of a
 * repo owned by `repoUid`? A worktree shares the repo's `.git` — objects, refs,
 * its own admin dir — so the agent must be able to write there. When it runs as
 * ANOTHER OS user (a private or restricted group), it cannot: the repo is its
 * owner's, and opening it to the group would breach the very wall the group is.
 * Worse, `worktree add` itself runs as the repo's owner (`gitIn`), who cannot
 * traverse the group's 0700 home, so the spawn died on "could not create leading
 * directories … Permission denied". A clone in the group's home is the group's
 * alone.
 */
export function needsClone(repoUid: number | null, user: Owner | null): boolean {
  return !!user && repoUid !== null && repoUid !== user.uid;
}

/**
 * The CLONE twin of `createWorktree`, for an agent whose OS user does not own
 * the repo (`needsClone`). Same place (`worktreeDir`), same branch name, same
 * fork point — so prune and the diff find it — but a repository of its own,
 * owned by `user`.
 *
 * The history crosses as a BUNDLE: the repo's owner writes it (git running in
 * its own repo, as `gitIn` already does), the group's user clones from that
 * file. Neither side ever runs git inside the other's repository, so neither
 * executes configuration the other could plant (hooks, `core.fsmonitor`, a
 * filter) — the reason `safe.directory` is never used here (src/git-exec.ts).
 * `origin` is then pointed at the repo's own `origin` URL, so the agent pushes
 * its branch where everyone else does, with its own credentials. The fork point
 * is recorded as `shadok.base`: the repo's HEAD may later move to a commit this
 * clone never received, and the diff still needs a base.
 */
export interface CloneDeps {
  /** git run AS the group's user (default: `setpriv` through `gitAs`). */
  gitAsUser: (cwd: string, args: string[]) => string;
  chown: (p: string, uid: number, gid: number) => void;
}

export function createIsolatedClone(
  repo: string,
  tag: string,
  stateHome: string,
  user: Owner,
  deps: CloneDeps = {
    gitAsUser: (cwd, args) =>
      gitAs(user, cwd, args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }),
    chown: (p, uid, gid) => fs.chownSync(p, uid, gid),
  },
): Worktree {
  const head = git(repo, ["rev-parse", "HEAD"]);
  const branch = `shadok-ai/${tag}`;
  const dir = worktreeDir(stateHome, repo, tag);
  const created = fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (created) {
    for (let d = path.dirname(dir); ; d = path.dirname(d)) {
      deps.chown(d, user.uid, user.gid);
      if (d === created || d === path.dirname(d)) break;
    }
  }
  // A scratch dir the repo's owner can write the bundle into and the group's
  // user can then read it from: handed to one, then to the other.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadok-bundle-"));
  try {
    const owner = foreignOwner(repo);
    if (owner) deps.chown(tmp, owner.uid, owner.gid);
    const bundle = path.join(tmp, "repo.bundle");
    let current = "";
    try {
      current = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    } catch {
      /* detached HEAD: bundle HEAD alone */
    }
    git(repo, ["bundle", "create", bundle, current || "HEAD"]);
    let originUrl = "";
    try {
      originUrl = git(repo, ["remote", "get-url", "origin"]);
    } catch {
      /* no origin: the clone keeps none either */
    }
    deps.chown(tmp, user.uid, user.gid);
    deps.chown(bundle, user.uid, user.gid);
    deps.gitAsUser(path.dirname(dir), ["clone", "--quiet", "--no-checkout", bundle, dir]);
    deps.gitAsUser(dir, ["checkout", "--quiet", "-b", branch, head]);
    deps.gitAsUser(dir, ["config", "shadok.base", head]);
    if (originUrl) deps.gitAsUser(dir, ["remote", "set-url", "origin", originUrl]);
    else deps.gitAsUser(dir, ["remote", "remove", "origin"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { path: dir, branch, repo };
}

/** Pure-ish: is `dir` a clone of its own (a `.git` DIRECTORY), not a worktree (a `.git` FILE)? */
export function isOwnClone(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
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
export function pruneWorktree(repo: string, branch: string | null | undefined, stateHome: string = os.homedir()): "removed" | "kept" | "none" {
  if (!branch || !branch.startsWith("shadok-ai/")) return "none";
  const tag = branch.replace(/^shadok-ai\//, "");
  const dir = worktreeDir(stateHome, repo, tag);
  // A clone of its own (`createIsolatedClone`): its branch lives ONLY in it, so
  // the clone goes only when it holds nothing — clean, and no commit past the
  // fork point. Anything else stays, exactly like a dirty worktree.
  if (isOwnClone(dir)) {
    try {
      const dirty = git(dir, ["status", "--porcelain"]);
      const base = git(dir, ["config", "shadok.base"]);
      const ahead = Number(git(dir, ["rev-list", "--count", `${base}..HEAD`]) || "0");
      if (dirty || ahead > 0) return "kept";
      fs.rmSync(dir, { recursive: true, force: true });
      return "removed";
    } catch {
      return "kept";
    }
  }
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
export function listPastSessions(repo: string, stateHome: string = os.homedir()): PastSession[] {
  let base: string;
  try {
    base = baseRef(repo);
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
  const out: PastSession[] = [];
  for (const branch of branches) {
    const tag = branch.replace(/^shadok-ai\//, "");
    const cwd = worktreeDir(stateHome, repo, tag);
    // The transcript lives in the worktree's project dir even if the checkout
    // was removed — read the full session id and preview from there.
    const sess = listSessions(cwd)[0] ?? null;
    let commits = 0;
    let hasChanges = false;
    try {
      // `base..branch` already means "reachable from the branch, not from the
      // base", so the count is the agent's own commits however far the base
      // moved — and it stays right if the agent merged the base in (those
      // commits are reachable from the base, hence excluded).
      commits = Number(git(repo, ["rev-list", "--count", `${base}..${branch}`]) || "0");
      // The diff needed the fix: two-dot compares the two TIPS, so a base that
      // moved on shows up as changes of the branch (inverted, at that).
      hasChanges = git(repo, ["diff", "--shortstat", `${base}...${branch}`]).trim() !== "";
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
 * Returns the changes made in `cwd`: `git status` plus the full diff. Given the
 * originating `repo` (a worktree session), diffs against the fork point off its
 * base branch, so committed work shows too and the base's own work doesn't;
 * otherwise diffs the working tree against HEAD.
 *
 * Note this is the merge-base and not `git diff base...HEAD`: the three-dot
 * form stops at the branch tip, which would hide everything the agent has not
 * committed yet — and uncommitted work is most of what the panel is for.
 */
export function gitDiff(cwd: string, repo?: string | null): DiffResult {
  let status = "",
    diff = "",
    branch: string | null = null;
  try {
    branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    status = git(cwd, ["status", "--short"]);
    let from = "HEAD";
    if (repo) {
      try {
        from = forkPoint(cwd, repo, "HEAD");
      } catch {
        // A clone of its own never received a base the repo moved to since: use
        // the fork point it recorded. Else (unrelated histories, detached
        // base…) fall back to the working tree.
        try {
          from = git(cwd, ["merge-base", git(cwd, ["config", "shadok.base"]), "HEAD"]);
        } catch {
          /* working tree only */
        }
      }
    }
    diff = git(cwd, ["diff", from]);
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
