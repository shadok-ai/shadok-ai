import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { envReads, releaseWarnings, scanFiles, skillNameError, skillPathError } from "../src/factory-scan.js";
import {
  accept,
  bundleOf,
  createSkill,
  cutRelease,
  diff,
  FactoryError,
  headCommit,
  log,
  materialise,
  pluginArgs,
  readFile,
  receivePush,
  resolveAttachments,
  saveFile,
  scanMain,
  findSkill,
  MAIN_GROUP,
} from "../src/factory.js";

const SECRET = { name: "HUBSPOT_TOKEN", value: "hs-pat-9f8e7d6c5b4a" };
const f = (p: string, s: string) => ({ path: p, content: Buffer.from(s) });

function scratch(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" },
  }).trim();
}

/** What an agent does with factory.mjs: clone the bundle, commit, bundle the new commits. */
function agentEdit(root: string, name: string, work: string, file: string, content: string): Buffer {
  const b = path.join(work, "in.bundle");
  fs.writeFileSync(b, bundleOf(root, name));
  const clone = path.join(work, "clone");
  if (!fs.existsSync(clone)) sh(work, "git", ["clone", "-q", "-b", "main", b, clone]);
  else {
    sh(clone, "git", ["fetch", "-q", b, "main:refs/remotes/origin/main"]);
    sh(clone, "git", ["reset", "-q", "--hard", "origin/main"]);
  }
  fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
  fs.writeFileSync(path.join(clone, file), content);
  sh(clone, "git", ["add", "-A"]);
  sh(clone, "git", ["commit", "-q", "-m", `edit ${file}`]);
  const out = path.join(work, "out.bundle");
  sh(clone, "git", ["bundle", "create", "-q", out, "origin/main..main"]);
  return fs.readFileSync(out);
}

// ── The pure scan ────────────────────────────────────────────────────────────

test("scan: a vault value is refused, by NAME and line, never echoing the value", () => {
  const r = scanFiles([f("scripts/run.sh", `#!/bin/sh\ncurl -H "x: ${SECRET.value}"\n`)], [SECRET]);
  assert.equal(r.refusals.length, 1);
  assert.equal(r.refusals[0].secret, "HUBSPOT_TOKEN");
  assert.equal(r.refusals[0].line, 2);
  assert.ok(!JSON.stringify(r).includes(SECRET.value));
});

test("scan: short vault values are ignored (they would match everywhere)", () => {
  const r = scanFiles([f("SKILL.md", "set PORT to 8080")], [{ name: "PORT", value: "8080" }]);
  assert.equal(r.refusals.length, 0);
});

test("scan: credential files refuse, token shapes only warn", () => {
  const r = scanFiles(
    [f(".env", "A=1"), f("keys/server.pem", "x"), f("SKILL.md", "example: ghp_abcdefghijklmnopqrstuvwxyz0123456789")],
    [],
  );
  assert.deepEqual(r.refusals.map((x) => x.path).sort(), [".env", "keys/server.pem"]);
  assert.equal(r.warnings.length, 1);
});

test("release warnings: undeclared vault env, and $CLAUDE_PLUGIN_ROOT in a script", () => {
  const w = releaseWarnings(
    [f("scripts/a.sh", 'curl "$HUBSPOT_TOKEN" && ls "$CLAUDE_PLUGIN_ROOT"'), f("SKILL.md", "$HUBSPOT_TOKEN")],
    [],
    ["HUBSPOT_TOKEN"],
  );
  assert.equal(w.length, 2);
  assert.ok(w.some((x) => x.secret === "HUBSPOT_TOKEN"));
  assert.ok(w.some((x) => /CLAUDE_PLUGIN_ROOT/.test(x.message)));
  assert.equal(releaseWarnings([f("scripts/a.sh", "echo $HUBSPOT_TOKEN")], ["HUBSPOT_TOKEN"], ["HUBSPOT_TOKEN"]).length, 0);
});

test("envReads covers node, shell and python spellings", () => {
  const got = envReads('process.env.A; process.env["B"]; ${C}; $D; os.environ["E"]; os.environ.get("F")').sort();
  assert.deepEqual(got, ["A", "B", "C", "D", "E", "F"]);
});

