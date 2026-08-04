import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { SELF_REPO_URL, gitFailReason, selfRepoDir, selfRepoPlan } from "../src/selfrepo.js";

test("selfRepoPlan: absent directory → clone", () => {
  assert.equal(selfRepoPlan(false, false), "clone");
});

test("selfRepoPlan: existing git repo → update", () => {
  assert.equal(selfRepoPlan(true, true), "update");
});

test("selfRepoPlan: directory that is not a repo → reclone", () => {
  // An interrupted first clone leaves a directory with no .git; re-cloning is
  // the only way out, and it must not be mistaken for a repo to fetch into.
  assert.equal(selfRepoPlan(true, false), "reclone");
});

test("gitFailReason: a missing git binary is named as such", () => {
  assert.equal(gitFailReason({ code: "ENOENT" }), "git is not installed");
});

test("gitFailReason: reports git's first real stderr line", () => {
  const e = { stderr: "\n  fatal: could not read from remote repository\nmore noise\n" };
  assert.equal(gitFailReason(e), "fatal: could not read from remote repository");
});

test("gitFailReason: never returns an empty reason", () => {
  // The card renders this string; an empty one would show "⚠  — retry".
  assert.equal(gitFailReason({}), "git failed");
});

test("the checkout lives under the user's shadok-ai state dir", () => {
  assert.equal(selfRepoDir().startsWith(os.homedir()), true);
  assert.match(selfRepoDir(), /\.shadok-ai[/\\]self[/\\]shadok-ai$/);
});

test("the remote is the canonical repository", () => {
  assert.equal(SELF_REPO_URL, "https://github.com/shadok-ai/shadok-ai.git");
});
