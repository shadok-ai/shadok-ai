/**
 * The Skill Factory's store: one bare git repository per skill, held by the
 * SERVER, plus a small registry (releases, acceptances). Design:
 * docs/superpowers/specs/2026-10-29-skill-factory-design.md.
 *
 * The server is the git `origin`. Contributors never touch these paths: a
 * person saves through the browser (one commit per save), an agent pulls a
 * bundle into a clone of its own and pushes one back (fast-forward only).
 * Under the multi-tenant design a directory writable by several groups would be
 * a hole in the wall; a remote is not.
 *
 * Phase 2 is single-tenant: every skill is owned by the one group `main`, and
 * the owner / editors / users lists are stored but not yet offered in the UI.
 * They are what phase 3 fills in.
 *
 * Every git call goes through `git()` with an explicit `--git-dir`, never a cwd:
 * these repositories are bare and must never be confused with whatever checkout
 * the server was launched from.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceKey } from "./paths.js";
import {
  detectSecrets,
  frontmatterName,
  parseManifest,
  releaseWarnings,
  scanFiles,
  skillNameError,
  skillPathError,
  type ScanFile,
  type ScanFinding,
  type ScanResult,
  type ScanSecret,
} from "./factory-scan.js";

/** The one group of a single-tenant instance (the multi-tenant spec's `Main`). */
export const MAIN_GROUP = "main";

/**
 * WHO a skill is for, chosen at creation — its `owner`:
 * - `user:<account>`: only that person sees and edits it, and it runs only on
 *   agents that person created;
 * - `group:<id>`: it runs only on agents of that cockpit group;
 * - `main`: the whole organisation.
 * Until the multi-tenant work gives groups members, a group skill is VISIBLE to
 * every person (groups are not private yet); what the scope enforces is where
 * it RUNS. The acceptance gate stays the instance's (`MAIN_GROUP`).
 */
export type Scope = string;
export const DEFAULT_CREATOR = "admin"; // accounts.ts BOOTSTRAP_ADMIN: an agent nobody signed for

/** Who an agent is, for scope checks: its cockpit group and the person who created it. */
export interface AgentCtx {
  group?: number | null;
  createdBy?: string | null;
}

export function scopeError(scope: unknown, groupIds: number[]): string | null {
  if (scope === MAIN_GROUP) return null;
  if (typeof scope !== "string") return "scope required";
  if (/^user:[^\s:]{1,80}$/.test(scope)) return null;
  const ids = scopeGroups(scope);
  if (ids) {
    if (!ids.length) return "pick at least one group";
    return ids.every((i) => groupIds.includes(i)) ? null : "one of those groups does not exist";
  }
  return "share it with you, some groups, or everyone";
}

/** The group ids of a `groups:1,3` (or legacy `group:1`) scope, else null. Pure. */
export function scopeGroups(owner: string | undefined): number[] | null {
  const m = /^groups?:([\d,]*)$/.exec(owner ?? "");
  if (!m) return null;
  return [...new Set(m[1].split(",").filter(Boolean).map(Number))].sort((a, b) => a - b);
}

/** Build the stored scope from what the form sends. Pure. */
export function groupsScope(ids: number[]): string {
  return `groups:${[...new Set(ids)].sort((a, b) => a - b).join(",")}`;
}

/** Pure: may this skill run on this agent? (Its scope, not the acceptance.) */
export function scopeAllowsAgent(owner: Scope, agent: AgentCtx): boolean {
  if (!owner || owner === MAIN_GROUP) return true;
  const ids = scopeGroups(owner);
  if (ids) return agent.group != null && ids.includes(Number(agent.group));
  const u = /^user:(.+)$/.exec(owner);
  if (u) return (agent.createdBy || DEFAULT_CREATOR) === u[1];
  return false;
}

/** Pure: may this person see (and therefore edit) this skill? */
export function scopeVisibleTo(owner: Scope, person: string | null): boolean {
  const u = /^user:(.+)$/.exec(owner ?? "");
  return u ? (person || DEFAULT_CREATOR) === u[1] : true;
}

/** A human title → the skill's technical name (also its plugin name). Pure. */
export function slugify(title: string): string {
  return String(title ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^shadok-/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export interface Release {
  n: number;
  /** Tree hash of the tagged commit — what an acceptance pins. */
  tree: string;
  commit: string;
  by: string;
  at: number;
  note?: string;
  /** requires.secrets as the manifest declared them at this release — the names
   *  an attached agent RECEIVES once a person of its group accepted this tree. */
  secrets: string[];
  /** The subset of `secrets` found in the code but NOT declared in the
   *  manifest — granted all the same, and shown as such at acceptance. */
  detectedSecrets?: string[];
  /** requires.mcp at this release (informative: checked against the agent's profile). */
  mcp?: string[];
  warnings: ScanFinding[];
}

export interface Acceptance {
  group: string;
  release: number;
  tree: string;
  by: string;
  at: number;
}

export interface FactorySkill {
  id: string;
  name: string;
  /** The human name it was created with ("Daily marketing summary"). */
  title?: string;
  /** Free tags, for filtering ("reporting", "slack"). */
  tags?: string[];
  /** Archived: hidden by default, never given to a new agent; existing attachments keep running. */
  archived?: boolean;
  description: string;
  owner: string;
  editors: string[];
  users: string[];
  createdBy: string;
  createdAt: number;
  releases: Release[];
  acceptances: Acceptance[];
  /** "This went wrong / this is missing", from the agents and people who USE it. */
  feedback?: Feedback[];
  /** `<skill>@<N>` this one was duplicated from, if any. */
  origin?: string;
}

export interface Feedback {
  id: string;
  by: string;
  at: number;
  /** The release the reporter was running, when known. */
  release?: number;
  text: string;
  done?: { by: string; at: number };
}

interface Registry {
  skills: FactorySkill[];
}

export class FactoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly scan?: ScanResult,
  ) {
    super(message);
  }
}

