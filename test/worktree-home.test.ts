import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worktreeDir, createWorktree, pruneWorktree, listPastSessions } from "../src/worktree.js";
import { selfRepoDir } from "../src/selfrepo.js";

// The bug these lock: worktrees and the self-repo clone used to anchor on the
// SERVER's home (`os.homedir()` → `/root`), which a privilege-dropped agent
// (`main`, `sk-*`) cannot even TRAVERSE (mode 0700) — so every Tweak agent (and
// any dropped agent given a worktree) landed on Claude Code's invalid-settings
// screen. The fix parameterises the base on the DROP USER's home. These tests
// pin that the base is honoured, is independent of `os.homedir()`, and that
// create / list / prune all agree on it.

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

// ── Pure path resolution ─────────────────────────────────────────────────────

test("worktreeDir: lands under the GIVEN state home, not os.homedir()", () => {
  const home = "/home/main";
  const dir = worktreeDir(home, "/srv/my-repo", "abcd1234");
  assert.equal(dir, path.join(home, ".shadok-ai", "worktrees", "my-repo-abcd1234"));
  // The whole point: the path is NOT under the server's own home.
  assert.ok(!dir.startsWith(os.homedir() + path.sep) || os.homedir() === home);
});

test("worktreeDir: sanitises the repo basename", () => {
  const dir = worktreeDir("/home/sk-x", "/srv/weird repo!name", "t");
  assert.equal(path.basename(dir), "weird-repo-name-t");
});

test("selfRepoDir: lands under the GIVEN state home", () => {
  assert.equal(selfRepoDir("/home/main"), path.join("/home/main", ".shadok-ai", "self", "shadok-ai"));
});

test("selfRepoDir / worktreeDir default to the server's own home (mono-tenant unchanged)", () => {
  const prev = process.env.HOME;
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
  process.env.HOME = fake;
  try {
    assert.ok(selfRepoDir().startsWith(os.homedir()));
    assert.ok(worktreeDir(os.homedir(), "/r/x", "t").startsWith(os.homedir()));
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

// ── End-to-end: create / list / prune honour one explicit state home ──────────

test("createWorktree + listPastSessions + pruneWorktree agree on an explicit state home", () => {
  // A state home DISTINCT from os.homedir(): proves the checkout follows the
  // argument, the exact regression (a dropped agent's home, never the server's).
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "cp-statehome-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cp-wt-repo-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");

    const wt = createWorktree(repo, "abcd1234", stateHome);
    assert.equal(wt.branch, "shadok-ai/abcd1234");
    // The checkout is under the explicit state home…
    assert.ok(
      wt.path.startsWith(stateHome + path.sep),
      `checkout ${wt.path} must be under the given state home ${stateHome}`,
    );
    // …and NOT under the server's own home (the whole bug).
    assert.ok(!wt.path.startsWith(os.homedir() + path.sep), "checkout must not be under os.homedir()");
    assert.ok(fs.existsSync(wt.path), "checkout exists on disk");

    // list must compute the checkout path under the SAME home it was created in.
    const found = listPastSessions(repo, stateHome).find((s) => s.branch === "shadok-ai/abcd1234");
    assert.ok(found, "listPastSessions finds the branch");
    assert.ok(found!.cwd.startsWith(stateHome + path.sep), "and its cwd is under the given home");
    // With the server's home it points elsewhere — never into the drop user's home.
    const wrong = listPastSessions(repo, os.homedir()).find((s) => s.branch === "shadok-ai/abcd1234");
    assert.ok(wrong && !wrong.cwd.startsWith(stateHome + path.sep), "a different home yields a different cwd");

    // prune (no commits, clean) must find + remove the same checkout.
    const outcome = pruneWorktree(repo, "shadok-ai/abcd1234", stateHome);
    assert.equal(outcome, "removed");
    assert.ok(!fs.existsSync(wt.path), "checkout removed");
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
