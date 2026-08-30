import fs from "node:fs";
import path from "node:path";

/**
 * What kind of project a directory holds, read deterministically.
 *
 * This is the cron guard's move applied to onboarding: the cheap check runs
 * first, and the model is only worth waking once there is something to say.
 * Recognising a `Gemfile` is not reasoning — it is a table lookup, and paying a
 * model call for it would be slower, costlier and less reliable than reading
 * the directory.
 *
 * Everything here is fs-only: NO model call, NO network, no process spawn (not
 * even `git`), so it cannot hang, cannot cost quota and cannot fail in a way
 * the caller has to handle. The core is pure over an injected listing, the way
 * `spawnHelperPaths` and `classifyBin` are, so the fixtures below are directory
 * SHAPES rather than directories on disk.
 *
 * The load-bearing case is the one that finds nothing. A directory shadok does
 * not recognise is a legitimate finding about the project, not a failed lookup:
 * the honest "I recognise nothing here" is what stops the layer above inventing
 * a stack, which is the one failure a greeting cannot recover from.
 */

/** One entry of a directory listing — all the core ever needs to know. */
export interface GroundEntry {
  name: string;
  /** Whether the entry is a directory. Note `.git` is a FILE in a worktree. */
  dir: boolean;
}

/**
 * Lists a path RELATIVE to the directory under inspection (`""` is its root).
 * Returns `[]` for anything missing — absence is a normal answer here, never an
 * error, so no caller has to wrap this in a try.
 */
export type ListDir = (relPath: string) => GroundEntry[];

export type Vcs = "git" | "mercurial" | "subversion";

export type StackKind =
  | "node"
  | "ruby"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "php"
  | "elixir"
  | "swift"
  | "xcode"
  | "dotnet"
  | "flutter";

export type CiKind =
  | "github-actions"
  | "gitlab-ci"
  | "circleci"
  | "travis"
  | "jenkins"
  | "azure-pipelines";

/**
 * A recognised stack, plus the file that proved it. The marker is kept because
 * the layer above has to name what it SAW ("a Gemfile", "Shadok.xcodeproj")
 * rather than a category word the user never wrote — a greeting that says
 * "ruby" where the directory says `Gemfile` is already paraphrasing.
 */
export interface StackHit {
  kind: StackKind;
  marker: string;
}

export interface CiHit {
  kind: CiKind;
  marker: string;
}

export interface Ground {
  /** Version control at the root, or null. */
  vcs: Vcs | null;
  /** Stack markers recognised, in table order — never in readdir order. */
  stacks: StackHit[];
  /** CI configuration recognised, in table order. */
  ci: CiHit[];
  /**
   * Convention files the project actually carries (CLAUDE.md, AGENTS.md,
   * CONTRIBUTING.md, a README), named as found. Deliberately NOT counted as
   * recognition below: a README is not a stack, and letting one satisfy the
   * check would make the honest register unreachable for a folder of prose.
   */
  conventions: string[];
  /** The directory holds no entries at all — or does not exist. */
  empty: boolean;
  /**
   * Nothing here was recognised: no version control, no stack marker, no CI.
   * A finding, not a failure.
   *
   * Note this is not the same question as `stacks.length === 0`: a git repo of
   * pure Markdown is recognised (it has version control) while its stack stays
   * honestly unknown. Callers picking how confidently to speak should read the
   * field that matches the claim they are about to make.
   */
  unrecognised: boolean;
}

/**
 * Stack markers, most specific first. `exact` names match verbatim, because
 * these files are spelled one way by convention (`Gemfile`, `Cargo.toml`);
 * `suffix` matches are case-insensitive and record the real filename, since
 * that half is a project's own name (`Shadok.xcodeproj`).
 */
