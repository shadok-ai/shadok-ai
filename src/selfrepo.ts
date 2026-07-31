import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A working copy of shadok-ai's own source, so a user who installed the cockpit
 * with `npx shadok-ai` — no clone, no rights on the repo — can still have an
 * agent change it. The clone is anonymous over HTTPS: nothing here needs
 * authentication, which is what lets the user watch an agent work and read its
 * diff before connecting any GitHub account.
 */
export const SELF_REPO_URL = "https://github.com/shadok-ai/shadok-ai.git";

/** Our own copy, never the directory the running server was launched from. */
export function selfRepoDir(): string {
  return path.join(os.homedir(), ".shadok-ai", "self", "shadok-ai");
}

export type SelfRepoPlan = "clone" | "update" | "reclone";

/** Pure: what to do with the checkout, given what is on disk. */
export function selfRepoPlan(exists: boolean, isRepo: boolean): SelfRepoPlan {
  if (!exists) return "clone";
  return isRepo ? "update" : "reclone";
}

/**
 * Pure: a short, human reason for a git failure — it is rendered on the CTA
 * card, so it must never come back empty.
 */
export function gitFailReason(e: unknown): string {
  const err = e as { code?: string; stderr?: string | Buffer } | null;
  if (err?.code === "ENOENT") return "git is not installed";
  const line = String(err?.stderr ?? "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  return line ? line.slice(0, 120) : "git failed";
}

export interface SelfRepoResult {
  cwd?: string;
  error?: string;
}

function git(args: string[], cwd?: string): void {
  execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    // A cold clone over a slow link is minutes, not seconds.
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Makes sure the source checkout exists and its `main` matches the remote, so a
 * tweak never starts from a stale base. Only the base clone is refreshed: the
 * worktrees a tweak session owns are separate checkouts and are never touched —
 * refreshing under a live agent is how you lose its work.
 */
export function ensureSelfRepo(): SelfRepoResult {
  const dir = selfRepoDir();
  const plan = selfRepoPlan(fs.existsSync(dir), fs.existsSync(path.join(dir, ".git")));
  try {
    if (plan === "reclone") fs.rmSync(dir, { recursive: true, force: true });
    if (plan === "update") {
      git(["fetch", "origin", "--prune"], dir);
      git(["checkout", "main"], dir);
      // Hard reset rather than pull: a half-applied state can otherwise wedge
      // the checkout for good, and nobody edits this main by hand.
      git(["reset", "--hard", "origin/main"], dir);
    } else {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(["clone", SELF_REPO_URL, dir]);
    }
    return { cwd: dir };
  } catch (e) {
    return { error: gitFailReason(e) };
  }
}
