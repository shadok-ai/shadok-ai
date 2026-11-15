import { execFileSync } from "node:child_process";
import { claudeCommand } from "./claude-bin.js";
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
 * restrict itself to containers (invariant 19), no Docker gate is needed here:
 * on a machine that has used Claude Code before, the plan is empty and nothing
 * is written at all.
 *
 * See docs/superpowers/specs/2026-08-08-claude-onboarding-design.md.
 */

export interface ClaudeHome {
  hasCompletedOnboarding?: boolean;
  lastOnboardingVersion?: string;
  theme?: string;
  /** The auto-mode environment screen's state. `denials` is the CLI's own
   *  counter; `dismissed`/`dismissedAt` are the user's answer. */
  autoModeEnvSetup?: Record<string, unknown>;
  /** The resume quota dialog's "don't warn me" flag. GLOBAL, never per project. */
  resumeReturnDismissed?: boolean;
  projects?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

/** The per-project keys that answer the trust dialog. */
const ADDITIVE_PROJECT_KEYS = ["hasCompletedProjectOnboarding"] as const;

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
  // These two answer the theme picker. `theme` is deliberately NOT written:
  // verified 2026-08-08 that the CLI DELETES an unknown top-level `theme` key
  // on its next write, and that the picker is already skipped without it — so
  // seeding one would be cargo cult that also implies we control the theme.
  add("hasCompletedOnboarding", true);
  add("lastOnboardingVersion", opts.version);

  // `resumeReturnDismissed` gates THREE separate resume-time asks, not one
  // screen — all three read it and bail out when it is true (2.1.304 bundle).
  // Do not delete it the day one of them goes away.
  //
  // a) "Resume this conversation? … will use about N% of your 5-hour usage
  //    limit." — a BLOCKING single-select (Resume / Start a new conversation)
  //    on a Pro/Max plan. Gate: the statsig config `tengu_amber_tally` must
  //    parse (no config, no dialog), the account must not already be
  //    rate-limited, and the resume must cost >= `minPercent` (default 5) of
  //    the 5-hour limit. Two triggers, `resume` and `idle`.
  // b) A compact-or-continue ask. Gate: flags `tengu_gleaming_fair` /
  //    `tengu_gleaming_fair_reuse`, idle >= CLAUDE_CODE_RESUME_THRESHOLD_MINUTES
  //    (default 70) and size >= CLAUDE_CODE_RESUME_TOKEN_THRESHOLD (default
  //    100000). Outcomes: compact / continue / dismiss / never — and `compact`
  //    RUNS a compaction. This is the one that matters most to shadok: every
  //    weeks-old agent clears 70 minutes and 100k tokens trivially.
  // c) A model-family announcement, gated on the statsig config
  //    `tengu_hidden_volcano` ({enabled, form: "line"|"dialog", families,
  //    maxAsks, minHoursBetween}).
  // The on-screen wording of (b) and (c) was NOT recovered — the bundle keeps
  // their UI copy away from the component — so they are described by gate and
  // action only. Both are identical in 2.1.303 and 2.1.304, i.e. pre-existing;
  // only (a)'s `offersLookUp` branch is new in 2.1.304.
  //
  // Unseeded, a fresh instance stalls on EVERY resume path until a human
  // answers: `reconcileOnBoot` after an auto-update, Reload agent, `/reload`,
  // restart-all, `spawn --resume`. A cron-driven cockpit has nobody to answer.
  //
  // The trade-off: dismissing them drops a quota signal. shadok already
  // surfaces that signal itself (`/usage`, the pace guard in `src/pace.ts`),
  // and the alternative is a dialog on every reload of every large agent.
  //
  // TOP-LEVEL, not per project: that is where the CLI writes it. ADDITIVE,
  // unlike `hasTrustDialogAccepted` below, and the reason is verified: the
  // CLI's only write site sets it to `true`, reached only when the human picks
  // "never". The CLI never writes `false`, so a `false` can only be a
  // deliberate hand edit by someone who wants the asks back — respect it.
  add("resumeReturnDismissed", true);

