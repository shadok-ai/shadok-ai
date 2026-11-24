import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIsolatedClone, needsClone, isOwnClone, pruneWorktree, gitDiff, worktreeDir } from "../src/worktree.js";
import { passwdOwner } from "../src/git-exec.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trimEnd();

// The privileged parts (setpriv, chown) need root; the test runs as whoever it
// is and injects a plain git and a recording chown. What is exercised is the
// whole flow the server runs: bundle, clone, branch, base, origin, prune, diff.
function withSetup(fn: (repo: string, home: string, chowns: string[]) => void) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cl-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cl-home-"));
  const chowns: string[] = [];
  try {
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", "https://example.invalid/team/project.git");
    fn(repo, home, chowns);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const user = { uid: 4242, gid: 4242, name: "sk-group", home: null };
const deps = (chowns: string[]) => ({
  gitAsUser: (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: ENV }),
  chown: (p: string) => void chowns.push(p),
});

test("needsClone: only when the agent's OS user is not the repo's owner", () => {
  assert.equal(needsClone(1001, { uid: 1001, gid: 1001, name: "main", home: null }), false);
  assert.equal(needsClone(1001, user), true);
  assert.equal(needsClone(1001, null), false); // mono-tenant / no drop
  assert.equal(needsClone(null, user), false); // unknown owner: the old path reports it
});

test("passwdOwner reads a user's ids and home by name", () => {
  const passwd = "root:x:0:0::/root:/bin/sh\nsk-group:x:4242:4243::/home/sk-group:/bin/sh\n";
  assert.deepEqual(passwdOwner(passwd, "sk-group"), { uid: 4242, gid: 4243, name: "sk-group", home: "/home/sk-group" });
  assert.equal(passwdOwner(passwd, "nobody"), null);
});

test("a clone of its own: same place and branch as a worktree, base recorded, origin kept", () => {
  withSetup((repo, home, chowns) => {
    const head = git(repo, "rev-parse", "HEAD");
    const wt = createIsolatedClone(repo, "abcd1234", home, user, deps(chowns));
    assert.equal(wt.path, worktreeDir(home, repo, "abcd1234"));
    assert.equal(wt.branch, "shadok-ai/abcd1234");
    assert.ok(isOwnClone(wt.path));
    assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), "shadok-ai/abcd1234");
    assert.equal(git(wt.path, "rev-parse", "HEAD"), head);
    assert.equal(git(wt.path, "config", "shadok.base"), head);
    assert.equal(git(wt.path, "remote", "get-url", "origin"), "https://example.invalid/team/project.git");
    assert.equal(fs.readFileSync(path.join(wt.path, "a.txt"), "utf8"), "hello\n");
    // the repo itself is untouched: no worktree registered, no branch added
    assert.doesNotMatch(git(repo, "worktree", "list"), /abcd1234/);
    assert.doesNotMatch(git(repo, "branch", "--list"), /abcd1234/);
    // the parents it created and the bundle went to the group's user
    assert.ok(chowns.some((p) => p.endsWith("worktrees")));
    assert.ok(chowns.some((p) => p.endsWith("repo.bundle")));
  });
});

test("diff: against the recorded base even after the repo moved on", () => {
  withSetup((repo, home, chowns) => {
    const wt = createIsolatedClone(repo, "d1", home, user, deps(chowns));
    fs.writeFileSync(path.join(repo, "later.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "repo moves on");
    fs.writeFileSync(path.join(wt.path, "a.txt"), "hello\nmine\n");
    git(wt.path, "commit", "-qam", "agent work");
    const d = gitDiff(wt.path, repo);
    assert.match(d.diff, /\+mine/);
    assert.doesNotMatch(d.diff, /later\.txt/);
  });
});

test("prune: an untouched clone goes, one with work stays", () => {
  withSetup((repo, home, chowns) => {
    const empty = createIsolatedClone(repo, "e1", home, user, deps(chowns));
    assert.equal(pruneWorktree(repo, empty.branch, home), "removed");
    assert.equal(fs.existsSync(empty.path), false);

    const dirty = createIsolatedClone(repo, "e2", home, user, deps(chowns));
    fs.writeFileSync(path.join(dirty.path, "new.txt"), "wip\n");
    assert.equal(pruneWorktree(repo, dirty.branch, home), "kept");

    const committed = createIsolatedClone(repo, "e3", home, user, deps(chowns));
    fs.writeFileSync(path.join(committed.path, "a.txt"), "changed\n");
    git(committed.path, "commit", "-qam", "work");
    assert.equal(pruneWorktree(repo, committed.branch, home), "kept");
    assert.ok(fs.existsSync(committed.path));
  });
});
