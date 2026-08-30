import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGround, readGroundAt, type GroundEntry, type ListDir } from "../src/ground.js";

/**
 * A fixture is a directory SHAPE, not a directory: the core is pure over its
 * listing, so nothing here touches a filesystem. `dirs` maps a relative path to
 * its entries; anything absent lists empty, exactly as the real shim does.
 */
function shape(dirs: Record<string, string[]>): ListDir {
  return (rel) =>
    (dirs[rel] ?? []).map((n): GroundEntry => ({
      // A trailing slash marks a directory in the fixture literal.
      name: n.replace(/\/$/, ""),
      dir: n.endsWith("/"),
    }));
}

// --- Fixture 1: an Xcode project -------------------------------------------

const XCODE = shape({
  "": ["Shadok.xcodeproj/", "Shadok/", "ShadokTests/", "README.md", ".git/"],
});

test("an Xcode project is recognised, and named as the directory spells it", () => {
  const g = readGround(XCODE);
  assert.deepEqual(g.stacks, [{ kind: "xcode", marker: "Shadok.xcodeproj" }]);
  assert.equal(g.vcs, "git");
  assert.equal(g.unrecognised, false);
  assert.equal(g.empty, false);
  // The project's own name survives: the greeting has to say what it saw.
  assert.equal(g.stacks[0].marker, "Shadok.xcodeproj");
});

test("an .xcworkspace counts, and so does an unexpected case", () => {
  assert.deepEqual(readGround(shape({ "": ["App.xcworkspace/"] })).stacks, [
    { kind: "xcode", marker: "App.xcworkspace" },
  ]);
});

// --- Fixture 2: a Node repo -------------------------------------------------

const NODE_REPO = shape({
  "": ["package.json", "package-lock.json", "src/", "test/", "CLAUDE.md", "README.md", ".git", ".github/"],
  ".github/workflows": ["ci.yml", "publish.yml"],
});

test("a Node repo reports its stack, its CI and its convention files", () => {
  const g = readGround(NODE_REPO);
  assert.deepEqual(g.stacks, [{ kind: "node", marker: "package.json" }]);
  assert.deepEqual(g.ci, [{ kind: "github-actions", marker: ".github/workflows" }]);
  assert.deepEqual(g.conventions, ["CLAUDE.md", "README.md"]);
  assert.equal(g.vcs, "git");
  assert.equal(g.unrecognised, false);
});

test("an empty .github/workflows is not a configured CI", () => {
  // Reporting CI from the mere existence of the directory is the invented
  // answer this module exists to avoid — `.github` alone is often just an
  // issue template.
  const g = readGround(shape({ "": ["package.json", ".github/"], ".github/workflows": [] }));
  assert.deepEqual(g.ci, []);
});

test("several stacks in one directory are all reported, in table order", () => {
  // A polyglot repo is not a tie to break: reporting one and hiding the other
  // would be a claim we cannot support.
  const g = readGround(shape({ "": ["package.json", "Gemfile", "go.mod"] }));
  assert.deepEqual(
    g.stacks.map((s) => s.kind),
    ["node", "ruby", "go"],
  );
});

test("the report does not depend on readdir order", () => {
  const a = readGround(shape({ "": ["Gemfile", "package.json", "Cargo.toml"] }));
  const b = readGround(shape({ "": ["Cargo.toml", "Gemfile", "package.json"] }));
  assert.deepEqual(a, b);
});

// --- Fixture 3: a git repo with no recognisable stack -----------------------

const PROSE_REPO = shape({
  "": ["notes.md", "drafts/", "images/", "README.md", ".git"],
});

test("a git repo with no stack says so, and invents nothing", () => {
  const g = readGround(PROSE_REPO);
  assert.deepEqual(g.stacks, [], "no stack may be guessed from prose");
  assert.deepEqual(g.ci, []);
  assert.equal(g.vcs, "git");
  assert.equal(g.empty, false);
  // Recognised AS A REPO while its stack stays honestly unknown — the two
  // questions are separate, and a caller must be able to tell them apart.
  assert.equal(g.unrecognised, false);
});

