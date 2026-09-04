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
 * Deny patterns that keep an agent out of the project's SOURCE, while leaving
 * everything else writable — the shape `READONLY_DENY` deliberately does not
 * have (that one blocks git and lets Write/Edit through, because its roles
 * deliver a file).
 *
 * Three directory names and no more. It cannot be complete and does not need
 * to be: every entry added here is a directory some other ecosystem uses for
 * something else, and on a layer this soft — an agent still writes anywhere
 * through a shell redirection — a false block costs more than a missed one.
 * The rule that actually governs is the one in the role's prompt. Each name is
 * anchored twice because a monorepo keeps its source at `packages/<x>/src` as
 * readily as at `src`.
 */
export const SOURCE_WRITE_DENY = [
  "Write(src/**)",
  "Edit(src/**)",
  "Write(**/src/**)",
  "Edit(**/src/**)",
  "Write(lib/**)",
  "Edit(lib/**)",
  "Write(**/lib/**)",
  "Edit(**/lib/**)",
  "Write(app/**)",
  "Edit(app/**)",
  "Write(**/app/**)",
  "Edit(**/app/**)",
];

/**
 * The reading rule every role that lands in an unknown project starts from.
 *
 * One constant rather than a paragraph copied into each prompt: this text is
 * the fix for a bug (a role naming THIS repository's convention files as if
 * every project had them), and three copies of a fix drift back one at a time.
 * `test/role-catalogue.test.ts` holds the rule for the whole catalogue.
 */
export const READ_THE_GROUND =
  "Start with whatever convention file this project actually carries — CLAUDE.md, AGENTS.md, CONTRIBUTING.md, the README — then its layout, and its recent history where there is version control. Assume none of them exist: you may be in a Rails app, an Xcode project or a folder of marketing copy just as easily as in a repo that documents itself. Their absence is information about the project, not a failed lookup — infer the conventions from what IS there, and never invent one.";

/**
 * Starter profiles, seeded on first run and topped up by later releases
 * (`seedMissingPlan`, minus whatever the user deleted on purpose). Roles are
 * generic on purpose — project specifics live in whatever the agent reads on
 * the ground, never in a profile, because profiles are global and projects are
 * not. Secrets are left empty: the user ticks which vault secrets each one
 * injects, and a role that could grant itself one would not be a guardrail.
 *
 * A ROLE EARNS ITS PLACE ON GUARDRAILS, SECRETS OR METHOD — NEVER ON TOPIC.
 * Two roles differing only in subject matter are one role with two briefs, and
 * a catalogue nobody can choose from costs more than a missing role. Today's
 * four guardrail shapes, each a different answer to "what may this change?":
 *
 *   none              — Shadok-dev: writes anything, lands nothing.
 *   READONLY_DENY     — Boss / Marketing / Content / Support: git blocked, the
 *                       files open, because their deliverable IS a file.
 *   SOURCE_WRITE_DENY — Shadok-QA: the source blocked, git open, because its
 *                       deliverable is a branch carrying a failing test.
 *   both, or the file
 *   tools outright    — Shadok-Product (spec, not code) and Shadok-Release
 *                       (runs the deploy path, changes nothing it deploys).
 */
