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
  /**
   * The role text. ABSENT on a shipped profile the user never edited: the build's
   * own prompt is resolved at spawn instead (`effectiveProfile`), so it can never
   * go stale. Present means the user owns it.
   */
  systemPrompt?: string;
  /**
   * The shipped prompt this one was forked from, recorded when a shipped role is
   * first edited. It is what lets us say "the build has moved since" rather than
   * merely "you edited this".
   */
  promptBase?: string;
  /** Claude permission deny patterns, e.g. "Bash(git commit:*)". */
  deny?: string[];
  /** Claude permission allow patterns (optional). */
  allow?: string[];
  /** Names of vault secrets to inject as env (references, not values). */
  secrets?: string[];
  model?: string;
  /** May this agent answer a dialog pending on one of ITS OWN children?
   *  Opt-in on purpose: answering a child's permission prompt lets a
   *  READONLY_DENY agent authorise a child to do what it cannot do itself, so
   *  as an ambient right it would make the guardrail that forces delegation
   *  bypassable BY delegating. */
  canAnswerChildren?: boolean;
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
    // First: this is the way in, so the first card in the box. Read-only ON
    // PURPOSE — a boss with their hands in the code stops delegating. Blocked
    // git writes force them to go through an agent.
    name: "Shadok-Boss",
    systemPrompt:
      "You are Shadok-Boss, the lead agent of this environment. You run on the `general` channel — the user talks to you first. You have two jobs, in this order.\n\n" +
      "KNOW. Read the repo, CLAUDE.md, docs/ and its specs, and the git history before you answer. When the user asks a question, answer it yourself: conclusion first, compact. Never make someone wait behind a spawned agent when a read would do.\n\n" +
      "DELEGATE. You have READ-ONLY access to the code — git writes are blocked, and that is deliberate. Every piece of actual work (a feature, a fix, a refactor, a research pass) goes to a dedicated agent, never to you. Use the `shadok-ai-agents` skill: `pilotctl.mjs spawn --worktree --profile <role> --cwd <repo>`, then `prompt <id> \"<brief>\"` in the background. Write a brief precise enough to be executed without you: the goal, the constraints, and how you'll know it's done. Then follow up, read `diff <id>`, and report it to the user.\n\n" +
      "Pick the role deliberately: Shadok-dev for code, Shadok-Marketing for paid acquisition and ad copy, Shadok-Content for articles and organic/SEO work, Shadok-Support for user-facing answers. Spawn without --profile only when none of them fits.\n\n" +
      "SHAPE THE ROLES. You may rewrite any profile's system prompt, and mint new ones, with `pilotctl.mjs profile-prompt \"<text>\" --name <role> [--readonly]` — use it to record what a role should have known from the start. You cannot touch a profile's guardrails (deny/allow/secrets/model): those are the human's, and a role you create never carries a vault secret. A prompt change takes effect at that agent's next restart.\n\n" +
      "Say what you are about to spawn and why BEFORE you spawn it — each agent burns the same quota as a normal session, so delegate on purpose, not by reflex. Never land anything yourself: merging is a human-reviewed step. Never stop a session you did not create — it may be the user's own.",
    deny: READONLY_DENY,
    secrets: [],
    // The boss is the one role that exists to run other agents, so it is the
    // one that may unblock them. Everything else keeps the default (absent).
    canAnswerChildren: true,
  },
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
    // Sibling of Shadok-Marketing, not a duplicate: Marketing BUYS the
    // audience (ads, campaigns, conversion), this one EARNS it (organic
    // search). Merging the two would give one bloated profile, bad at both
    // ends.
    //
    // READONLY_DENY blocks GIT writes only, never Write/Edit — and that is
    // vital here: this profile's deliverable IS a file. The prompt says so
    // explicitly, because Marketing's wording ("never modify or commit it") is
    // enough to make an agent refuse to create a draft.
    name: "Shadok-Content",
    systemPrompt:
      "You are Shadok-Content, the organic-content & SEO agent. Shadok-Marketing owns paid acquisition; you own the traffic that is earned rather than bought — articles, guides, landing-page copy, docs used as content.\n\n" +
      "START FROM THE PRODUCT, NOT FROM THE KEYWORD. Read the repo, README, CLAUDE.md, docs/ and the site until every claim you make is something the product actually does. A piece that oversells costs more than no piece at all.\n\n" +
      "WORK THE INTENT. For each piece, settle three things before writing: who is searching, what they already know, and what they must be able to do afterwards. Pick ONE primary query plus the cluster around it. Then structure for that intent — an H1 that answers it, H2s that map to the real sub-questions, and the answer in the first paragraph instead of after a wind-up. Repeating the query does not rank a thin page; keyword stuffing reads as spam to a human and to a crawler.\n\n" +
      "DELIVER A FILE. Write each piece as a Markdown file in the working directory — a content/ or drafts/ folder if one exists, otherwise alongside the docs — one file per piece, with front matter carrying title, description (155 characters max), slug and the target query. Suggest internal links only to pages you have verified exist.\n\n" +
      "You MAY write and edit files: your drafts are the deliverable. What you must not touch is the product's source code, and git writes are blocked — a human reviews and commits. If search-console or analytics credentials are available to you as environment variables, use them to ground topic choice in queries the site actually receives rather than in guesses.\n\n" +
      "No filler, no \"in today's fast-paced world\". If a topic does not deserve a page, say so instead of writing one.",
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
  // Worded to head off the reflex that kept failing agents: going hunting for
  // a .env to load, then concluding the secret is missing. So we say
  // explicitly that it is ALREADY set, and give the presence test that does
  // not reveal the value.
  return (
    `Credentials available to you: ${names.join(", ")}. ` +
    `They are already set as environment variables in every command you run with the Bash tool — ` +
    `there is no .env file to load and nothing to source or export. Use them directly, e.g. ` +
    `curl -H "Authorization: Bearer $${names[0]}" …, or process.env.${names[0]} in Node. ` +
    `To check one is present without revealing it: [ -n "$${names[0]}" ] && echo set. ` +
    `Never print, log or commit their values.`
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
/**
 * Install the starter profiles on a fresh instance — WITHOUT their prompts.
 *
 * Storing the text would freeze it: profiles.json then owns a copy that no
 * later release can move. Seeding the guardrails only leaves each role tracking
 * the build's prompt (`effectiveProfile` resolves it at spawn), so an instance
 * installed today and one installed a month ago run the same role.
 */
export function seedDefaultProfiles(): void {
  if (loadProfiles().length) return;
  saveProfiles(DEFAULT_PROFILES.map(({ systemPrompt: _tracked, ...rest }) => rest as Profile));
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


/** The managed profile behind the "Tweak Shadok-AI" CTA. */
export const TWEAK_PROFILE_NAME = "Shadok-Tweak";

/**
 * Pure: the profile after refreshing ONLY its system prompt. The prompt is
 * server-owned (it tracks `context/tweak-prompt.md` and would otherwise go
 * stale in the user's profiles.json), but a secret or model the user attached
 * in the editor is theirs and survives.
 */
export function withManagedPrompt(
  existing: Profile | undefined,
  name: string,
  systemPrompt: string,
): Profile {
  return { ...(existing ?? { name }), name, systemPrompt };
}

/**
 * One-off migration: every profile whose stored prompt merely repeats the
 * build's starts tracking it instead. Returns the names adopted (for the log).
 *
 * Idempotent, and a no-op on a fresh install. Nothing changes today — the
 * resolved prompt is byte-identical — but from now on those roles follow the
 * build instead of the copy their first boot happened to write.
 */
export function migrateToTracking(): string[] {
  const { profiles, adopted } = adoptTracking(loadProfiles());
  if (adopted.length) saveProfiles(profiles);
  return adopted;
}

/** Install/refresh the tweak profile from the repo's prompt file. Idempotent. */
export function seedTweakProfile(systemPrompt: string): void {
  upsertProfile(withManagedPrompt(getProfile(TWEAK_PROFILE_NAME), TWEAK_PROFILE_NAME, systemPrompt));
}

/** The lead profile: the only one allowed to shape OTHER profiles (see below). */
export const BOSS_PROFILE_NAME = "Shadok-Boss";

export type PromptEdit = { ok: true; create: boolean } | { ok: false; error: string };

/**
 * Who may rewrite whose `systemPrompt` — the whole policy, in one pure place.
 *
 * An agent may reshape its OWN role and nothing else; the lead profile may
 * reshape any role and mint new ones. What NOBODY may touch through this path
 * is `deny`/`allow`/`secrets`/`model`: the guardrails stay the human's, behind
 * the same-origin gate on `PUT /profiles`. Letting an agent edit its own `deny`
 * would let a read-only agent hand itself git writes.
 *
 * Soft by construction: agents run as the same OS user and can rewrite
 * ~/.shadok-ai/profiles.json directly. This removes the accident and keeps the
 * capability off the documented surface — it is not a sandbox.
 */
export function promptEditVerdict(opts: {
  /** Profile of the calling session, null when it spawned bare. */
  caller: string | null;
  /** Profile being edited. */
  target: string;
  targetExists: boolean;
  /** Prompt owned by the server (refreshed from a repo file at every boot). */
  managed: boolean;
}): PromptEdit {
  const target = opts.target.trim();
  if (!target) return { ok: false, error: "profile name required" };
  // Refuse rather than swallow: a managed prompt would be rewritten at the
  // next boot and the edit would vanish without a word.
  if (opts.managed)
    return {
      ok: false,
      error: `${target} takes its prompt from context/tweak-prompt.md at every boot — edit that file instead`,
    };
  if (!opts.caller) return { ok: false, error: "this agent has no profile, so it has no prompt to edit" };
  if (opts.caller === BOSS_PROFILE_NAME) return { ok: true, create: !opts.targetExists };
  if (target !== opts.caller)
    return { ok: false, error: `an agent may only edit its own profile (${opts.caller})` };
  if (!opts.targetExists) return { ok: false, error: `${target} no longer exists` };
  return { ok: true, create: false };
}

/** Where a profile's prompt comes from, seen from THIS build. */
export type PromptOrigin = "tracked" | "edited" | "outdated" | "custom";

/**
 * What a stored profile's prompt IS, relative to the one this build ships.
 *
 *   tracked  — nothing stored: the build's prompt is used, always current.
 *   edited   — the user wrote their own, and the build has not moved since.
 *   outdated — the user's own, but the build's has changed since they forked.
 *   custom   — a role this build knows nothing about; entirely theirs.
 *
 * A shipped role that is never touched stores NO prompt at all. That is the
 * whole point: a copy is what goes stale, so there is no copy. Before this, the
 * starter prompts were written to profiles.json on first boot and then owned by
 * that file forever — an instance installed weeks ago still ran the wording of
 * the day, untouched and silently behind, and only the managed Shadok-Tweak
 * role escaped it by being rewritten at every boot.
 *
 * Trimmed on both sides: a trailing newline from an editor is not a rewrite.
 */
export function promptOrigin(stored: Profile, shipped: Profile | undefined): PromptOrigin {
  // Shadok-Tweak is not in DEFAULT_PROFILES — it is seeded from
  // context/tweak-prompt.md and rewritten at every boot — so `shipped` is
  // undefined for it. Reporting the one role that is ALWAYS current as "custom"
  // would be exactly backwards.
  if (stored.name === TWEAK_PROFILE_NAME) return "tracked";
  if (!shipped) return "custom";
  if (stored.systemPrompt === undefined) return "tracked";
  const mine = (stored.systemPrompt ?? "").trim();
  const ship = (shipped.systemPrompt ?? "").trim();
  if (mine === ship) return "tracked";     // identical: nothing to own
  // `promptBase` is the shipped text they forked from. Without it (a profile
  // edited before this existed) we cannot tell a stale fork from a current one,
  // and claiming "outdated" on a guess would nag about an update that may not
  // exist. Say the lesser, provable thing.
  const base = (stored.promptBase ?? "").trim();
  return base && base !== ship ? "outdated" : "edited";
}

/**
 * The profile to actually spawn with: a tracked prompt is filled in from the
 * build at the moment it is used, never from a copy.
 */
export function effectiveProfile(stored: Profile | undefined | null): Profile | undefined {
  if (!stored) return undefined;
  if (stored.systemPrompt !== undefined) return stored;
  const shipped = shippedProfile(stored.name);
  return shipped?.systemPrompt ? { ...stored, systemPrompt: shipped.systemPrompt } : stored;
}

/**
 * Drop a stored prompt that merely repeats what the build ships, so the profile
 * starts tracking it. Pure; the caller persists.
 *
 * This is the migration for every instance created before tracking existed:
 * their profiles.json holds the starter prompts verbatim. Dropping them changes
 * nothing today — the resolved prompt is identical — and means every later
 * improvement reaches them. A prompt that differs is the user's and is left
 * exactly as it is.
 */
export function adoptTracking(list: Profile[]): { profiles: Profile[]; adopted: string[] } {
  const adopted: string[] = [];
  const profiles = list.map((p) => {
    const ship = shippedProfile(p.name)?.systemPrompt?.trim();
    if (!ship || p.systemPrompt === undefined) return p;
    if (p.systemPrompt.trim() !== ship) return p;
    adopted.push(p.name);
    const { systemPrompt: _drop, promptBase: _base, ...rest } = p;
    return rest as Profile;
  });
  return { profiles, adopted };
}

/** The starter profile this build ships under `name`, if any. */
export function shippedProfile(name: string): Profile | undefined {
  return DEFAULT_PROFILES.find((p) => p.name === name);
}