  // "Teach auto mode about your environment?" — a BLOCKING form offering to
  // scan the user's shell history (PRE-TICKED) and their other repositories.
  // Someone hitting Continue to unblock an agent opts into that scan without
  // meaning to, so shadok picks the screen's own "Don't show again".
  //
  // The gate, read out of the 2.1.241 binary: `numStartups >= 5` AND
  // `denials >= 5` AND mode `auto` AND not dismissed — fired at query_end,
  // i.e. AFTER a turn, which is why no start-up probe ever caught it.
  //
  // MERGED ON THE SUB-KEY, and that is the whole point. The CLI writes
  // `autoModeEnvSetup: {denials: n}` on its own from the first refusal, so a
  // rule that is additive on the WHOLE key silently no-ops from then on — and
  // would protect only instances that never denied anything, which are exactly
  // the ones that can never reach the threshold. The counter is preserved; only
  // the missing verdict is supplied.
  //
  // A real answer is left alone: `dismissed` present (the user decided) or
  // `dismissedAt` present ("Not now", which brings the screen back in seven
  // days). A counter is not an answer.
  const env = { ...((existing.autoModeEnvSetup as Record<string, unknown> | undefined) ?? {}) };
  if (!("dismissed" in env) && !("dismissedAt" in env)) {
    env.dismissed = true;
    out.autoModeEnvSetup = env;
    changed = true;
  }

