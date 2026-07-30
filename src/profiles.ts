import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Agent profiles — a named role applied at spawn (dev, marketing…): a system
 * prompt, native Claude permission guardrails (e.g. deny git writes), extra
 * secrets, and an optional model. GLOBAL: one profile is reusable across repos.
 * Stored at ~/.shadok-ai/profiles.json (600 — it can hold secrets).
 *
 * SOFT isolation: agents run as the same OS user, so this is a role + guardrail
 * layer, NOT a security sandbox (an agent that tries can read another's env).
 */
export interface Profile {
  name: string;
  systemPrompt?: string;
  /** Claude permission deny patterns, e.g. "Bash(git commit:*)". */
  deny?: string[];
  /** Claude permission allow patterns (optional). */
  allow?: string[];
  /** Names of vault secrets to inject as env (references, not values). */
  secrets?: string[];
  model?: string;
}

/** Deny patterns that keep an agent from writing to git — the read-only preset. */
export const READONLY_DENY = [
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(git add:*)",
  "Bash(git reset:*)",
  "Bash(git rebase:*)",
  "Bash(git merge:*)",
  "Bash(git checkout:*)",
];

/**
 * Starter profiles, seeded on first run (when no profiles exist yet). Roles are
 * generic on purpose — project specifics live in the repo/CLAUDE.md the agent
 * reads. dev has full access; marketing & support are read-only (no git writes).
 * Secrets are left empty — the user ticks which vault secrets each one injects.
 */
export const DEFAULT_PROFILES: Profile[] = [
  {
    name: "Shadok-dev",
    systemPrompt:
      "You are Shadok-dev, a senior software engineer on this project. Read the repo, CLAUDE.md and docs for context and follow the existing conventions. Make small, well-tested changes; run the tests. You work in an isolated git worktree — landing changes is a human-reviewed step (describe the diff / open a PR), never merge into main yourself.",
    secrets: [],
  },
  {
    name: "Shadok-Marketing",
    systemPrompt:
      "You are Shadok-Marketing, the paid-marketing & growth agent. Read the product's code, docs and site to understand exactly what it does, then produce marketing work: ad copy, campaign plans, audience/keyword research, landing-page and messaging suggestions, analytics reads. You have READ-ONLY access to the code — git writes are blocked, never modify or commit it. Ground every claim in what the product actually does; be concrete and conversion-focused. Conclusion first, compact answers.",
    deny: READONLY_DENY,
    secrets: [],
  },
  {
    name: "Shadok-Support",
    systemPrompt:
      "You are Shadok-Support, the customer-support agent. Read the code, docs and changelog to answer user questions accurately. Draft clear, friendly, correct replies; when unsure, say what you'd verify. You have READ-ONLY access to the code — git writes are blocked, never modify or commit it. Diagnose from the repo but escalate code fixes to a dev rather than editing.",
    deny: READONLY_DENY,
    secrets: [],
  },
];

const FILE = path.join(os.homedir(), ".shadok-ai", "profiles.json");

/** Pure: a system-prompt line telling the agent which env-var secrets it has,
 *  so it knows what's available without hunting. "" when there are none. */
export function envVarsNote(names: string[]): string {
  if (!names.length) return "";
  return (
    `Secrets available to you as environment variables: ${names.join(", ")}. ` +
    `Read them from the environment (e.g. $NAME / process.env.NAME); never print or commit their values.`
  );
}

export function loadProfiles(): Profile[] {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(v) ? v.filter((p) => p && typeof p.name === "string") : [];
  } catch {
    return [];
  }
}

function saveProfiles(list: Profile[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}

export function getProfile(name: string): Profile | undefined {
  return loadProfiles().find((p) => p.name === name);
}

/** Seed the starter profiles once, when the store is still empty. Idempotent. */
export function seedDefaultProfiles(): void {
  if (loadProfiles().length) return;
  saveProfiles(DEFAULT_PROFILES);
}

export function profileNames(): string[] {
  return loadProfiles().map((p) => p.name);
}

export function upsertProfile(p: Profile): void {
  const list = loadProfiles().filter((x) => x.name !== p.name);
  list.push(p);
  saveProfiles(list);
}

export function removeProfile(name: string): void {
  saveProfiles(loadProfiles().filter((p) => p.name !== name));
}

// ── Pure cores (unit-tested) ─────────────────────────────────────────────

/**
 * The extra `claude` CLI args a profile contributes: an appended system prompt
 * (role), inline permission settings (deny/allow), and a model. Returns [] for
 * an undefined/empty profile so a no-profile spawn is unchanged.
 */
export function profileArgs(profile?: Profile | null): string[] {
  if (!profile) return [];
  const args: string[] = [];
  if (profile.systemPrompt?.trim()) args.push("--append-system-prompt", profile.systemPrompt.trim());
  const deny = profile.deny ?? [];
  const allow = profile.allow ?? [];
  if (deny.length || allow.length) {
    args.push("--settings", JSON.stringify({ permissions: { deny, allow } }));
  }
  if (profile.model?.trim()) args.push("--model", profile.model.trim());
  return args;
}

/**
 * Permission modes we accept. "default" is our sentinel for "pass no flag" (use
 * Claude's own default); the rest are the real `claude --permission-mode`
 * choices (v2.1.x). "auto" is the Shift+Tab "auto mode on"; "acceptEdits" only
 * auto-applies file edits.
 */
export const PERMISSION_MODES = [
  "default",
  "manual",
  "acceptEdits",
  "auto",
  "dontAsk",
  "plan",
  "bypassPermissions",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Whether `m` is a permission mode we recognize. */
export function isPermissionMode(m: string): m is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(m);
}

/**
 * The `--permission-mode` flag for a spawn, given the resolved mode. Empty /
 * invalid / "default" → [] (no flag, Claude's own default). Otherwise the
 * matching `claude --permission-mode <m>` flag.
 */
export function permissionModeArgs(raw: string | undefined): string[] {
  const m = (raw ?? "").trim();
  return m && m !== "default" && isPermissionMode(m) ? ["--permission-mode", m] : [];
}

