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