  if (opts.cwd) {
    const projects = { ...(existing.projects ?? {}) };
    const entry = { ...(projects[opts.cwd] ?? {}) };
    let entryChanged = false;
    // THE one exception to the additive rule, and it is deliberate.
    //
    // shadok is what chose this directory: the user expressed trust by pointing
    // an agent at it. A `hasTrustDialogAccepted: false` left by anything —
    // an older shadok, a restored config, a hand-run `claude` — would survive
    // forever under "never overwrite", and the trust dialog would greet every
    // single spawn. That is not preserving a choice, it is defeating the module.
    if (entry.hasTrustDialogAccepted !== true) {
      entry.hasTrustDialogAccepted = true;
      entryChanged = true;
    }
    // Everything else stays additive: a value already there is the CLI's.
    for (const key of ADDITIVE_PROJECT_KEYS) {
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

/**
 * Pure: the object to write after trusting EVERY cwd in `cwds` (plus the
 * globals), or null when nothing is missing.
 *
 * This is `seedPlan` folded over many directories so a shared group HOME is
 * seeded in ONE atomic write instead of one racy write per spawn. The
 * motivating bug: N agents share a single `~/.claude.json`, and rebuilding it
 * one cwd at a time during a boot respawn storm let a sibling `claude`'s stale
 * write clobber a trust entry before that agent's own process read it —
 * stranding it on the "trust this folder" dialog. Seeding the complete set up
 * front (before any such process starts) removes the window entirely. Each
 * `cwd` keeps `seedPlan`'s additive, never-overwrite discipline.
 */
export function seedPlanForCwds(
  existing: ClaudeHome,
  opts: { version: string; cwds: readonly string[] },
): ClaudeHome | null {
  let current = existing;
  let changed = false;
  // Globals first (no cwd), then each directory — threading the running object
  // so every change lands in one result. seedPlan returns null for "nothing to
  // add", in which case we keep the object we already have.
  const steps: Array<string | undefined> = [undefined, ...opts.cwds];
  for (const cwd of steps) {
    const next = seedPlan(current, { version: opts.version, cwd });
    if (next) {
      current = next;
      changed = true;
    }
  }
  return changed ? current : null;
}

export interface ClaudeSettings {
  tui?: string;
  [k: string]: unknown;
}

/**
 * Pure: `~/.claude/settings.json` after adding the keys that suppress a
 * first-run *upsell*, or null when nothing is missing.
 *
 * The fullscreen upsell ("Flicker-free output · Mouse support · Selected text
 * auto-copies") is not gated by the onboarding flags — it appears AFTER the
 * sign-in, which is why no probe caught it before a real account reached the
 * screen. It is counted by `fullscreenUpsellSeenCount`, but seeding a counter
 * means guessing its threshold; recording an explicit `tui` preference is the
 * durable answer, because a choice already made cannot be upsold. Evidence: a
 * developer machine with `tui` set has never accumulated that counter in 792
 * startups.
 */
export function settingsPlan(existing: ClaudeSettings): ClaudeSettings | null {
  if ("tui" in existing) return null; // the user's own choice, never overridden
  // "fullscreen" is the value both working installations run — shadok reads
  // content from the transcript, not the screen, so the TUI's rendering mode
  // does not affect it either way.
  return { ...existing, tui: "fullscreen" };
}

const homeFile = (): string => path.join(os.homedir(), ".claude.json");
const settingsFile = (): string => path.join(os.homedir(), ".claude", "settings.json");

/** The claude CLI's version, or a conservative fallback. */
function claudeVersion(): string {
  try {
    return (
      parseClaudeVersion(execFileSync(claudeCommand(), ["--version"], { encoding: "utf8" })) ?? "0.0.0"
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
    if (existing === null) {
      // Saying nothing here cost a long investigation: a seeding that never ran
      // looked exactly like one that ran, and the first-run screens that came
      // back had no explanation anywhere.
      console.log(`claude-home: ${file} is unreadable — left alone, so first-run screens may appear`);
      return;
    }
    const plan = seedPlan(existing, { version: claudeVersion(), cwd });
    if (plan) writeHome(file, plan);
  } catch (e) {
    // A failed seed must never take down the boot path or a spawn — same rule
    // as ensureSshIdentity — but it must not be invisible either.
    console.log(`claude-home: could not seed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Called once at boot: the globals, plus the settings that kill the upsell. */
export function ensureClaudeHome(): void {
  seed();
  seedSettings();
}

/** Apply `settingsPlan` to `~/.claude/settings.json`. Same rules as `seed`. */
function seedSettings(): void {
  try {
    const file = settingsFile();
    let existing: ClaudeSettings | null = {};
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        existing =
          parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        existing = null; // hand-edited into invalid JSON → never clobber it
      }
    }
    if (existing === null) return;
    const plan = settingsPlan(existing);
    if (!plan) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.shadok-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Never take down the boot path.
  }
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

/**
 * The machine-wide default model, read from and written to the SAME
 * `~/.claude/settings.json` this module already owns.
 *
 * Deliberately here and not in a module of its own: `seedSettings` already
 * writes that file, and two writers on one JSON file is how a `tui` seeded at
 * boot and a model written from the GUI would eventually erase each other. One
 * owner, one atomic write.
 *
 * Verified 2026-09-25 against claude 2.1.282, because the whole feature rests
 * on it: with `model` in that file and NO `--model` flag, the run used
 * `claude-haiku-4-5-20251001`; and it is still honoured when shadok also passes
 * `--settings` for a profile's guardrails, so the flag MERGES rather than
 * replacing the file. Without that second check the setting would have been
 * silently inert for every agent that carries a profile.
 */
export function getDefaultModel(): string | null {
  try {
    const raw = fs.readFileSync(settingsFile(), "utf8");
    const m = JSON.parse(raw)?.model;
    return typeof m === "string" && m.trim() ? m.trim() : null;
  } catch {
    return null;
  }
}

/** Write (or clear, with null) that default. Returns false if it could not. */
export function setDefaultModel(model: string | null): boolean {
  try {
    const file = settingsFile();
    let existing: ClaudeSettings = {};
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      // Hand-edited into invalid JSON, or not an object: leave it ALONE rather
      // than "repair" it — same rule as `seed`, and for the same reason.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      existing = parsed;
    }
    const next: ClaudeSettings = { ...existing };
    if (model?.trim()) next.model = model.trim();
    else delete next.model;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.shadok-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
