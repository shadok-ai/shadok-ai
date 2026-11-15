import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitIn, isDubiousOwnership, ownerGitCommand, passwdEntry } from "../src/git-exec.js";

test("isDubiousOwnership: recognises git's refusal, nothing else", () => {
  assert.equal(isDubiousOwnership({ stderr: "fatal: detected dubious ownership in repository at '/x'\n" }), true);
  assert.equal(isDubiousOwnership({ stderr: Buffer.from("fatal: detected dubious ownership in repository") }), true);
  assert.equal(isDubiousOwnership({ stderr: "fatal: not a git repository" }), false);
  assert.equal(isDubiousOwnership(null), false);
});

test("passwdEntry: name + home by uid; absent → nulls", () => {
  const pw = "root:x:0:0:root:/root:/bin/bash\nmain:x:1000:1000::/home/main:/bin/sh\n";
  assert.deepEqual(passwdEntry(pw, 1000), { name: "main", home: "/home/main" });
  assert.deepEqual(passwdEntry(pw, 4242), { name: null, home: null });
});

test("ownerGitCommand: setpriv to the owner's ids, never a safe.directory exception", () => {
  const r = ownerGitCommand({ uid: 1000, gid: 1000, name: "main", home: "/home/main" }, "/r", ["fetch", "origin"]);
  assert.equal(r.cmd, "setpriv");
  assert.deepEqual(r.argv, ["--reuid", "1000", "--regid", "1000", "--init-groups", "--", "git", "-C", "/r", "fetch", "origin"]);
  assert.deepEqual(r.env, { HOME: "/home/main", USER: "main", LOGNAME: "main" });
  assert.ok(!r.argv.some((a) => a.includes("safe.directory")));
  // No passwd row: numeric ids, no root groups, HOME off /root.
  const n = ownerGitCommand({ uid: 4242, gid: 4242, name: null, home: null }, "/r", ["status"]);
  assert.ok(n.argv.includes("--clear-groups") && !n.argv.includes("--init-groups"));
  assert.deepEqual(n.env, { HOME: "/r" });
});

// End to end, the shape that broke Tweak: root runs git in a repo another user owns.
const canDrop = (() => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return false;
  try { execFileSync("setpriv", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
test("gitIn: a repo owned by another user — plain git refuses, gitIn runs it as the owner", { skip: !canDrop && "needs root + setpriv" }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gitin-"));
  try {
    fs.chmodSync(base, 0o755);
    const repo = path.join(base, "r");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("chown", ["-R", "65534:65534", repo]);
    assert.throws(
      () => execFileSync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" }),
      (e: unknown) => isDubiousOwnership(e),
    );
    assert.equal(gitIn(repo, ["rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "pipe"] }).trim(), "true");
    // It really ran as the owner: a file git writes is theirs, not root's.
    // (`symbolic-ref` rewrites HEAD through a lock file + rename, so the new file
    // carries the writer's uid.)
    gitIn(repo, ["symbolic-ref", "HEAD", "refs/heads/elsewhere"], { stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(fs.statSync(path.join(repo, ".git", "HEAD")).uid, 65534);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("createWorktree off a repo another user owns lands, owned by them (the Tweak path)", { skip: !canDrop && "needs root + setpriv" }, async () => {
  const { createWorktree, isGitRepo } = await import("../src/worktree.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gitin-wt-"));
  try {
    fs.chmodSync(base, 0o755);
    const home = path.join(base, "home");
    const repo = path.join(home, ".shadok-ai", "self", "r");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    execFileSync("chown", ["-R", "65534:65534", home]);
    assert.equal(isGitRepo(repo), true); // was false: the refusal read as "not a repo"
    const wt = createWorktree(repo, "abcd1234", home);
    assert.ok(fs.existsSync(path.join(wt.path, ".git")));
    assert.equal(fs.statSync(wt.path).uid, 65534);
    assert.equal(fs.statSync(path.dirname(wt.path)).uid, 65534);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