test("a README alone never counts as recognition", () => {
  // Conventions are reported but excluded from the recognition test on
  // purpose: a folder of prose must still reach the honest register.
  const g = readGround(shape({ "": ["README.md", "CONTRIBUTING.md"] }));
  assert.deepEqual(g.conventions, ["CONTRIBUTING.md", "README.md"]);
  assert.equal(g.unrecognised, true);
});

// --- Fixture 4: an EMPTY folder --------------------------------------------

test("an empty folder produces an honest 'I recognise nothing'", () => {
  // The case the whole third register rests on. Every finding must be empty
  // and both honesty flags must be set — an invented answer here is the one
  // failure a greeting cannot recover from.
  const g = readGround(shape({ "": [] }));
  assert.equal(g.empty, true);
  assert.equal(g.unrecognised, true);
  assert.equal(g.vcs, null);
  assert.deepEqual(g.stacks, []);
  assert.deepEqual(g.ci, []);
  assert.deepEqual(g.conventions, []);
});

test("empty and unrecognised are different facts", () => {
  // A folder holding a stray file is not empty, and still recognises nothing.
  const g = readGround(shape({ "": ["scan-2026-08-31.pdf"] }));
  assert.equal(g.empty, false);
  assert.equal(g.unrecognised, true);
});

// --- The markers, one by one ------------------------------------------------

test("each stack marker in the table is recognised", () => {
  const cases: [string, string][] = [
    ["Gemfile", "ruby"],
    ["shadok.gemspec", "ruby"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["pom.xml", "java"],
    ["build.gradle.kts", "java"],
    ["composer.json", "php"],
    ["mix.exs", "elixir"],
    ["Package.swift", "swift"],
    ["Shadok.csproj", "dotnet"],
    ["Shadok.sln", "dotnet"],
    ["pubspec.yaml", "flutter"],
  ];
  for (const [marker, kind] of cases) {
    const g = readGround(shape({ "": [marker] }));
    assert.deepEqual(g.stacks, [{ kind, marker }], `${marker} must read as ${kind}`);
  }
});

test("each CI marker in the table is recognised", () => {
  for (const marker of [".gitlab-ci.yml", ".travis.yml", "Jenkinsfile", "azure-pipelines.yml"]) {
    const g = readGround(shape({ "": [marker] }));
    assert.equal(g.ci.length, 1, `${marker} must read as CI`);
    assert.equal(g.ci[0].marker, marker);
  }
  const circle = readGround(shape({ "": [".circleci/"], ".circleci": ["config.yml"] }));
  assert.deepEqual(circle.ci, [{ kind: "circleci", marker: ".circleci/config.yml" }]);
});

test("mercurial and subversion are version control too", () => {
  assert.equal(readGround(shape({ "": [".hg/"] })).vcs, "mercurial");
  assert.equal(readGround(shape({ "": [".svn/"] })).vcs, "subversion");
});

// --- The real-filesystem half ----------------------------------------------

test("readGroundAt reads a real directory, including a worktree's .git FILE", () => {
  // The one thing the pure core cannot prove. `.git` is a FILE in a git
  // worktree, and every shadok agent works in one — a check for a directory
  // would misreport exactly the directories this project spends its life in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ground-"));
  try {
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "on: push\n");

    const g = readGroundAt(dir);
    assert.equal(g.vcs, "git");
    assert.deepEqual(g.stacks, [{ kind: "node", marker: "package.json" }]);
    assert.deepEqual(g.ci, [{ kind: "github-actions", marker: ".github/workflows" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readGroundAt on a real empty directory is honest, and on a missing one does not throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ground-empty-"));
  try {
    const g = readGroundAt(dir);
    assert.equal(g.empty, true);
    assert.equal(g.unrecognised, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Unreadable and absent both list empty rather than throwing: this runs on
  // the path that produces a greeting, and neither deserves a crash.
  const gone = readGroundAt(path.join(os.tmpdir(), "ground-does-not-exist-8f3a1c"));
  assert.equal(gone.empty, true);
  assert.equal(gone.unrecognised, true);
});