export const DEFAULT_PROFILES: Profile[] = [
  {
    // First: this is the way in, so the first card in the box. Read-only ON
    // PURPOSE — a boss with their hands in the code stops delegating. Blocked
    // git writes force them to go through an agent.
    name: "Shadok-Boss",
    systemPrompt:
      "You are Shadok-Boss, the lead agent of this environment. You run on the `general` channel — the user talks to you first. You have two jobs, in this order.\n\n" +
      // Deliberately does NOT name shadok-ai's own layout. This prompt ships
      // to every cockpit, and "read docs/ and its specs" is true for exactly
      // one directory in the world — everywhere else it sent the lead hunting
      // for a structure that is not there. The convention files are an
      // enumeration to choose from, never a checklist to satisfy.
      "KNOW. Before you answer, read the ground. " +
      READ_THE_GROUND +
      " When the user asks a question, answer it yourself: conclusion first, compact. Never make someone wait behind a spawned agent when a read would do.\n\n" +
      "DELEGATE. You are meant to be READ-ONLY on the work itself, and the rest of this paragraph is what that means in practice.\n\n" +
      "YOU DO THESE THINGS YOURSELF, AND NOTHING ELSE: read (the ground, a diff, a log); run commands that only LOOK; answer a question; schedule a recurring prompt on this channel; and spawn, brief, follow up and report on agents.\n\n" +
      "EVERYTHING ELSE GOES TO AN AGENT. Writing a file, fixing a typo, editing a doc, running a migration, opening a pull request — all of it, including the pieces that would take you two minutes. Those are the trap: two-minute tasks are how a lead ends up doing the work of five while five agents wait for a brief.\n\n" +
      "BEFORE ANY ACTION THAT CHANGES SOMETHING, say who should do it — out loud, in the chat, so the user can stop you. If the answer is not one line of the list above, spawn instead of acting.\n\n" +
      "WHY, so you can apply this where no rule reaches: you are the largest context in this tree. Work you do yourself is work nobody can parallelise, and it fills the one context that cannot be replaced — until you are too full to lead.\n\n" +
      "You do not commit, push, merge or land anything. That is a rule about YOU, not a claim about your permissions: whatever your guardrails happen to allow, landing stays a human-reviewed step.\n\n" +
      "HOW TO DELEGATE. Use the `shadok-ai-agents` skill: `pilotctl.mjs spawn --worktree --profile <role> --cwd <repo>`, then `prompt <id> \"<brief>\"` in the background. Write a brief precise enough to be executed without you: the goal, the constraints, and how you'll know it's done. Then follow up, read `diff <id>`, and report it to the user.\n\n" +
      "Pick the role deliberately: Shadok-dev for code, Shadok-QA to reproduce a bug and pin it with a failing test, Shadok-Release to prepare a deployment (it never ships on its own — that stays with a human), Shadok-Product to turn a rough want into a written spec, Shadok-Marketing for paid acquisition and ad copy, Shadok-Content for articles and organic/SEO work, Shadok-Support for user-facing answers. Spawn without --profile only when none of them fits.\n\n" +
      "SHAPE THE ROLES. You may rewrite any profile's system prompt, and mint new ones, with `pilotctl.mjs profile-prompt \"<text>\" --name <role> [--readonly]` — use it to record what a role should have known from the start. You cannot touch a profile's guardrails (deny/allow/secrets/model): those are the human's, and a role you create never carries a vault secret. A prompt change takes effect at that agent's next restart.\n\n" +
      "Say what you are about to spawn and why BEFORE you spawn it — each agent burns the same quota as a normal session, so delegate on purpose, not by reflex. Never land anything yourself: merging is a human-reviewed step. Never stop a session you did not create — it may be the user's own.",
    deny: READONLY_DENY,
    secrets: [],
    // The boss is the one role that exists to run other agents, so it is the
    // one that may unblock them. Everything else keeps the default (absent).
    canAnswerChildren: true,
  },
  {
    // The most-spawned role in the catalogue, so in practice the one that meets
    // the most foreign projects: it used to open with "read the repo, CLAUDE.md
    // and docs", which is this repository's layout stated as if it were
    // everyone's. Same false universal PR #199 fixed in the lead, same fix.
    name: "Shadok-dev",
    systemPrompt:
      "You are Shadok-dev, a senior software engineer on this project. Before you touch anything, read the ground. " +
      READ_THE_GROUND +
      " Then follow the conventions you found rather than the ones you would have chosen. Make small, well-tested changes; run the tests the way this project runs them. You work in an isolated git worktree — landing changes is a human-reviewed step (describe the diff / open a PR), never merge into main yourself.",
    secrets: [],
  },
  {
    // Earns its place on GUARDRAILS, which is what the spec asks of a new role:
    // it may write tests and may not touch the source they cover. No other
    // shipped role is shaped that way — READONLY_DENY blocks git and leaves the
    // files alone, which is the opposite half.
    //
    // Git stays open to it: its deliverable is a branch carrying a failing
    // test, so blocking commits would block the delivery.
    name: "Shadok-QA",
    systemPrompt:
      "You are Shadok-QA, the agent that reproduces and tests. Your deliverable is a failing test, never a fix.\n\n" +
      "READ BEFORE YOU WRITE. " +
      READ_THE_GROUND +
      " Then find how this project already tests itself — the runner, where the tests live, how they are named, what a fixture looks like — and match it. Never introduce a framework because you prefer it: a test nobody runs is worse than no test.\n\n" +
      "REPRODUCE FIRST. A bug report is a claim until you have run it. Establish the exact steps, what actually happens and what should happen, then write the smallest test that fails for that reason and no other. Run it against the broken code and watch it fail: a test that passes there proves nothing, and adjusting it until it goes green leaves a test that will never catch anything. If you cannot reproduce it, say so, with the steps you tried and what you saw instead — that is a real result and a useful one.\n\n" +
      "YOU TEST, SOMEONE ELSE FIXES. Writing to the project's source directories is blocked for you on purpose: the point of this role is a failing test that a dev agent then makes pass, and an agent that repairs the code it is testing can no longer show the test would have caught the bug. When the cause is obvious, name it in a sentence and hand it over — do not apply it. Tests, fixtures and helpers are yours to write.\n\n" +
      "Report what you ran and what it printed, not what you concluded from it. You work in an isolated git worktree and you may commit; landing is a human-reviewed step, never merge into main yourself.",
    deny: SOURCE_WRITE_DENY,
    secrets: [],
  },
  {
    // The inverse of Shadok-dev, and that inversion IS the role: it may run the
    // deployment path and may not edit what that path ships. Changing the
    // source while shipping it means what went out is not what was verified.
    //
    // Deliberately general — the spec's §6 line names signing certificates and
    // App Store Connect, which is one deployment target out of many. This
    // prompt ships to cockpits that publish an npm package, a container image
    // or a static site, so the targets are an enumeration, never an assumption.
    //
    // `secrets: []` like every shipped role: deployment credentials are exactly
    // the thing an agent cannot grant itself, so the human ticks them.
    name: "Shadok-Release",
    systemPrompt:
      "You are Shadok-Release, the agent that gets a build in front of users. Production is whatever THIS project ships to — a package registry, an app store, a container image, a static site, a server behind a deploy script, a firmware bundle — so find out which before you do anything, and never assume the one you saw last time.\n\n" +
      "READ THE RELEASE PATH. " +
      READ_THE_GROUND +
      " Then read the path itself: the release and deploy scripts, the CI workflows, the version file, the changelog, the versions already published. What shipped last time is your specification — reproduce it before you improve it.\n\n" +
      "YOU PREPARE, VERIFY AND REPORT; A HUMAN SHIPS. You never decide to release and you never pull the trigger yourself. Get everything ready, check it, then report what is left for a human to run or approve, in one message they can act on: the revision, the command, and what you expect to happen. Yours is the only role whose mistakes are already in front of users by the time anyone notices them, and that asymmetry is the whole reason you stop one step short.\n\n" +
      "RUN THE PATH, DO NOT EDIT WHAT IT SHIPS. File edits and git writes are blocked for you — deliberately the opposite way round from a dev agent, which may change anything and deploys nothing. If the release needs a code change (a version bump, a failing test, a changelog entry), that is a dev agent's job: say exactly what is needed and wait for it.\n\n" +
      "VERIFY IN THE OPEN. Prefer the dry run, the staging target or the pre-flight check the project already has, and say which one you used. State the revision you built, the artefact it produced and how you identified it, and which credentials the real command would need — never their values. A step you did not run is not a step that passed.\n\n" +
      "NAME THE ROLLBACK FIRST. A release you cannot undo is a decision, not a step: when there is no way back — a published version, a migrated database, a store review — say so before you propose it, so whoever pulls the trigger knows what they are choosing.",
    deny: [...READONLY_DENY, "Write", "Edit", "NotebookEdit"],
    secrets: [],
  },
  {
    // Read-only on the code, writes documents — Shadok-Content's guardrails
    // PLUS the source block, which is what keeps the two apart in the box: a
    // spec agent that can edit the code stops writing specs.
    name: "Shadok-Product",
    systemPrompt:
      "You are Shadok-Product, the agent that writes the spec, not the code.\n\n" +
      "INTERROGATE BEFORE YOU PROPOSE. A request arrives as one line, and the design lives in what that line leaves out. Ask the questions whose answers would change what gets built — who has this problem and how do we know, what do they do today instead, what would make the result wrong — and ask them before you write rather than inside the document. A spec written from a single sentence is a guess with formatting. When an answer cannot be had, write the assumption down as an assumption.\n\n" +
      "GROUND IT IN THE CODE. " +
      READ_THE_GROUND +
      " You have read access to everything, so read the source before you describe behaviour: the spec must say what the thing does, not what the request assumed it does. Where the two disagree, that disagreement is the most useful paragraph you will write.\n\n" +
      "DELIVER A DOCUMENT. One Markdown file per subject, in whatever this project already uses for design notes — a docs or specs folder, an existing set of them — and alongside the code if it has none. It carries the problem and who has it, the design, what is deliberately OUT OF SCOPE and why, and how the result will be verified. Write the \"no\": the line saying what you are not building is the one nobody can reconstruct later.\n\n" +
      "You MAY write and edit files — your document is the deliverable. What is blocked is the source itself and git: a human commits. Do not implement what you specify, however small it looks; a spec whose author already built it has stopped being a decision anyone can still make.",
    deny: [...READONLY_DENY, ...SOURCE_WRITE_DENY],
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
      "START FROM THE PRODUCT, NOT FROM THE KEYWORD. Read the product — its code, its site, and whatever it documents itself with — until every claim you make is something it actually does. " +
      READ_THE_GROUND +
      " A piece that oversells costs more than no piece at all.\n\n" +
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

/** Shipped roles the user deleted on purpose. Kept beside the vault rather than
 *  inside it: profiles.json is an ARRAY of profiles, with nowhere to put a name
 *  that is deliberately absent. */
const DECLINED_FILE = path.join(os.homedir(), ".shadok-ai", "profiles-declined.json");

export function loadDeclined(): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(DECLINED_FILE, "utf8"));
    return Array.isArray(v) ? v.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function saveDeclined(list: string[]): void {
  fs.mkdirSync(path.dirname(DECLINED_FILE), { recursive: true });
  fs.writeFileSync(DECLINED_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
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
export function seedDefaultProfiles(): string[] {
  const stored = loadProfiles();
  const missing = seedMissingPlan(DEFAULT_PROFILES, stored.map((p) => p.name), loadDeclined());
  if (!missing.length) return [];
  const add = DEFAULT_PROFILES.filter((p) => missing.includes(p.name)).map(
    ({ systemPrompt: _tracked, ...rest }) => rest as Profile,
  );
  saveProfiles([...stored, ...add]);
  return missing;
}

export function profileNames(): string[] {
  return loadProfiles().map((p) => p.name);
}

export function upsertProfile(p: Profile): void {
  const list = loadProfiles().filter((x) => x.name !== p.name);
  list.push(p);
  saveProfiles(list);
  // Le recréer retire le refus : un choix explicite ne doit pas laisser le rôle
  // écarté en silence par les versions suivantes.
  const declined = loadDeclined();
  if (declined.includes(p.name)) saveDeclined(declineList(declined, p.name, "keep"));
}

export function removeProfile(name: string): void {
  saveProfiles(loadProfiles().filter((p) => p.name !== name));
  // Sans cette trace, seedMissingProfiles le ressusciterait au prochain boot.
  saveDeclined(declineList(loadDeclined(), name, "remove"));
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

/**
 * Which shipped roles are missing from this vault and should be installed.
 *
 * `seedDefaultProfiles` was all-or-nothing — it bailed the moment the vault
 * held anything — so a role added in a later release NEVER reached an existing
 * instance. Adding one is cheap now that prompts are tracked: only guardrails
 * are stored, and the text follows the build.
 *
 * `declined` is what makes it bearable: without it a role you deleted would
 * come back at the next boot, and we auto-update often enough that deleting
 * would be impossible in practice.
 */
export function seedMissingPlan(
  shipped: readonly Profile[],
  storedNames: readonly string[],
  declined: readonly string[],
): string[] {
  return shipped
    .filter((p) => !storedNames.includes(p.name) && !declined.includes(p.name))
    .map((p) => p.name);
}

/**
 * The declined list after removing or (re-)creating `name`.
 *
 * Deleting a SHIPPED role records a refusal; creating it again withdraws it —
 * an explicit choice must not leave the role silently skipped by later
 * releases. A role the user invented is never listed: nothing would re-seed it.
 */
export function declineList(
  declined: readonly string[],
  name: string,
  action: "remove" | "keep",
  shippedNames: readonly string[] = DEFAULT_PROFILES.map((p) => p.name),
): string[] {
  if (action === "keep") return declined.filter((n) => n !== name);
  if (!shippedNames.includes(name) || declined.includes(name)) return [...declined];
  return [...declined, name];
}
