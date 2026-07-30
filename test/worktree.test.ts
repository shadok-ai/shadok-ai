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
} from "../src/worktree.js";

/** A throwaway git repo + temp HOME (worktrees land under ~/.shadok-ai). */
function withRepo(fn: (repo: string) => void) {
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-wt-home-"));
  process.env.HOME = home;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cp-wt-repo-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  try {
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
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
    assert.match(wt.baseSha, /^[0-9a-f]{40}$/);
  });
});

test("gitDiff: shows both tracked edits and untracked files vs the base", () => {
  withRepo((repo) => {
    const wt = createWorktree(repo, "diff1");
    fs.appendFileSync(path.join(wt.path, "a.txt"), "world\n"); // tracked edit
    fs.writeFileSync(path.join(wt.path, "new.txt"), "brand new\n"); // untracked
    const d = gitDiff(wt.path, wt.baseSha);
    assert.match(d.branch ?? "", /shadok-ai\/diff1/);
    assert.match(d.diff, /a\.txt/);
    assert.match(d.diff, /\+world/);
    assert.match(d.diff, /new\.txt/); // untracked surfaced
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
