import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The refusals ARE the feature of scripts/pr-merge.sh: it exists so the one
// line a human types is stricter than the raw `gh pr merge` it wraps. So they
// are driven here against a FAKE `gh`, the way test/tweak-pr-check.test.ts
// drives the cron guard — none of this can be exercised against the real API
// without an open PR in exactly the wrong state.
const SCRIPT = join(import.meta.dirname, "..", ".claude", "skills", "pr-merge", "scripts", "pr-merge.sh");

const CLEAN = {
  number: 1,
  title: "A clean PR",
  author: { login: "shadok-ai-dev" },
  isDraft: false,
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  headRefOid: "abc1234def5678",
  labels: [],
  isCrossRepository: false,
  files: [{ path: "src/server.ts" }],
  state: "OPEN",
};

/** A sandbox with a fake `gh` first on PATH and a git repo to resolve. */
function sandbox(pr: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "prmerge-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: repo,
  });
  writeFileSync(join(dir, "pr.json"), JSON.stringify(pr));
  // `pr view` answers the fixture; `pr merge` only records that it was called,
  // which is what lets a test assert a refusal really refused.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "pr view") cat "${join(dir, "pr.json")}" ;;
  "pr merge") printf '%s\\n' "$*" >> "${join(dir, "merged.log")}" ;;
  "run list") printf '' ;;
  *) printf '' ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { dir, bin, repo, merged: () => existsSync(join(dir, "merged.log")) && readFileSync(join(dir, "merged.log"), "utf8") };
}

function run(pr: Record<string, unknown>, args: string[] = ["1"]) {
  const s = sandbox(pr);
  let out = "";
  let code = 0;
  try {
    out = execFileSync("sh", [SCRIPT, ...args], {
      cwd: s.repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${s.bin}:${process.env.PATH}`,
        PR_MERGE_REPO: s.repo,
        PR_MERGE_WAIT_TRIES: "0",
        PR_MERGE_WAIT_SLEEP: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    code = err.status ?? 1;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  return { out, code, merged: s.merged() };
}

test("merges a clean whitelisted PR, with the PR's own title as the subject", () => {
  const r = run(CLEAN);
  assert.equal(r.code, 0, r.out);
  assert.match(String(r.merged), /--squash/);
  // The subject is read off the PR, so a hand-typed typo cannot land.
  assert.match(String(r.merged), /A clean PR \(#1\)/);
});

test("refuses a PR that grew past the pinned head", () => {
  const r = run(CLEAN, ["1", "--head", "0000000"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /has grown/);
  assert.equal(r.merged, false);
});

test("accepts a pinned head given as a short prefix", () => {
  const r = run(CLEAN, ["1", "--head", "abc1234"]);
  assert.equal(r.code, 0, r.out);
  assert.match(String(r.merged), /--squash/);
});

test("refuses anything under .github/, even when the rest is clean", () => {
  const r = run({ ...CLEAN, files: [{ path: ".github/workflows/publish.yml" }] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /\.github\//);
  assert.equal(r.merged, false);
});

test("refuses a fork unless --fork-ok is passed, and merges it when it is", () => {
  const fork = { ...CLEAN, isCrossRepository: true, author: { login: "SomeContributor" } };
  const refused = run(fork);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /fork/);
  assert.equal(refused.merged, false);

  const allowed = run(fork, ["1", "--fork-ok"]);
  assert.equal(allowed.code, 0, allowed.out);
  assert.match(String(allowed.merged), /--squash/);
});

test("refuses an author outside the whitelist on a same-repo PR", () => {
  const r = run({ ...CLEAN, author: { login: "a-stranger" } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /whitelist/);
  assert.equal(r.merged, false);
});

test("refuses a draft, a non-main base, a hold label and a non-CLEAN state", () => {
  for (const [patch, pattern] of [
    [{ isDraft: true }, /draft/],
    [{ baseRefName: "some-branch" }, /not main/],
    [{ labels: [{ name: "hold" }] }, /hold/],
    [{ mergeStateStatus: "BEHIND" }, /not CLEAN/],
    [{ mergeStateStatus: "DIRTY" }, /not CLEAN/],
    [{ mergeStateStatus: "UNSTABLE" }, /not CLEAN/],
    [{ state: "MERGED" }, /not OPEN/],
  ] as [Record<string, unknown>, RegExp][]) {
    const r = run({ ...CLEAN, ...patch });
    assert.notEqual(r.code, 0, `${JSON.stringify(patch)} should refuse`);
    assert.match(r.out, pattern);
    assert.equal(r.merged, false, `${JSON.stringify(patch)} must not merge`);
  }
});
