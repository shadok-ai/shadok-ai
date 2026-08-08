import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Seeding of Claude Code's first-run state.
 *
 * A virgin `claude` opens on its theme picker, then on a per-directory trust
 * dialog, and never reaches a prompt: no input box, every submitted prompt
 * fails, the tab reads "failed to start". That is how three zombie agents were
 * once produced on a production container and found a day later.
 *
 * So shadok writes the handful of keys that answer those screens. The module is
 * PURELY ADDITIVE — it only ever adds keys that are absent — which is what
 * makes it safe to run unconditionally. Unlike `src/ssh.ts`, which had to
 * restrict itself to containers (invariant 21), no Docker gate is needed here:
 * on a machine that has used Claude Code before, the plan is empty and nothing
 * is written at all.
 *
 * See docs/superpowers/specs/2026-08-08-claude-onboarding-design.md.
 */

export interface ClaudeHome {
  hasCompletedOnboarding?: boolean;
  lastOnboardingVersion?: string;
  theme?: string;
  projects?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

/** The per-project keys that answer the trust dialog. */
const PROJECT_KEYS = ["hasTrustDialogAccepted", "hasCompletedProjectOnboarding"] as const;

/** Pure: the semver out of `claude --version` ("2.1.226 (Claude Code)"). */
export function parseClaudeVersion(stdout: string): string | null {
  const m = stdout.match(/^\s*(\d+\.\d+\.\d+[^\s(]*)/);
  return m ? m[1] : null;
}

/**
 * Pure: the object to write, or null when nothing is missing.
 *
 * Returning null (rather than an identical object) is what lets the writer skip
 * the write entirely — a multi-megabyte file is not rewritten for nothing.
 */
export function seedPlan(
  existing: ClaudeHome,
  opts: { version: string; cwd?: string },
): ClaudeHome | null {
  const out: ClaudeHome = { ...existing };
  let changed = false;

  const add = (key: string, value: unknown) => {
    if (!(key in out)) {
      out[key] = value;
      changed = true;
    }
  };
  add("hasCompletedOnboarding", true);
  add("lastOnboardingVersion", opts.version);
  add("theme", "dark");

  if (opts.cwd) {
    const projects = { ...(existing.projects ?? {}) };
    const entry = { ...(projects[opts.cwd] ?? {}) };
    let entryChanged = false;
    for (const key of PROJECT_KEYS) {
      if (!(key in entry)) {
        entry[key] = true;
        entryChanged = true;
      }
    }
    if (entryChanged) {
      projects[opts.cwd] = entry;
      out.projects = projects;
      changed = true;
    }
  }

  return changed ? out : null;
}

const homeFile = (): string => path.join(os.homedir(), ".claude.json");

/** The claude CLI's version, or a conservative fallback. */
function claudeVersion(): string {
  try {
    return (
      parseClaudeVersion(execFileSync("claude", ["--version"], { encoding: "utf8" })) ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

/**
 * Read the file, or null when it exists but does not parse.
 *
 * Null means "leave it alone". We never "repair" an unparseable ~/.claude.json
 * by overwriting it: the file carries the whole per-project history, and
 * destroying it costs incomparably more than the screen this module avoids.
 */
function readHome(file: string): ClaudeHome | null {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomic write: a temp file in the SAME directory, then rename. An interrupted
 * write must never leave a truncated ~/.claude.json behind.
 */
function writeHome(file: string, data: ClaudeHome): void {
  const tmp = `${file}.shadok-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Apply a plan for `cwd` (or the globals only when cwd is undefined). */
function seed(cwd?: string): void {
  try {
    const file = homeFile();
    const existing = readHome(file);
    if (existing === null) return; // unparseable → hands off
    const plan = seedPlan(existing, { version: claudeVersion(), cwd });
    if (plan) writeHome(file, plan);
  } catch {
    // A failed seed must never take down the boot path or a spawn — same rule
    // as ensureSshIdentity.
  }
}

/** Called once at boot: the globals that answer the theme picker. */
export function ensureClaudeHome(): void {
  seed();
}

/**
 * Called before EVERY spawn, for that session's directory.
 *
 * This cannot be a boot-time-only concern: a worktree is a brand-new directory
 * for every agent, therefore a brand-new trust dialog every time.
 */
export function ensureProjectTrusted(cwd: string): void {
  seed(cwd);
}
