import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isGitRepo,
  createWorktree,
  ensureWorktreeCheckout,
  gitDiff,
  listPastSessions,
} from "../src/worktree.js";

/** Runs git in `dir` with a fixed identity (CI has no global git config). */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

/** A throwaway git repo + temp HOME (worktrees land under ~/.shadok-ai). */
function withRepo(fn: (repo: string) => void) {
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-wt-home-"));
  process.env.HOME = home;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cp-wt-repo-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    fn(repo);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("isGitRepo: true inside a repo, false outside", () => {
  withRepo((repo) => {
    assert.equal(isGitRepo(repo), true);
    assert.equal(isGitRepo(os.tmpdir()), false);
  });
});

test("createWorktree: isolated checkout on a fresh branch off HEAD", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "abcd1234");
    assert.equal(wt.branch, "shadok-ai/abcd1234");
    assert.ok(fs.existsSync(wt.path), "checkout dir exists");
    assert.ok(fs.existsSync(path.join(wt.path, "a.txt")), "base files present");
  });
});

test("gitDiff: shows both tracked edits and untracked files vs the base", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "diff1");
    fs.appendFileSync(path.join(wt.path, "a.txt"), "world\n"); // tracked edit
    fs.writeFileSync(path.join(wt.path, "new.txt"), "brand new\n"); // untracked
    const d = gitDiff(wt.path, repo);
    assert.match(d.branch ?? "", /shadok-ai\/diff1/);
    assert.match(d.diff, /a\.txt/);
    assert.match(d.diff, /\+world/);
    assert.match(d.diff, /new\.txt/); // untracked surfaced
  });
});

test("gitDiff: a base that moved on stays out of the agent's diff", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "drift1");
    // The base branch lands work of its own AFTER the fork. A frozen fork sha
    // would still be a valid baseline here — the failure this locks is the
    // opposite one: a diff taken against the base's TIP credits the agent with
    // everything main did meanwhile.
    fs.writeFileSync(path.join(repo, "on-main.txt"), "landed elsewhere\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moves on");
    // The agent's own work, in all three shapes the panel must show.
    fs.writeFileSync(path.join(wt.path, "agent.txt"), "committed by the agent\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "agent work");
    fs.appendFileSync(path.join(wt.path, "a.txt"), "world\n"); // uncommitted
    fs.writeFileSync(path.join(wt.path, "new.txt"), "brand new\n"); // untracked

    const d = gitDiff(wt.path, repo);
    assert.doesNotMatch(d.diff, /on-main\.txt/, "the base's own work stays out");
    assert.match(d.diff, /agent\.txt/, "committed agent work shows");
    assert.match(d.diff, /\+world/, "uncommitted edit shows");
    assert.match(d.diff, /new\.txt/, "untracked file shows");
  });
});

test("gitDiff: an agent that rebased onto the moved base still shows only its work", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "drift2");
    fs.writeFileSync(path.join(repo, "on-main.txt"), "landed elsewhere\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moves on");
    fs.writeFileSync(path.join(wt.path, "agent.txt"), "committed by the agent\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "agent work");
    // Pulling the base in is what breaks a frozen sha: the fork point is no
    // longer an ancestor of anything meaningful. A live merge-base follows it.
    git(wt.path, "rebase", "-q", "main");

    const d = gitDiff(wt.path, repo);
    assert.doesNotMatch(d.diff, /on-main\.txt/, "the base's own work stays out");
    assert.match(d.diff, /agent\.txt/, "the agent's work survives the rebase");
  });
});

test("gitDiff: a detached repo HEAD still yields a real baseline", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "detached1");
    git(repo, "checkout", "-q", "--detach"); // e.g. the user is bisecting
    fs.writeFileSync(path.join(wt.path, "agent.txt"), "committed by the agent\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "agent work");

    const d = gitDiff(wt.path, repo);
    assert.match(d.diff, /agent\.txt/, "committed work survives a detached base");
  });
});

test("listPastSessions: a base that moved on doesn't make an idle branch look busy", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "past1"); // the agent does nothing at all
    fs.writeFileSync(path.join(repo, "on-main.txt"), "landed elsewhere\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moves on");

    const past = listPastSessions(repo).find((p) => p.branch === wt.branch);
    assert.ok(past, "the branch is listed");
    assert.equal(past.commits, 0);
    assert.equal(past.hasChanges, false, "main's own commit is not the branch's change");
  });
});

test("ensureWorktreeCheckout: recreates a reclaimed checkout from its branch", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "reopen1");
    // Simulate the checkout dir having been removed (branch survives).
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
    assert.equal(fs.existsSync(wt.path), false);
    const ok = ensureWorktreeCheckout(repo, wt.branch, wt.path);
    assert.equal(ok, true);
    assert.ok(fs.existsSync(path.join(wt.path, "a.txt")));
  });
});