test("names and paths are validated", () => {
  assert.equal(skillNameError("kpi-export"), null);
  assert.ok(skillNameError("KPI"));
  assert.ok(skillNameError("shadok-files"));
  assert.equal(skillPathError("scripts/run.sh"), null);
  for (const bad of ["../x", "/etc/passwd", ".git/config", "a//b", "a/./b", ".claude-plugin/plugin.json"])
    assert.ok(skillPathError(bad), bad);
});

// ── The store, against real git ──────────────────────────────────────────────

test("create → save → release → accept → plugin dir, end to end", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "kpi-export", description: "Use for the weekly KPI export", by: "alice" });
  assert.equal(s.owner, MAIN_GROUP);
  assert.match(readFile(root, s.id, "SKILL.md")!, /name: kpi-export/);

  const base = headCommit(root, s.id);
  saveFile(root, s.id, { path: "scripts/run.sh", content: "#!/bin/sh\necho ok\n", base, by: "alice", secrets: [SECRET] });
  assert.equal(log(root, s.id)[0].by, "alice");

  const rel = cutRelease(root, s.id, { by: "alice", secrets: [SECRET] });
  assert.equal(rel.n, 1);
  assert.throws(() => cutRelease(root, s.id, { by: "alice", secrets: [] }), /already this exact content/);

  // Not accepted yet → nothing runs, and it says why.
  let r = pluginArgs(root, [{ skill: s.id, release: 1 }]);
  assert.deepEqual(r.args, []);
  assert.match(r.dropped[0].reason, /not been accepted/);

  accept(root, s.id, { group: MAIN_GROUP, release: 1, by: "bob" });
  r = pluginArgs(root, [{ skill: s.id, release: 1 }]);
  assert.equal(r.args[0], "--plugin-dir");
  const dir = r.args[1];
  const plugin = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "kpi-export");
  assert.ok(fs.existsSync(path.join(dir, "skills", "kpi-export", "SKILL.md")));
  assert.equal(execFileSync(path.join(dir, "skills", "kpi-export", "scripts", "run.sh"), { encoding: "utf8" }).trim(), "ok");
  // Content-addressed: materialising again is the same directory.
  assert.equal(materialise(root, findSkill(root, s.id)!, rel), dir);
  assert.match(diff(root, s.id, null, "v1"), /scripts\/run\.sh/);
});

test("a browser save holding a vault value is refused and leaves no commit", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "leaky", by: "alice" });
  const before = headCommit(root, s.id);
  assert.throws(
    () => saveFile(root, s.id, { path: "SKILL.md", content: `token ${SECRET.value}`, base: before, by: "alice", secrets: [SECRET] }),
    (e: unknown) => e instanceof FactoryError && e.status === 422 && e.scan!.refusals[0].secret === "HUBSPOT_TOKEN",
  );
  assert.equal(headCommit(root, s.id), before);
});

test("a stale browser save is refused (someone saved since)", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "race", by: "alice" });
  const base = headCommit(root, s.id);
  saveFile(root, s.id, { path: "a.md", content: "1", base, by: "alice", secrets: [] });
  assert.throws(() => saveFile(root, s.id, { path: "a.md", content: "2", base, by: "bob", secrets: [] }), /someone saved since/);
});

test("agent push: fast-forward lands and is stamped; a stale push is refused", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "pushy", by: "alice" });
  const w1 = scratch(t);
  const b1 = agentEdit(root, "pushy", w1, "notes.md", "from agent 1\n");
  const res = receivePush(root, s.id, b1, { by: "agent:Shadok-Skillsmith/1a2b3c4d (main)", secrets: [SECRET] });
  assert.equal(res.commits, 1);
  assert.equal(readFile(root, s.id, "notes.md"), "from agent 1\n");
  assert.match(log(root, s.id)[0].by!, /Skillsmith/);

  // A second clone made BEFORE that push builds on the old main → refused.
  const w2 = scratch(t);
  const fresh = path.join(w2, "clone");
  sh(w2, "git", ["clone", "-q", "-b", "main", path.join(w1, "in.bundle"), fresh]);
  fs.writeFileSync(path.join(fresh, "other.md"), "x");
  sh(fresh, "git", ["add", "-A"]);
  sh(fresh, "git", ["commit", "-q", "-m", "other"]);
  sh(fresh, "git", ["bundle", "create", "-q", path.join(w2, "o.bundle"), "origin/main..main"]);
  assert.throws(
    () => receivePush(root, s.id, fs.readFileSync(path.join(w2, "o.bundle")), { by: "x", secrets: [] }),
    /someone pushed since/,
  );
});

