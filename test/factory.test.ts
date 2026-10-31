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

// ── What the use cases needed (2026-10-31) ───────────────────────────────────

import { adoptable, adoptSkill, addFeedback, closeFeedback, duplicateSkill, grantedSecrets, loadRegistry } from "../src/factory.js";
import { detectSecrets, parseManifest } from "../src/factory-scan.js";

test("secrets a skill USES are detected from its code — vault names only, never $HOME", () => {
  const files = [f("scripts/post.sh", 'curl -H "Bearer $SLACK_BOT_TOKEN" "$HOME/x"'), f("SKILL.md", "run with ${LINEAR_KEY:-none}")];
  assert.deepEqual(detectSecrets(files, ["SLACK_BOT_TOKEN", "LINEAR_KEY", "UNUSED"]), ["LINEAR_KEY", "SLACK_BOT_TOKEN"]);
});

test("a release grants declared ∪ detected secrets, and says which were only detected", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "daily-slack", by: "m" });
  saveFile(root, s.id, { path: "scripts/post.sh", content: "curl -d @- $SLACK_WEBHOOK\n", base: null, by: "m", secrets: [] });
  saveFile(root, s.id, { path: "shadok-skill.json", content: JSON.stringify({ name: "daily-slack", requires: { secrets: ["SLACK_BOT_TOKEN"], mcp: ["slack", "bad name!"] } }), base: null, by: "m", secrets: [] });
  const vault = [{ name: "SLACK_WEBHOOK", value: "https://hooks.example/xyz123" }, { name: "SLACK_BOT_TOKEN", value: "xoxb-not-in-the-files" }];
  const rel = cutRelease(root, s.id, { by: "m", secrets: vault });
  assert.deepEqual(rel.secrets, ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK"]);
  assert.deepEqual(rel.detectedSecrets, ["SLACK_WEBHOOK"]);
  assert.deepEqual(rel.mcp, ["slack"]); // an invalid name is dropped, never stored
  // Granted only once accepted for the group.
  const skills = () => loadRegistry(root).skills;
  assert.deepEqual(grantedSecrets(skills(), [{ skill: s.id, release: 1 }]), []);
  accept(root, s.id, { group: MAIN_GROUP, release: 1, by: "m" });
  assert.deepEqual(grantedSecrets(skills(), [{ skill: s.id, release: 1 }]).sort(), ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK"]);
  assert.deepEqual(pluginArgs(root, [{ skill: s.id, release: 1 }]).secrets.sort(), ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK"]);
});

test("manifest secret names must be env var names (they become env keys)", () => {
  const { manifest } = parseManifest(JSON.stringify({ requires: { secrets: ["OK_NAME", "rm -rf", "A=B", 3] } }));
  assert.deepEqual(manifest.requires!.secrets, ["OK_NAME"]);
});

test("feedback: added with who and which release, closed, bounded", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "fb", by: "a" });
  const f1 = addFeedback(root, s.id, { by: "agent:dev/1234", text: "misses the Instagram numbers", release: 2 });
  assert.equal(findSkill(root, s.id)!.feedback![0].release, 2);
  assert.throws(() => addFeedback(root, s.id, { by: "x", text: "   " }), /required/);
  closeFeedback(root, s.id, { id: f1.id, by: "bob" });
  assert.equal(findSkill(root, s.id)!.feedback![0].done!.by, "bob");
  for (let i = 0; i < 60; i++) addFeedback(root, s.id, { by: "x", text: "n" + i });
  assert.ok(findSkill(root, s.id)!.feedback!.length <= 50);
});

test("duplicate starts a new history from a release, renamed, with its origin", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "summary", description: "daily", by: "a" });
  saveFile(root, s.id, { path: "scripts/run.sh", content: "bash ${CLAUDE_PLUGIN_ROOT}/skills/summary/x\n", base: null, by: "a", secrets: [] });
  cutRelease(root, s.id, { by: "a", secrets: [] });
  saveFile(root, s.id, { path: "later.md", content: "after v1", base: null, by: "a", secrets: [] });
  const d = duplicateSkill(root, s.id, { name: "competitor-digest", release: 1, by: "b" });
  assert.equal(d.origin, "summary@1");
  assert.match(readFile(root, d.id, "SKILL.md")!, /^name: competitor-digest$/m);
  assert.equal(JSON.parse(readFile(root, d.id, "shadok-skill.json")!).name, "competitor-digest");
  assert.equal(readFile(root, d.id, "later.md"), null); // from v1, not from main
  assert.ok(log(root, d.id).length >= 3); // the source history is kept
  assert.equal(readFile(root, s.id, "SKILL.md")!.includes("competitor-digest"), false); // source untouched
});

test("adopt imports a ~/.claude/skills folder as a draft; never shadok's own; scanned first", (t) => {
  const root = scratch(t);
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, "ticket", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ticket", "SKILL.md"), "---\nname: ticket\ndescription: Implement a Linear ticket end to end\n---\nbody");
  fs.writeFileSync(path.join(dir, "ticket", "scripts", "go.sh"), "echo $LINEAR_KEY");
  fs.mkdirSync(path.join(dir, "shadok-files"));
  fs.writeFileSync(path.join(dir, "shadok-files", "SKILL.md"), "x");
  fs.mkdirSync(path.join(dir, "leaky"));
  fs.writeFileSync(path.join(dir, "leaky", "SKILL.md"), `token ${SECRET.value}`);
  assert.deepEqual(adoptable(dir, root).map((a) => a.name).sort(), ["leaky", "ticket"]);
  const s = adoptSkill(root, { skillsDir: dir, dir: "ticket", by: "eng", secrets: [SECRET] });
  assert.equal(s.description, "Implement a Linear ticket end to end");
  assert.equal(readFile(root, s.id, "scripts/go.sh"), "echo $LINEAR_KEY");
  assert.ok(readFile(root, s.id, "shadok-skill.json")); // a manifest is added when missing
  assert.ok(adoptable(dir, root).find((a) => a.name === "ticket")!.taken);
  assert.throws(() => adoptSkill(root, { skillsDir: dir, dir: "leaky", by: "eng", secrets: [SECRET] }), /refused by the scan/);
  assert.equal(findSkill(root, "leaky"), undefined);
  assert.ok(fs.existsSync(path.join(dir, "ticket", "SKILL.md"))); // original untouched
});

import { attachmentDirNames, prunePlugins } from "../src/factory.js";

test("prune removes release dirs nothing references — the old path an updated agent would re-run", (t) => {
  const root = scratch(t);
  const s = createSkill(root, { name: "pr", by: "a" });
  cutRelease(root, s.id, { by: "a", secrets: [] });
  saveFile(root, s.id, { path: "b.md", content: "2", base: null, by: "a", secrets: [] });
  cutRelease(root, s.id, { by: "a", secrets: [] });
  accept(root, s.id, { group: MAIN_GROUP, release: 1, by: "a" });
  accept(root, s.id, { group: MAIN_GROUP, release: 2, by: "a" });
  const d1 = pluginArgs(root, [{ skill: s.id, release: 1 }]).args[1];
  const d2 = pluginArgs(root, [{ skill: s.id, release: 2 }]).args[1];
  const keep = new Set(attachmentDirNames(loadRegistry(root).skills, [{ skill: s.id, release: 2 }]));
  assert.deepEqual(prunePlugins(root, keep), [path.basename(d1)]);
  assert.equal(fs.existsSync(d1), false); // read-only tree, removed all the same
  assert.equal(fs.existsSync(d2), true);
});