const STACKS: { kind: StackKind; exact?: string[]; suffix?: string[] }[] = [
  { kind: "node", exact: ["package.json"] },
  { kind: "ruby", exact: ["Gemfile"], suffix: [".gemspec"] },
  { kind: "python", exact: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"] },
  { kind: "go", exact: ["go.mod"] },
  { kind: "rust", exact: ["Cargo.toml"] },
  { kind: "java", exact: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"] },
  { kind: "php", exact: ["composer.json"] },
  { kind: "elixir", exact: ["mix.exs"] },
  { kind: "swift", exact: ["Package.swift"] },
  { kind: "xcode", suffix: [".xcodeproj", ".xcworkspace"] },
  { kind: "dotnet", suffix: [".csproj", ".fsproj", ".sln"] },
  { kind: "flutter", exact: ["pubspec.yaml"] },
];

/** CI systems configured by a single file at the root. */
const FLAT_CI: { kind: CiKind; exact: string[] }[] = [
  { kind: "gitlab-ci", exact: [".gitlab-ci.yml"] },
  { kind: "travis", exact: [".travis.yml"] },
  { kind: "jenkins", exact: ["Jenkinsfile"] },
  { kind: "azure-pipelines", exact: ["azure-pipelines.yml", "azure-pipelines.yaml"] },
];

const VCS_DIRS: { name: string; vcs: Vcs }[] = [
  { name: ".git", vcs: "git" },
  { name: ".hg", vcs: "mercurial" },
  { name: ".svn", vcs: "subversion" },
];

const CONVENTION_FILES = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"];

/**
 * Inspect a directory through an injected listing. Pure: same listing, same
 * report, no clock, no filesystem, no ordering dependency on readdir.
 */
export function readGround(list: ListDir): Ground {
  const root = list("");
  const names = new Set(root.map((e) => e.name));

  // `.git` is a FILE inside a git worktree (it points at the real gitdir), and
  // every shadok agent works in one — testing `isDirectory()` here would
  // misreport exactly the directories this project spends its life in.
  const vcs = VCS_DIRS.find((v) => names.has(v.name))?.vcs ?? null;

  const stacks: StackHit[] = [];
  for (const s of STACKS) {
    const marker =
      s.exact?.find((n) => names.has(n)) ??
      (s.suffix ? findBySuffix(root, s.suffix) : undefined);
    if (marker) stacks.push({ kind: s.kind, marker });
  }

  const ci: CiHit[] = [];
  // GitHub Actions is the directory's CONTENTS, not the directory: an empty
  // `.github/workflows` (or a `.github` holding only an issue template) is not
  // a configured CI, and reporting one would be the invented answer this
  // module exists to avoid.
  const workflows = list(path.posix.join(".github", "workflows"));
  if (workflows.length > 0) {
    ci.push({ kind: "github-actions", marker: ".github/workflows" });
  }
  if (list(".circleci").some((e) => e.name === "config.yml" || e.name === "config.yaml")) {
    ci.push({ kind: "circleci", marker: ".circleci/config.yml" });
  }
  for (const c of FLAT_CI) {
    const marker = c.exact.find((n) => names.has(n));
    if (marker) ci.push({ kind: c.kind, marker });
  }

  const conventions: string[] = [];
  for (const f of CONVENTION_FILES) {
    const hit = root.find((e) => !e.dir && e.name.toLowerCase() === f.toLowerCase());
    if (hit) conventions.push(hit.name);
  }
  // A README is any of README, README.md, README.rst… — matched by prefix, and
  // reported under the name it actually has.
  const readme = root.find((e) => !e.dir && e.name.toLowerCase().startsWith("readme"));
  if (readme) conventions.push(readme.name);

  return {
    vcs,
    stacks,
    ci,
    conventions,
    empty: root.length === 0,
    unrecognised: vcs === null && stacks.length === 0 && ci.length === 0,
  };
}

function findBySuffix(entries: GroundEntry[], suffixes: string[]): string | undefined {
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (suffixes.some((s) => lower.endsWith(s))) return e.name;
  }
  return undefined;
}

/**
 * `readGround` against the real filesystem. Thin on purpose — everything worth
 * testing lives in the pure core, and this half is the part that cannot be.
 *
 * A directory that does not exist, or that we may not read, lists as empty
 * rather than throwing: "I cannot see anything here" and "there is nothing
 * here" lead to the same honest register, and neither is worth a crash on a
 * path that only ever produces a greeting.
 */
export function readGroundAt(dir: string): Ground {
  return readGround((rel) => {
    try {
      return fs
        .readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })
        .map((d) => ({ name: d.name, dir: d.isDirectory() }));
    } catch {
      return [];
    }
  });
}