test("agent push carrying a vault value anywhere in its history is refused; main does not move", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "history-leak", by: "alice" });
  const w = scratch(t);
  const b = path.join(w, "in.bundle");
  fs.writeFileSync(b, bundleOf(root, s.id));
  const clone = path.join(w, "clone");
  sh(w, "git", ["clone", "-q", "-b", "main", b, clone]);
  // Added in one commit, removed in the next: the final tree is clean.
  fs.writeFileSync(path.join(clone, "x.sh"), `echo ${SECRET.value}\n`);
  sh(clone, "git", ["add", "-A"]);
  sh(clone, "git", ["commit", "-q", "-m", "oops"]);
  fs.writeFileSync(path.join(clone, "x.sh"), "echo $HUBSPOT_TOKEN\n");
  sh(clone, "git", ["commit", "-qam", "fix"]);
  sh(clone, "git", ["bundle", "create", "-q", path.join(w, "o.bundle"), "origin/main..main"]);
  const before = headCommit(root, s.id);
  assert.throws(
    () => receivePush(root, s.id, fs.readFileSync(path.join(w, "o.bundle")), { by: "x", secrets: [SECRET] }),
    (e: unknown) => e instanceof FactoryError && e.status === 422,
  );
  assert.equal(headCommit(root, s.id), before);
});

test("scanMain reports a missing SKILL.md as a refusal and a renamed frontmatter as a warning", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "renamed", by: "a" });
  saveFile(root, s.id, { path: "SKILL.md", content: "---\nname: other\n---\nhi", base: null, by: "a", secrets: [] });
  assert.ok(scanMain(root, s.id, []).warnings.some((w) => /differs/.test(w.message)));
  saveFile(root, s.id, { path: "SKILL.md", content: null, base: null, by: "a", secrets: [] });
  assert.ok(scanMain(root, s.id, []).refusals.some((r) => r.path === "SKILL.md"));
  assert.throws(() => cutRelease(root, s.id, { by: "a", secrets: [] }), /refused by the scan/);
});

test("resolveAttachments: every reason to drop is explicit", () => {
  const skill = {
    id: "id1",
    name: "k",
    description: "",
    owner: "sales",
    editors: ["sales"],
    users: ["marketing"],
    createdBy: "a",
    createdAt: 0,
    releases: [{ n: 1, tree: "t1", commit: "c1", by: "a", at: 0, secrets: [], warnings: [] }],
    acceptances: [{ group: "marketing", release: 1, tree: "t1", by: "m", at: 0 }],
  };
  assert.equal(resolveAttachments([skill], [{ skill: "k", release: 1 }], "marketing").ok.length, 1);
  assert.match(resolveAttachments([skill], [{ skill: "k", release: 1 }], "hr").dropped[0].reason, /not shared/);
  assert.match(resolveAttachments([skill], [{ skill: "k", release: 1 }], "sales").dropped[0].reason, /not been accepted/);
  assert.match(resolveAttachments([skill], [{ skill: "k", release: 2 }], "marketing").dropped[0].reason, /does not exist/);
  assert.match(resolveAttachments([skill], [{ skill: "zz", release: 1 }], "marketing").dropped[0].reason, /no longer exists/);
  // An acceptance pins a TREE: a release whose tree changed under it no longer runs.
  const moved = { ...skill, releases: [{ ...skill.releases[0], tree: "t2" }] };
  assert.equal(resolveAttachments([moved], [{ skill: "k", release: 1 }], "marketing").ok.length, 0);
});