/** Where everything lives. Overridable so tests run in a scratch dir. */
export function factoryRoot(cwd = process.cwd(), home = os.homedir()): string {
  return process.env.SHADOK_FACTORY_DIR || path.join(home, ".shadok-ai", "factory", instanceKey(cwd));
}

const regPath = (root: string) => path.join(root, "registry.json");
const repoPath = (root: string, id: string) => path.join(root, "repos", `${id}.git`);
export const pluginsDir = (root: string) => path.join(root, "plugins");

function git(gitDir: string, args: string[], opts: { input?: Buffer | string; env?: Record<string, string> } = {}): Buffer {
  return execFileSync("git", ["--git-dir", gitDir, ...args], {
    input: opts.input,
    env: {
      ...process.env,
      // Deterministic, and independent of whoever runs the server.
      GIT_AUTHOR_NAME: "shadok",
      GIT_AUTHOR_EMAIL: "factory@shadok.local",
      GIT_COMMITTER_NAME: "shadok",
      GIT_COMMITTER_EMAIL: "factory@shadok.local",
      GIT_TERMINAL_PROMPT: "0",
      ...opts.env,
    },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
const gitText = (d: string, a: string[], o?: Parameters<typeof git>[2]) => git(d, a, o).toString("utf8").trim();

export function loadRegistry(root: string): Registry {
  try {
    const r = JSON.parse(fs.readFileSync(regPath(root), "utf8"));
    return { skills: Array.isArray(r?.skills) ? r.skills : [] };
  } catch {
    return { skills: [] };
  }
}

function saveRegistry(root: string, reg: Registry): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = `${regPath(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, regPath(root));
}

function mutate<T>(root: string, fn: (reg: Registry) => T): T {
  const reg = loadRegistry(root);
  const out = fn(reg);
  saveRegistry(root, reg);
  return out;
}

export function findSkill(root: string, idOrName: string): FactorySkill | undefined {
  return loadRegistry(root).skills.find((s) => s.id === idOrName || s.name === idOrName);
}

function mustSkill(root: string, idOrName: string): FactorySkill {
  const s = findSkill(root, idOrName);
  if (!s) throw new FactoryError(`no factory skill ${idOrName}`, 404);
  return s;
}

// ── Reading a revision ──────────────────────────────────────────────────────

export function headCommit(root: string, id: string): string | null {
  try {
    return gitText(repoPath(root, id), ["rev-parse", "--verify", "-q", "refs/heads/main"]) || null;
  } catch {
    return null;
  }
}

/** Every file of a revision, with its content. */
export function readFiles(root: string, id: string, rev = "refs/heads/main"): ScanFile[] {
  const d = repoPath(root, id);
  const list = gitText(d, ["ls-tree", "-r", "-z", "--name-only", rev]).split("\0").filter(Boolean);
  return list.map((p) => ({ path: p, content: git(d, ["cat-file", "blob", `${rev}:${p}`]) }));
}

export function listTree(root: string, id: string, rev = "refs/heads/main"): { path: string; size: number }[] {
  const d = repoPath(root, id);
  const out = gitText(d, ["ls-tree", "-r", "-l", "-z", rev]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split("\t");
      const size = Number(meta.trim().split(/\s+/)[3]) || 0;
      return { path: p, size };
    });
}

export function readFile(root: string, id: string, p: string, rev = "refs/heads/main"): string | null {
  if (skillPathError(p)) return null;
  try {
    return git(repoPath(root, id), ["cat-file", "blob", `${rev}:${p}`]).toString("utf8");
  } catch {
    return null;
  }
}

export interface LogEntry {
  commit: string;
  at: number;
  subject: string;
  /** Who PUSHED it, as stamped by the server (a git note) — not the commit's own author field. */
  by: string | null;
}

export function log(root: string, id: string, max = 100): LogEntry[] {
  const d = repoPath(root, id);
  if (!headCommit(root, id)) return [];
  const raw = gitText(d, ["log", `-n${max}`, "--format=%H%x1f%ct%x1f%s%x1f%N%x1e", "--notes=shadok", "refs/heads/main"]);
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [commit, ct, subject, note] = r.split("\x1f");
      return { commit, at: Number(ct) * 1000, subject, by: note?.trim() || null };
    });
}

/** Unified diff between two revisions (release tags `v<N>`, commits, or `main`). */
export function diff(root: string, id: string, from: string | null, to = "refs/heads/main"): string {
  const d = repoPath(root, id);
  const resolve = (r: string) => (/^v\d+$/.test(r) ? `refs/tags/${r}` : r === "main" ? "refs/heads/main" : r);
  if (!/^(v\d+|main|refs\/heads\/main|[0-9a-f]{7,40})$/.test(to)) throw new FactoryError("bad revision");
  if (from && !/^(v\d+|main|[0-9a-f]{7,40})$/.test(from)) throw new FactoryError("bad revision");
  // With no base, show the whole tree as added (diff against git's empty tree).
  const base = from ? resolve(from) : gitText(d, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
  return git(d, ["diff", "--no-color", base, resolve(to)]).toString("utf8");
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** Stamp who pushed/saved a commit. A note, so it never changes the commit id. */
function stamp(d: string, commit: string, by: string): void {
  try {
    git(d, ["notes", "--ref=shadok", "add", "-f", "-m", by, commit]);
  } catch {
    /* a missing stamp is a weaker history, never a failed save */
  }
}

/**
 * Commit a set of file changes on top of `main` with a private index, then move
 * `main` with a compare-and-swap. `base` is the commit the caller edited from:
 * if `main` moved since, the save is refused ("someone saved since") rather
 * than silently overwriting a co-author.
 */
function commitChanges(
  d: string,
  changes: { path: string; content: Buffer | null }[],
  message: string,
  base: string | null,
): string {
  const idx = path.join(os.tmpdir(), `shadok-factory-index-${process.pid}-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    let parent: string | null = null;
    try {
      parent = gitText(d, ["rev-parse", "--verify", "-q", "refs/heads/main"]) || null;
    } catch {
      parent = null;
    }
    if (base !== undefined && base !== null && parent !== base)
      throw new FactoryError("someone saved since you opened this file — reload it and redo your change", 409);
    if (parent) git(d, ["read-tree", parent], { env });
    else git(d, ["read-tree", "--empty"], { env });
    for (const c of changes) {
      if (c.content === null) {
        // Mode 0 through --index-info removes the entry: the work-tree-free way
        // (`--force-remove` refuses to run in a bare repository).
        git(d, ["update-index", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${c.path}\n` });
      } else {
        const blob = gitText(d, ["hash-object", "-w", "--stdin"], { input: c.content });
        git(d, ["update-index", "--add", "--cacheinfo", `100644,${blob},${c.path}`], { env });
      }
    }
    const tree = gitText(d, ["write-tree"], { env });
    const commit = gitText(d, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
    git(d, ["update-ref", "refs/heads/main", commit, ...(parent ? [parent] : ["0".repeat(40)])]);
    return commit;
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

function skillTemplate(name: string, description: string): { path: string; content: Buffer }[] {
  const md = `---
name: ${name}
description: ${description || "Describe WHEN an agent should use this skill — that sentence is what triggers it."}
---

# ${name}

Explain the steps here. Secrets are read from the environment by NAME
(declare each one in shadok-skill.json → requires.secrets); never paste a value.

To run a bundled script, use the path this file is loaded from:
\`bash \${CLAUDE_PLUGIN_ROOT}/skills/${name}/scripts/<script>.sh\`
(\$CLAUDE_PLUGIN_ROOT is substituted HERE, not exported to scripts — a script
finds its own files from \`$(dirname "$0")\`.)
`;
  const manifest = { name, description, requires: { secrets: [] as string[] } };
  return [
    { path: "SKILL.md", content: Buffer.from(md) },
    { path: "shadok-skill.json", content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
  ];
}

export function createSkill(
  root: string,
  input: { name: string; title?: string; description?: string; by: string; owner?: Scope },
): FactorySkill {
  const err = skillNameError(input.name);
  if (err) throw new FactoryError(err);
  if (findSkill(root, input.name)) throw new FactoryError(`a factory skill named ${input.name} already exists`, 409);
  const id = randomUUID();
  const d = repoPath(root, id);
  fs.mkdirSync(path.dirname(d), { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", d], { stdio: "pipe" });
  const description = (input.description ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  const commit = commitChanges(d, skillTemplate(input.name, description), `Create ${input.name}`, null);
  stamp(d, commit, input.by);
  const skill: FactorySkill = {
    id,
    name: input.name,
    ...(input.title?.trim() ? { title: input.title.trim().slice(0, 80) } : {}),
    description,
    owner: input.owner || MAIN_GROUP,
    editors: [MAIN_GROUP],
    users: [MAIN_GROUP],
    createdBy: input.by,
    createdAt: Date.now(),
    releases: [],
    acceptances: [],
  };
  mutate(root, (reg) => reg.skills.push(skill));
  return skill;
}

/**
 * A browser save: one file written (or deleted with `content: null`), scanned
 * BEFORE the commit exists. Refused on a vault value — a value that never
 * enters the history cannot leak through a bundle later.
 */
export function saveFile(
  root: string,
  idOrName: string,
  input: { path: string; content: string | null; base: string | null; by: string; secrets: ScanSecret[] },
): { commit: string; warnings: ScanFinding[] } {
  const skill = mustSkill(root, idOrName);
  const perr = skillPathError(input.path);
  if (perr) throw new FactoryError(perr);
  const d = repoPath(root, skill.id);
  const changed = input.content === null ? null : Buffer.from(input.content);
  const others = readFiles(root, skill.id).filter((f) => f.path !== input.path);
  const after = changed ? [...others, { path: input.path, content: changed }] : others;
  const scan = scanFiles(after, input.secrets);
  // Only refusals that concern THIS file (or the whole skill) block the save:
  // an older problem elsewhere is reported, not used to hold this edit hostage.
  const blocking = scan.refusals.filter((r) => r.path === input.path || r.path === "");
  if (blocking.length) throw new FactoryError("refused by the scan", 422, { refusals: blocking, warnings: [] });
  const verb = input.content === null ? "Delete" : "Edit";
  const commit = commitChanges(d, [{ path: input.path, content: changed }], `${verb} ${input.path}`, input.base);
  stamp(d, commit, input.by);
  return { commit, warnings: scan.warnings.filter((w) => w.path === input.path) };
}

/** The bundle an agent clones/fetches: all of `main`. */
export function bundleOf(root: string, idOrName: string): Buffer {
  const skill = mustSkill(root, idOrName);
  return git(repoPath(root, skill.id), ["bundle", "create", "-q", "-", "refs/heads/main"]);
}

/**
 * An agent's push: a git bundle whose `main` must FAST-FORWARD the server's.
 * The new blobs are scanned before `main` moves; a refusal leaves no trace in
 * the shared history (the fetched objects are unreferenced and get gc'd).
 */
export function receivePush(
  root: string,
  idOrName: string,
  bundle: Buffer,
  input: { by: string; secrets: ScanSecret[] },
): { commit: string; commits: number; warnings: ScanFinding[] } {
  const skill = mustSkill(root, idOrName);
  const d = repoPath(root, skill.id);
  const file = path.join(os.tmpdir(), `shadok-factory-push-${process.pid}-${randomUUID()}.bundle`);
  const incoming = `refs/incoming/${randomUUID()}`;
  fs.writeFileSync(file, bundle, { mode: 0o600 });
  try {
    try {
      git(d, ["bundle", "verify", "-q", file]);
    } catch (e) {
      throw new FactoryError(
        "the bundle does not apply here — `pull` first (it must build on a commit the factory already has)",
        409,
      );
    }
    const heads = gitText(d, ["bundle", "list-heads", file]);
    const ref = /refs\/heads\/main$/m.test(heads) ? "refs/heads/main" : heads.split("\n")[0]?.split(" ")[1];
    if (!ref) throw new FactoryError("the bundle carries no branch");
    git(d, ["fetch", "-q", file, `${ref}:${incoming}`]);
    const before = headCommit(root, skill.id);
    const after = gitText(d, ["rev-parse", incoming]);
    if (before === after) throw new FactoryError("nothing to push — the factory already has this commit", 409);
    if (before) {
      try {
        git(d, ["merge-base", "--is-ancestor", before, after]);
      } catch {
        throw new FactoryError("someone pushed since — `pull`, replay your change on top, and push again", 409);
      }
    }
    // Scan every blob the push introduces, in every new commit — not only the
    // final tree: a value added then removed inside the push would otherwise
    // ride along in the history.
    const range = before ? [`${before}..${after}`] : [after];
    // "<sha> <path>" for blobs and trees (a path may contain spaces), "<sha>" for commits.
    const objs = gitText(d, ["rev-list", "--objects", ...range])
      .split("\n")
      .map((l) => {
        const sp = l.indexOf(" ");
        return sp > 0 ? [l.slice(0, sp), l.slice(sp + 1)] : [l, ""];
      })
      .filter((p) => p[1]);
    const files: ScanFile[] = [];
    const seen = new Set<string>();
    for (const [sha, p] of objs) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (gitText(d, ["cat-file", "-t", sha]) !== "blob") continue;
      files.push({ path: p, content: git(d, ["cat-file", "blob", sha]) });
    }
    const pathErrors = files.map((f) => ({ f, e: skillPathError(f.path) })).filter((x) => x.e);
    const scan = scanFiles(files, input.secrets);
    for (const { f, e } of pathErrors) scan.refusals.push({ path: f.path, message: e! });
    // Whole-tree limits (count, total size) apply to the RESULT, not the sum of history.
    const finalScan = scanFiles(readFiles(root, skill.id, incoming), []);
    for (const r of finalScan.refusals) if (r.path === "") scan.refusals.push(r);
    if (scan.refusals.length) throw new FactoryError("refused by the scan", 422, scan);
    git(d, ["update-ref", "refs/heads/main", after, ...(before ? [before] : ["0".repeat(40)])]);
    const commits = gitText(d, ["rev-list", ...range]).split("\n").filter(Boolean);
    for (const c of commits) stamp(d, c, input.by);
    return { commit: after, commits: commits.length, warnings: scan.warnings };
  } finally {
    try {
      git(d, ["update-ref", "-d", incoming]);
    } catch {
      /* not created */
    }
    fs.rmSync(file, { force: true });
  }
}

/**
 * The Skillsmith's clone, in the agent's HOME (`~/.shadok-factory/<name>`):
 * cloned from a bundle the first time, fast-forwarded after. A clone holding
 * unpushed commits is left exactly as it is — they are someone's work.
 */
export function prepareWorkspace(root: string, idOrName: string, home = os.homedir()): string {
  const skill = mustSkill(root, idOrName);
  const dir = path.join(home, ".shadok-factory", skill.name);
  const file = path.join(os.tmpdir(), `shadok-factory-ws-${process.pid}-${randomUUID()}.bundle`);
  fs.writeFileSync(file, bundleOf(root, skill.id), { mode: 0o600 });
  const run = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      run(path.dirname(dir), ["clone", "-q", "-b", "main", file, dir]);
    } else {
      run(dir, ["fetch", "-q", file, "main:refs/remotes/origin/main"]);
      const ahead = run(dir, ["rev-list", "--count", "origin/main..HEAD"]);
      const dirty = run(dir, ["status", "--porcelain"]);
      if (ahead === "0" && !dirty) run(dir, ["merge", "-q", "--ff-only", "origin/main"]);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  return dir;
}

/** Dry-run of the scan + release warnings on `main` (what a release would say). */
export function scanMain(
  root: string,
  idOrName: string,
  secrets: ScanSecret[],
): ScanResult & { secrets: string[]; detected: string[]; mcp: string[] } {
  const skill = mustSkill(root, idOrName);
  const files = readFiles(root, skill.id);
  const scan = scanFiles(files, secrets);
  const { manifest, error } = parseManifest(files.find((f) => f.path === "shadok-skill.json")?.content.toString("utf8") ?? null);
  const declared = manifest.requires?.secrets ?? [];
  const mcp = manifest.requires?.mcp ?? [];
  const warnings = [...scan.warnings, ...releaseWarnings(files, declared, secrets.map((s) => s.name))];
  if (error) warnings.push({ path: "shadok-skill.json", message: error });
  const md = files.find((f) => f.path === "SKILL.md");
  if (!md) scan.refusals.push({ path: "SKILL.md", message: "a skill needs a SKILL.md at its root" });
  else {
    const fm = frontmatterName(md.content.toString("utf8"));
    if (fm && fm !== skill.name)
      warnings.push({ path: "SKILL.md", message: `frontmatter name "${fm}" differs from the factory name "${skill.name}"` });
  }
  // What the skill really uses: declared ∪ found in its code. An author who
  // forgot to declare a name does not get a skill that breaks at 7 a.m.; the
  // name is granted and shown, at acceptance, as "found in the code".
  const found = detectSecrets(files, secrets.map((s) => s.name));
  const detected = found.filter((n) => !declared.includes(n));
  return { refusals: scan.refusals, warnings, secrets: [...declared, ...detected], detected, mcp };
}

/** Freeze `main` as release v<N+1>. Refusals block; warnings are recorded. */
export function cutRelease(
  root: string,
  idOrName: string,
  input: { by: string; note?: string; secrets: ScanSecret[] },
): Release {
  const skill = mustSkill(root, idOrName);
  const head = headCommit(root, skill.id);
  if (!head) throw new FactoryError("nothing to release");
  const last = skill.releases[skill.releases.length - 1];
  if (last && last.commit === head) throw new FactoryError(`v${last.n} is already this exact content`, 409);
  const scan = scanMain(root, skill.id, input.secrets);
  if (scan.refusals.length) throw new FactoryError("refused by the scan", 422, scan);
  const d = repoPath(root, skill.id);
  const n = (last?.n ?? 0) + 1;
  git(d, ["tag", `v${n}`, head]);
  const rel: Release = {
    n,
    tree: gitText(d, ["rev-parse", `${head}^{tree}`]),
    commit: head,
    by: input.by,
    at: Date.now(),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 300) } : {}),
    secrets: scan.secrets,
    ...(scan.detected.length ? { detectedSecrets: scan.detected } : {}),
    mcp: scan.mcp,
    warnings: scan.warnings,
  };
  mutate(root, (reg) => {
    const s = reg.skills.find((x) => x.id === skill.id)!;
    s.releases.push(rel);
    // Keep the card's description in step with the manifest's.
    const desc = parseManifest(readFile(root, skill.id, "shadok-skill.json")).manifest.description;
    if (typeof desc === "string" && desc.trim()) s.description = desc.trim().slice(0, 300);
  });
  return rel;
}

/**
 * A person of `group` accepts release N — its exact tree. Code written by
 * someone else runs in a group only once a person of that group said yes to it.
 */
export function accept(root: string, idOrName: string, input: { group: string; release: number; by: string }): Acceptance {
  const skill = mustSkill(root, idOrName);
  const rel = skill.releases.find((r) => r.n === input.release);
  if (!rel) throw new FactoryError(`no release v${input.release}`, 404);
  if (!skill.users.includes(input.group) && !skill.editors.includes(input.group))
    throw new FactoryError(`${skill.name} is not shared with ${input.group}`, 403);
  const a: Acceptance = { group: input.group, release: rel.n, tree: rel.tree, by: input.by, at: Date.now() };
  mutate(root, (reg) => {
    const s = reg.skills.find((x) => x.id === skill.id)!;
    s.acceptances = s.acceptances.filter((x) => !(x.group === a.group && x.release === a.release));
    s.acceptances.push(a);
  });
  return a;
}

export function deleteSkill(root: string, idOrName: string): void {
  const skill = mustSkill(root, idOrName);
  mutate(root, (reg) => {
    reg.skills = reg.skills.filter((s) => s.id !== skill.id);
  });
  fs.rmSync(repoPath(root, skill.id), { recursive: true, force: true });
}

// ── Running: attachments → plugin directories ────────────────────────────────

export interface Attachment {
  skill: string;
  release: number;
}

export interface ResolvedAttachment {
  skill: FactorySkill;
  release: Release;
  dir: string;
}

/** Pure: which attachments may run in `group`, and why the others may not. */
export function resolveAttachments(
  skills: FactorySkill[],
  attachments: Attachment[],
  group: string,
  /** When given, the skill's scope must allow this agent too. */
  agent?: AgentCtx,
): { ok: { skill: FactorySkill; release: Release }[]; dropped: { skill: string; release: number; reason: string }[] } {
  const ok: { skill: FactorySkill; release: Release }[] = [];
  const dropped: { skill: string; release: number; reason: string }[] = [];
  const seen = new Set<string>();
  for (const a of attachments) {
    const skill = skills.find((s) => s.id === a.skill || s.name === a.skill);
    if (!skill) {
      dropped.push({ ...a, reason: "the skill no longer exists" });
      continue;
    }
    if (seen.has(skill.id)) continue;
    const rel = skill.releases.find((r) => r.n === a.release);
    if (!rel) {
      dropped.push({ ...a, reason: `v${a.release} does not exist` });
      continue;
    }
    if (!skill.users.includes(group) && !skill.editors.includes(group)) {
      dropped.push({ ...a, reason: `not shared with ${group}` });
      continue;
    }
    if (!skill.acceptances.some((x) => x.group === group && x.release === rel.n && x.tree === rel.tree)) {
      dropped.push({ ...a, reason: `v${rel.n} has not been accepted for ${group}` });
      continue;
    }
    if (agent && !scopeAllowsAgent(skill.owner, agent)) {
      dropped.push({ ...a, reason: `scoped to ${skill.owner}, which this agent is not part of` });
      continue;
    }
    seen.add(skill.id);
    ok.push({ skill, release: rel });
  }
  return { ok, dropped };
}

/**
 * Materialise a release as a Claude Code plugin directory, once, content
 * addressed: `<name>@<N>-<tree8>/.claude-plugin/plugin.json` + `skills/<name>/…`.
 * Read-only on disk: what an agent runs must not be editable in place.
 * Measured 2026-10-31: `claude --plugin-dir <this>` lists `<name>:<name>`.
 */
export const pluginDirName = (name: string, rel: { n: number; tree: string }) => `${name}@${rel.n}-${rel.tree.slice(0, 8)}`;

export function materialise(root: string, skill: FactorySkill, rel: Release): string {
  const dir = path.join(pluginsDir(root), pluginDirName(skill.name, rel));
  if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) return dir;
  const tmp = `${dir}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const skillDir = path.join(tmp, "skills", skill.name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  const tar = git(repoPath(root, skill.id), ["archive", "--format=tar", `refs/tags/v${rel.n}`]);
  execFileSync("tar", ["-x", "-f", "-", "-C", skillDir], { input: tar });
  fs.writeFileSync(
    path.join(tmp, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: skill.name, version: `${rel.n}.0.0`, description: skill.description }, null, 2),
  );
  // Scripts keep running: git archive preserves only 644/755, and we wrote 644 —
  // make every file under scripts/ executable, everything read-only.
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else fs.chmodSync(f, /\.(sh|mjs|js|py|rb)$/.test(e.name) ? 0o555 : 0o444);
    }
  };
  walk(tmp);
  try {
    fs.renameSync(tmp, dir);
  } catch {
    // Another spawn materialised it first: theirs is identical (same tree).
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}

/** The `--plugin-dir` arguments for an agent's attachments, plus what was dropped. */
export function pluginArgs(
  root: string,
  attachments: Attachment[] | undefined,
  group = MAIN_GROUP,
  agent?: AgentCtx,
): {
  args: string[];
  running: { name: string; release: number; tree: string }[];
  /** Union of the running releases' requires.secrets: what the agent receives. */
  secrets: string[];
  dropped: { skill: string; release: number; reason: string }[];
} {
  if (!attachments?.length) return { args: [], running: [], secrets: [], dropped: [] };
  const { ok, dropped } = resolveAttachments(loadRegistry(root).skills, attachments, group, agent);
  const args: string[] = [];
  const running: { name: string; release: number; tree: string }[] = [];
  const secrets = new Set<string>();
  for (const { skill, release } of ok) {
    try {
      args.push("--plugin-dir", materialise(root, skill, release));
      running.push({ name: skill.name, release: release.n, tree: release.tree });
      for (const n of release.secrets ?? []) secrets.add(n);
    } catch (e) {
      dropped.push({ skill: skill.name, release: release.n, reason: `could not materialise: ${(e as Error).message}` });
    }
  }
  return { args, running, secrets: [...secrets], dropped };
}

/** Pure: the secret names an agent's attachments grant it (accepted releases only). */
export function grantedSecrets(skills: FactorySkill[], attachments: Attachment[] | undefined, group = MAIN_GROUP, agent?: AgentCtx): string[] {
  if (!attachments?.length) return [];
  const out = new Set<string>();
  for (const { release } of resolveAttachments(skills, attachments, group, agent).ok) for (const n of release.secrets ?? []) out.add(n);
  return [...out];
}

// ── Feedback: from the agents and people who USE a skill ────────────────────

export const MAX_FEEDBACK = 50;

export function addFeedback(root: string, idOrName: string, input: { by: string; text: string; release?: number }): Feedback {
  const skill = mustSkill(root, idOrName);
  const text = String(input.text ?? "").trim().slice(0, 2000);
  if (!text) throw new FactoryError("feedback text required");
  const f: Feedback = {
    id: randomUUID().slice(0, 8),
    by: input.by,
    at: Date.now(),
    ...(Number.isInteger(input.release) ? { release: input.release } : {}),
    text,
  };
  mutate(root, (reg) => {
    const s = reg.skills.find((x) => x.id === skill.id)!;
    // Bounded: the open items first, then the newest closed ones.
    const all = [...(s.feedback ?? []), f];
    const open = all.filter((x) => !x.done).slice(-MAX_FEEDBACK);
    // `slice(-0)` is the WHOLE array: room for zero closed items must keep zero.
    const room = MAX_FEEDBACK - open.length;
    const closed = room > 0 ? all.filter((x) => x.done).slice(-room) : [];
    s.feedback = [...open, ...closed].sort((a, b) => a.at - b.at);
  });
  return f;
}

export function closeFeedback(root: string, idOrName: string, input: { id: string; by: string }): void {
  const skill = mustSkill(root, idOrName);
  mutate(root, (reg) => {
    const f = reg.skills.find((x) => x.id === skill.id)!.feedback?.find((x) => x.id === input.id);
    if (!f) throw new FactoryError("no such feedback", 404);
    f.done = { by: input.by, at: Date.now() };
  });
}

// ── Duplicate, adopt ─────────────────────────────────────────────────────────

/** Rename a skill inside its own files: the frontmatter `name:` and the manifest's. */
function renameChanges(files: ScanFile[], from: string, to: string, description?: string): { path: string; content: Buffer }[] {
  const out: { path: string; content: Buffer }[] = [];
  const md = files.find((f) => f.path === "SKILL.md");
  if (md) {
    let t = md.content.toString("utf8");
    t = t.replace(/^(---\n[\s\S]*?^name:\s*)(.+)$/m, (_m, a) => a + to);
    t = t.split(`/skills/${from}/`).join(`/skills/${to}/`);
    if (description) t = t.replace(/^(---\n[\s\S]*?^description:\s*)(.+)$/m, (_m, a) => a + description);
    out.push({ path: "SKILL.md", content: Buffer.from(t) });
  }
  const man = files.find((f) => f.path === "shadok-skill.json");
  const { manifest } = parseManifest(man?.content.toString("utf8") ?? null);
  out.push({
    path: "shadok-skill.json",
    content: Buffer.from(
      JSON.stringify({ ...manifest, name: to, ...(description ? { description } : {}), requires: { secrets: manifest.requires?.secrets ?? [], ...(manifest.requires?.mcp?.length ? { mcp: manifest.requires.mcp } : {}) } }, null, 2) + "\n",
    ),
  });
  return out;
}

/**
 * A new skill starting from release N of another one. Its history begins with
 * that release's commits (blame and diffs still make sense), then one commit
 * renaming it. The two evolve apart from here; `origin` remembers where it came from.
 */
export function duplicateSkill(
  root: string,
  idOrName: string,
  input: { name: string; release: number; description?: string; by: string; owner?: Scope },
): FactorySkill {
  const src = mustSkill(root, idOrName);
  const rel = src.releases.find((r) => r.n === input.release);
  if (!rel) throw new FactoryError(`no release v${input.release}`, 404);
  const err = skillNameError(input.name);
  if (err) throw new FactoryError(err);
  if (findSkill(root, input.name)) throw new FactoryError(`a factory skill named ${input.name} already exists`, 409);
  const id = randomUUID();
  const d = repoPath(root, id);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", d], { stdio: "pipe" });
  git(d, ["fetch", "-q", repoPath(root, src.id), `refs/tags/v${rel.n}:refs/heads/main`]);
  const description = (input.description ?? "").trim().replace(/\s+/g, " ").slice(0, 300) || src.description;
  const commit = commitChanges(d, renameChanges(readFiles(root, id), src.name, input.name, description), `Duplicate ${src.name}@${rel.n} as ${input.name}`, null);
  stamp(d, commit, input.by);
  const skill: FactorySkill = {
    id,
    name: input.name,
    description,
    owner: input.owner || src.owner || MAIN_GROUP,
    editors: [MAIN_GROUP],
    users: [MAIN_GROUP],
    createdBy: input.by,
    createdAt: Date.now(),
    releases: [],
    acceptances: [],
    origin: `${src.name}@${rel.n}`,
  };
  mutate(root, (reg) => reg.skills.push(skill));
  return skill;
}

/** Skills in a Claude Code skills directory that could be adopted (never shadok's own). */
export function adoptable(skillsDir: string, root: string): { dir: string; name: string; description: string; taken: boolean }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { dir: string; name: string; description: string; taken: boolean }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("shadok-") || e.name.startsWith(".")) continue;
    const md = path.join(skillsDir, e.name, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    const text = fs.readFileSync(md, "utf8");
    const desc = /^description:\s*(.+)$/m.exec(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "")?.[1]?.trim() ?? "";
    out.push({ dir: e.name, name: e.name, description: desc.replace(/^["']|["']$/g, "").slice(0, 300), taken: !!findSkill(root, e.name) });
  }
  return out;
}

/**
 * Import a skill folder as a new draft. Scanned like a push (a vault value in
 * it is refused before anything is written); the original folder is only read.
 */
export function adoptSkill(
  root: string,
  input: { skillsDir: string; dir: string; name?: string; by: string; secrets: ScanSecret[]; owner?: Scope },
): FactorySkill {
  const name = input.name || input.dir;
  const err = skillNameError(name);
  if (err) throw new FactoryError(`${err} (rename it while adopting)`);
  if (findSkill(root, name)) throw new FactoryError(`a factory skill named ${name} already exists`, 409);
  if (input.dir.includes("/") || input.dir.startsWith(".")) throw new FactoryError("bad folder");
  const base = path.join(input.skillsDir, input.dir);
  if (!fs.existsSync(path.join(base, "SKILL.md"))) throw new FactoryError("no SKILL.md in that folder", 404);
  const files: ScanFile[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".DS_Store") continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) files.push({ path: r, content: fs.readFileSync(path.join(base, r)) });
      if (files.length > 400) throw new FactoryError("too many files to adopt");
    }
  };
  walk("");
  const scan = scanFiles(files, input.secrets);
  for (const f of files) {
    const e = skillPathError(f.path);
    if (e) scan.refusals.push({ path: f.path, message: e });
  }
  if (scan.refusals.length) throw new FactoryError("refused by the scan", 422, scan);
  const skill = createSkill(root, { name, description: "", by: input.by, owner: input.owner });
  const d = repoPath(root, skill.id);
  const hasManifest = files.some((f) => f.path === "shadok-skill.json");
  const changes = files.map((f) => ({ path: f.path, content: f.content as Buffer | null }));
  // The template's SKILL.md/manifest are replaced by the adopted ones; a
  // missing manifest keeps the template's (empty requires — the scan's
  // "undeclared env" warning then says what to declare).
  if (!hasManifest) changes.push(...renameChanges(files, name, name).filter((c) => c.path === "shadok-skill.json"));
  const commit = commitChanges(d, changes, `Adopt ${input.dir} from ~/.claude/skills`, null);
  stamp(d, commit, input.by);
  const desc = adoptable(input.skillsDir, root).find((a) => a.dir === input.dir)?.description ?? "";
  mutate(root, (reg) => {
    const s = reg.skills.find((x) => x.id === skill.id)!;
    s.description = desc;
    s.origin = `~/.claude/skills/${input.dir}`;
  });
  return { ...skill, description: desc, origin: `~/.claude/skills/${input.dir}` };
}

/**
 * Delete the plugin directories nothing uses any more. Not housekeeping: an
 * agent resumed onto v2 still has v1's ABSOLUTE script path in its history, and
 * measured on 2.1.309 it re-ran that path rather than reloading the skill — so
 * while v1's directory exists, an "updated" agent can silently keep running the
 * old code. Gone, the old path fails and the agent reloads the skill, which
 * hands it the current one. `keep` = every directory an attachment or a running
 * process still references.
 */
export function prunePlugins(root: string, keep: Set<string>): string[] {
  const dir = pluginsDir(root);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const n of names) {
    if (keep.has(n) || n.includes(".tmp-")) continue;
    const p = path.join(dir, n);
    try {
      // Materialised read-only: give write back to the tree before removing it.
      const walk = (q: string) => {
        fs.chmodSync(q, 0o700);
        if (fs.statSync(q).isDirectory()) for (const e of fs.readdirSync(q)) walk(path.join(q, e));
      };
      walk(p);
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(n);
    } catch {
      /* best effort — a directory we could not remove only costs disk */
    }
  }
  return removed;
}

/** Plugin directory names an attachment list resolves to (accepted or not — keep is conservative). */
export function attachmentDirNames(skills: FactorySkill[], attachments: Attachment[] | undefined): string[] {
  const out: string[] = [];
  for (const a of attachments ?? []) {
    const s = skills.find((x) => x.id === a.skill || x.name === a.skill);
    const rel = s?.releases.find((r) => r.n === a.release);
    if (s && rel) out.push(pluginDirName(s.name, rel));
  }
  return out;
}

// ── Administration: scope, tags, archive, title ──────────────────────────────

/** Normalise free tags: lowercase words, deduplicated, bounded. Pure. */
export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out: string[] = [];
  for (const t of list) {
    const v = String(t ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\u00c0-\u024f_-]/g, "").slice(0, 30);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 12) break;
  }
  return out;
}

export function updateMeta(
  root: string,
  idOrName: string,
  patch: { owner?: string; tags?: string[]; archived?: boolean; title?: string; description?: string },
): FactorySkill {
  const skill = mustSkill(root, idOrName);
  return mutate(root, (reg) => {
    const s = reg.skills.find((x) => x.id === skill.id)!;
    if (patch.owner !== undefined) s.owner = patch.owner;
    if (patch.tags !== undefined) s.tags = cleanTags(patch.tags);
    if (patch.archived !== undefined) s.archived = !!patch.archived || undefined;
    if (patch.title !== undefined) s.title = String(patch.title).trim().slice(0, 80) || undefined;
    if (patch.description !== undefined) s.description = String(patch.description).trim().replace(/\s+/g, " ").slice(0, 300);
    return s;
  });
}

// ── Runs: each `Skill(<name>:<name>)` call an agent makes ────────────────────

const usagePath = (root: string) => path.join(root, "usage.jsonl");
export const USAGE_KEEP_MS = 30 * 86_400_000;

/** The factory skill a `Skill` call loaded, or null (`name:name` → name; a seeded or user skill → null). */
export function skillOfCall(skillArg: string, names: string[]): string | null {
  const m = /^([a-z0-9][a-z0-9-]*):\1$/.exec(skillArg) ?? /^([a-z0-9][a-z0-9-]*):[a-z0-9-]+$/.exec(skillArg);
  const n = m ? m[1] : null;
  return n && names.includes(n) ? n : null;
}

export function recordRun(root: string, run: { skill: string; agent: string; at?: number }): void {
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(usagePath(root), JSON.stringify({ at: run.at ?? Date.now(), skill: run.skill, agent: run.agent }) + "\n", { mode: 0o600 });
  } catch {
    /* a lost count is a lost statistic, never a failed turn */
  }
}

/** Runs per skill and per (skill, agent) since `since`. Old lines are dropped on the way. */
export function runStats(root: string, since: number, now = Date.now()): { bySkill: Record<string, number>; byAgent: Record<string, Record<string, number>>; last: Record<string, number> } {
  const bySkill: Record<string, number> = {};
  const byAgent: Record<string, Record<string, number>> = {};
  const last: Record<string, number> = {};
  let raw = "";
  try {
    raw = fs.readFileSync(usagePath(root), "utf8");
  } catch {
    return { bySkill, byAgent, last };
  }
  const keep: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let r: { at: number; skill: string; agent: string };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (now - r.at > USAGE_KEEP_MS) continue;
    keep.push(line);
    last[r.skill] = Math.max(last[r.skill] ?? 0, r.at);
    if (r.at < since) continue;
    bySkill[r.skill] = (bySkill[r.skill] ?? 0) + 1;
    (byAgent[r.skill] ??= {})[r.agent] = (byAgent[r.skill][r.agent] ?? 0) + 1;
  }
  // Compact when a good share of the file has aged out (bounded by 30 days).
  if (keep.length < raw.split("\n").length - 50) {
    try {
      fs.writeFileSync(usagePath(root), keep.join("\n") + (keep.length ? "\n" : ""), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }
  return { bySkill, byAgent, last };
}

/** Pure: is `main` ahead of the latest release (so "unreleased changes")? */
export function unreleased(skill: FactorySkill, head: string | null): boolean {
  const last = skill.releases[skill.releases.length - 1];
  return !!head && (!last || last.commit !== head);
}
