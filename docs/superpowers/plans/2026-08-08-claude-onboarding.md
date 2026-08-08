# Claude Code Onboarding and Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a brand-new shadok-ai instance usable from the browser alone — no `docker exec`, no `.claude.json` surgery — and let a logged-out instance be repaired from the cockpit or from Telegram.

**Architecture:** Two independent halves. `src/claude-home.ts` seeds `~/.claude.json` additively so `claude` never opens on its first-run screens. `src/claude-auth.ts` drives `claude auth login --claudeai` as a **plain piped child process** — it prints the OAuth URL on stdout and reads the code from stdin, so the login touches none of the screen heuristics. A single instance-global `LoginFlow` is reached by two doors (HTTP endpoints for the web card, `/login` + `/code` for Telegram), and the WS `start` handler refuses to spawn while logged out.

**Tech Stack:** TypeScript (ESM, NodeNext — `.js` extensions in imports), Node 20+, `node:test` + `node:assert/strict` run through tsx, Express 5, `ws`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-08-08-claude-onboarding-design.md`

## Global Constraints

- **Everything written into the repo is in English** — code comments, identifiers, commit messages, PR title and body, test names, log and error strings. User-facing chat copy follows the user's language; this feature's UI copy is English like the rest of the cockpit.
- **Imports carry the `.js` extension** (NodeNext): `import { seedPlan } from "./claude-home.js"`.
- **Comments explain *why*, not what.**
- **Never restart the server on port 3789** and never `git merge` into another checkout. Verify a build side by side: `npm run build && PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js`.
- **Every new inline `<script>` in `public/index.html` MUST carry `nonce="__CSP_NONCE__"`**, and handlers go through `addEventListener` — never `onclick=` (invariant 12; `test/csp.test.ts` enforces it).
- **Every new popin MUST carry `class="overlay"`** (invariant 18).
- Run the whole suite with `npm test` before every commit.
- Never run `claude auth logout` on the development machine — it would destroy the developer's own credentials. Probes use an isolated `HOME`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/claude-home.ts` (create) | Seed `~/.claude.json` additively. Pure `seedPlan` / `parseClaudeVersion` + two thin writers (`ensureClaudeHome`, `ensureProjectTrusted`). |
| `test/claude-home.test.ts` (create) | Unit tests for the two pure functions. |
| `src/claude-auth.ts` (create) | Auth status + the login child process. Pure `parseAuthStatus` / `parseLoginUrl` / `parseLoginOutcome`, plus `authStatus()` and the single module-level login flow (`startLogin` / `submitLoginCode` / `cancelLogin`). |
| `test/claude-auth.test.ts` (create) | Unit tests for the three pure parsers, against real captured output. |
| `src/server.ts` (modify) | `ensureClaudeHome()` at boot; `ensureProjectTrusted(cwd)` in `makePilot`; the four `/auth*` endpoints; the `logged-out` refusal in `case "start"`. |
| `public/index.html` (modify) | The `#authOverlay` popin and its wiring. |
| `src/telegram.ts` (modify) | `/login` and `/code` commands, owner-gated; the deduplicated logged-out alert. |
| `README.md`, `CLAUDE.md`, `docs/architecture.md` (modify) | Docs, shipped in the same PR. |

---

### Task 1: Seed `~/.claude.json` — the pure core

**Files:**
- Create: `src/claude-home.ts`
- Create: `test/claude-home.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseClaudeVersion(stdout: string): string | null`
  - `interface ClaudeHome { hasCompletedOnboarding?: boolean; lastOnboardingVersion?: string; theme?: string; projects?: Record<string, Record<string, unknown>>; [k: string]: unknown }`
  - `seedPlan(existing: ClaudeHome, opts: { version: string; cwd?: string }): ClaudeHome | null` — the **merged** object to write, or `null` when nothing is missing.

- [ ] **Step 1: Write the failing tests**

Create `test/claude-home.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeVersion, seedPlan } from "../src/claude-home.js";

test("parseClaudeVersion pulls the semver out of the CLI banner", () => {
  assert.equal(parseClaudeVersion("2.1.226 (Claude Code)\n"), "2.1.226");
  assert.equal(parseClaudeVersion("2.1.226-beta.3 (Claude Code)"), "2.1.226-beta.3");
});

test("parseClaudeVersion returns null rather than guessing", () => {
  // A CLI that changed its banner must NOT produce a bogus version string:
  // lastOnboardingVersion is compared by Claude Code itself.
  assert.equal(parseClaudeVersion("command not found"), null);
  assert.equal(parseClaudeVersion(""), null);
});

test("a virgin file gets every global key plus the project entry", () => {
  const out = seedPlan({}, { version: "2.1.226", cwd: "/w/agent-1" });
  assert.deepEqual(out, {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
    theme: "dark",
    projects: {
      "/w/agent-1": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  });
});

test("an already-onboarded file needs no write at all", () => {
  // THE property that makes this safe on a developer's Mac: nothing to add
  // means nothing is written, so ~/.claude.json is never rewritten for nothing.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.0.0",
    theme: "light",
    projects: { "/w/agent-1": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  };
  assert.equal(seedPlan(existing, { version: "2.1.226", cwd: "/w/agent-1" }), null);
});

test("a present value is NEVER overwritten", () => {
  // The user's theme and their onboarding version are theirs. We only ever add.
  const out = seedPlan({ theme: "light", lastOnboardingVersion: "1.0.0" }, { version: "2.1.226" });
  assert.equal(out?.theme, "light");
  assert.equal(out?.lastOnboardingVersion, "1.0.0");
  assert.equal(out?.hasCompletedOnboarding, true);
});

test("other projects and unknown top-level keys survive untouched", () => {
  // ~/.claude.json carries megabytes of per-project history. Losing a key here
  // costs far more than the first-run screen this module exists to avoid.
  const existing = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.226",
    theme: "dark",
    userID: "abc",
    projects: { "/other": { lastCost: 42, hasTrustDialogAccepted: true } },
  };
  const out = seedPlan(existing, { version: "2.1.226", cwd: "/w/new" });
  assert.equal(out?.userID, "abc");
  assert.deepEqual(out?.projects?.["/other"], { lastCost: 42, hasTrustDialogAccepted: true });
  assert.deepEqual(out?.projects?.["/w/new"], {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  });
});

test("an existing project entry keeps its own keys and gains only what's missing", () => {
  const existing = { projects: { "/w/a": { lastCost: 1, hasTrustDialogAccepted: false } } };
  const out = seedPlan(existing, { version: "2.1.226", cwd: "/w/a" });
  // hasTrustDialogAccepted is PRESENT (false) → left alone, per the additive rule.
  assert.equal(out?.projects?.["/w/a"].hasTrustDialogAccepted, false);
  assert.equal(out?.projects?.["/w/a"].lastCost, 1);
  assert.equal(out?.projects?.["/w/a"].hasCompletedProjectOnboarding, true);
});

test("no cwd means globals only — no empty projects map invented", () => {
  const out = seedPlan({}, { version: "2.1.226" });
  assert.equal(out?.projects, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/claude-home.test.ts`
Expected: FAIL — `Cannot find module '../src/claude-home.js'`.

- [ ] **Step 3: Write the pure core**

Create `src/claude-home.ts` with the header comment and the two pure functions:

```ts
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
    for (const key of ["hasTrustDialogAccepted", "hasCompletedProjectOnboarding"]) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/claude-home.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite and the build**

Run: `npm test && npm run build`
Expected: everything green; `dist/claude-home.js` exists.

- [ ] **Step 6: Commit**

```bash
git add src/claude-home.ts test/claude-home.test.ts
git commit -m "feat: pure planner for seeding Claude Code's first-run state"
```

---

### Task 2: Seed `~/.claude.json` — the writers, wired in

**Files:**
- Modify: `src/claude-home.ts`
- Modify: `src/server.ts` (the `server.listen` callback near `ensureSshIdentity`, and `makePilot`)

**Interfaces:**
- Consumes: `seedPlan`, `parseClaudeVersion` from Task 1.
- Produces:
  - `ensureClaudeHome(): void` — seeds the global keys. Idempotent, swallows every error.
  - `ensureProjectTrusted(cwd: string): void` — seeds `projects[cwd]`. Idempotent, swallows every error.

- [ ] **Step 1: Append the writers to `src/claude-home.ts`**

```ts
const homeFile = (): string => path.join(os.homedir(), ".claude.json");

/** The claude CLI's version, or a conservative fallback. */
function claudeVersion(): string {
  try {
    return parseClaudeVersion(execFileSync("claude", ["--version"], { encoding: "utf8" })) ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Read the file, or null when it does not exist OR does not parse.
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
    if (existing === null) return;            // unparseable → hands off
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
```

- [ ] **Step 2: Wire the boot call in `src/server.ts`**

Add the import next to the `ensureSshIdentity` one (around line 28):

```ts
import { ensureClaudeHome, ensureProjectTrusted } from "./claude-home.js";
```

Then, immediately **before** the existing `Object.assign(process.env, ensureSshIdentity());` line (around line 2223):

```ts
// Before anything can spawn: make sure `claude` will not open on its first-run
// screens. reconcileOnBoot respawns sessions ~1s after boot, so this has to
// happen first — that race is exactly what produced the zombie agents.
ensureClaudeHome();
```

- [ ] **Step 3: Wire the per-spawn call in `makePilot` (`src/server.ts`, ~line 1077)**

As the first statement of `makePilot`, before `const profile = …`:

```ts
  // A worktree is a brand-new directory, so it carries a brand-new trust
  // dialog. Seed it before the process exists, not after it is stuck on it.
  ensureProjectTrusted(cwd);
```

- [ ] **Step 4: Verify the seeding actually works against a virgin HOME**

This is the step that proves the feature, and it is cheap. Run:

```bash
npm run build
FH=$(mktemp -d)
HOME=$FH node -e 'import("./dist/claude-home.js").then(m=>{m.ensureClaudeHome();m.ensureProjectTrusted(process.cwd())})'
cat "$FH/.claude.json"
tmux new-session -d -s seedcheck -x 100 -y 40 "env HOME=$FH TERM=xterm-256color claude"
sleep 8
tmux capture-pane -p -t seedcheck
tmux kill-session -t seedcheck
rm -rf "$FH"
```

Expected: the JSON contains `hasCompletedOnboarding`, `theme`, and the project entry; the captured screen shows the **normal prompt** (`❯ Try "refactor <filepath>"`), **not** "Let's get started. Choose the text style".

If the screen instead shows the theme picker, Claude Code's key names have changed — re-probe them before adjusting `seedPlan`, and update the spec's "What was verified" section with the new findings.

- [ ] **Step 5: Run the suite and the build**

Run: `npm test && npm run build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/claude-home.ts src/server.ts
git commit -m "feat: seed Claude Code's first-run state at boot and before every spawn"
```

---

### Task 3: Auth parsers — the pure core of the login

**Files:**
- Create: `src/claude-auth.ts`
- Create: `test/claude-auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AuthStatus { loggedIn: boolean; authMethod?: string; email?: string; subscriptionType?: string }`
  - `parseAuthStatus(stdout: string): AuthStatus`
  - `parseLoginUrl(chunk: string): string | null`
  - `parseLoginOutcome(chunk: string): "success" | "invalid-code" | null`

- [ ] **Step 1: Write the failing tests**

Create `test/claude-auth.test.ts`. The OSC 8 fixture is **real output captured on 2026-08-08 from claude v2.1.226** — do not simplify it, it is the whole reason this function exists:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthStatus, parseLoginOutcome, parseLoginUrl } from "../src/claude-auth.js";

const URL_ =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ty2I7J6bCk3fM63ENABuO5hwGCB99nk9h6UQyCpY2aM" +
  "&code_challenge_method=S256&state=WZH7Z-PNxiJxxJbjqETE-v9Z6py_h2Oci8jJSb4wW_0";

/**
 * Real shape, captured 2026-08-08: the CLI wraps the URL in an OSC 8 hyperlink
 * (`ESC ] 8 ; ; <url> BEL <visible text> ESC ] 8 ; ; BEL`), so the URL is
 * physically present TWICE. The escapes are written as \x1b / \x07 on purpose —
 * a literal control character in a source file is invisible and does not
 * survive being copied around.
 */
const OSC8 =
  "Opening browser to sign in…\n" +
  `If the browser didn't open, visit: \x1b]8;;${URL_}\x07${URL_}\x1b]8;;\x07\n` +
  "Paste code here if prompted > ";

test("parseAuthStatus reads the CLI's JSON", () => {
  const s = parseAuthStatus(
    '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","subscriptionType":"max"}',
  );
  assert.deepEqual(s, {
    loggedIn: true,
    authMethod: "claude.ai",
    email: "a@b.c",
    subscriptionType: "max",
  });
});

test("parseAuthStatus treats anything unreadable as logged OUT", () => {
  // An instance we cannot PROVE is authenticated must be treated as not
  // authenticated: the cost of a spurious card is a click, the cost of a
  // spurious spawn is a zombie agent nobody notices for a day.
  assert.equal(parseAuthStatus("").loggedIn, false);
  assert.equal(parseAuthStatus("command not found").loggedIn, false);
  assert.equal(parseAuthStatus('{"loggedIn":false}').loggedIn, false);
  assert.equal(parseAuthStatus("[1,2,3]").loggedIn, false);
});

test("parseLoginUrl survives the OSC 8 hyperlink wrapper", () => {
  // A naive /visit: (\S+)/ captures the ESC sequence and half the URL. The
  // escapes must be stripped BEFORE matching.
  assert.equal(parseLoginUrl(OSC8), URL_);
});

test("parseLoginUrl also handles a plain unwrapped line", () => {
  assert.equal(parseLoginUrl(`If the browser didn't open, visit: ${URL_}\n`), URL_);
});

test("parseLoginUrl returns null before the URL has been printed", () => {
  assert.equal(parseLoginUrl("Opening browser to sign in…\n"), null);
  assert.equal(parseLoginUrl(""), null);
});

test("parseLoginOutcome recognises the refusal the CLI actually prints", () => {
  // Only "invalid-code" is asserted, because only it was OBSERVED. Success is
  // detected by the child EXITING cleanly (see Task 4) — inventing a success
  // string would produce a login that silently never completes.
  assert.equal(
    parseLoginOutcome("Paste code here if prompted > Invalid code. Please make sure the full code was copied.\n"),
    "invalid-code",
  );
  assert.equal(parseLoginOutcome("Paste code here if prompted > "), null);
  assert.equal(parseLoginOutcome(""), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/claude-auth.test.ts`
Expected: FAIL — `Cannot find module '../src/claude-auth.js'`.

- [ ] **Step 3: Write the parsers**

Create `src/claude-auth.ts`:

```ts
/**
 * Claude Code authentication: status, and the interactive login.
 *
 * The load-bearing finding behind this module (verified 2026-08-08 against
 * claude v2.1.226): `claude auth login --claudeai` needs NO PTY. Run with plain
 * pipes it prints the OAuth URL on stdout and reads the code from stdin. So the
 * login touches none of the screen heuristics — no `detectDialog`, no
 * `screenShowsWork`, nothing from the fragile family invariant nº 2 warns
 * about. It is a spawn, a stdout parser and one write to stdin.
 *
 * See docs/superpowers/specs/2026-08-08-claude-onboarding-design.md.
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

/** Pure: `claude auth status --json`. Anything unreadable reads as logged out. */
export function parseAuthStatus(stdout: string): AuthStatus {
  try {
    const j = JSON.parse(stdout);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { loggedIn: false };
    if (j.loggedIn !== true) return { loggedIn: false };
    return {
      loggedIn: true,
      ...(typeof j.authMethod === "string" ? { authMethod: j.authMethod } : {}),
      ...(typeof j.email === "string" ? { email: j.email } : {}),
      ...(typeof j.subscriptionType === "string" ? { subscriptionType: j.subscriptionType } : {}),
    };
  } catch {
    return { loggedIn: false };
  }
}

/**
 * Strip ANSI/OSC escape sequences.
 *
 * The login output wraps the URL in an OSC 8 hyperlink
 * (`ESC ] 8 ; ; <url> BEL <url> ESC ] 8 ; ; BEL`), so the URL is physically
 * present TWICE and a naive `visit:\s*(\S+)` captures the escape plus a
 * fragment of it. Stripping first makes the match trivial.
 */
function stripEscapes(s: string): string {
  return s
    // OSC 8 open (ESC ] 8 ; ; <url> BEL) and close (ESC ] 8 ; ; BEL).
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Ordinary CSI colour/cursor sequences.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Pure: the OAuth URL the CLI printed, or null if it hasn't printed one yet. */
export function parseLoginUrl(chunk: string): string | null {
  const m = stripEscapes(chunk).match(/visit:\s*(https:\/\/\S+)/);
  return m ? m[1] : null;
}

/**
 * Pure: the refusal the CLI printed for the code we submitted, if any.
 *
 * There is deliberately no "success" case. The invalid-code wording was
 * captured from the real CLI; a success wording never was, and a parser that
 * guessed one would produce a sign-in that silently never completes. Success is
 * the child exiting cleanly — see `startLogin` in the live half.
 */
export function parseLoginOutcome(chunk: string): "invalid-code" | null {
  return /Invalid code/i.test(stripEscapes(chunk)) ? "invalid-code" : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/claude-auth.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm test && npm run build
git add src/claude-auth.ts test/claude-auth.test.ts
git commit -m "feat: pure parsers for claude auth status and the login flow"
```

---

### Task 4: `authStatus()` and `LoginFlow` — the live parts

**Files:**
- Modify: `src/claude-auth.ts`

**Interfaces:**
- Consumes: `parseAuthStatus`, `parseLoginUrl`, `parseLoginOutcome` from Task 3.
- Produces:
  - `authStatus(force?: boolean): Promise<AuthStatus>` — 30s cache; `force` bypasses it.
  - `invalidateAuthStatus(): void`
  - `startLogin(): Promise<{ url: string } | { error: string }>`
  - `submitLoginCode(code: string): Promise<{ ok: true } | { ok: false; error: string }>`
  - `cancelLogin(): void`
  - `loginPending(): boolean`

- [ ] **Step 1: Add the imports at the TOP of the file**

Imports go in the import block, not mid-file:

```ts
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
```

- [ ] **Step 2: Append the live parts to `src/claude-auth.ts`**

```ts
/** How long a status answer is reused. It is a spawn, and the card polls it. */
const STATUS_TTL_MS = 30_000;
/** The OAuth URL expires anyway; a child holding stdin open forever is worse. */
const FLOW_IDLE_MS = 10 * 60_000;

let cached: { at: number; status: AuthStatus } | null = null;

export function invalidateAuthStatus(): void {
  cached = null;
}

export async function authStatus(force = false): Promise<AuthStatus> {
  if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  const status = await new Promise<AuthStatus>((resolve) => {
    execFile("claude", ["auth", "status", "--json"], { timeout: 15_000 }, (_err, stdout) =>
      resolve(parseAuthStatus(stdout ?? "")),
    );
  });
  cached = { at: Date.now(), status };
  return status;
}

interface Flow {
  child: ChildProcessWithoutNullStreams;
  /** Everything the child has written since the last code was submitted. */
  out: string;
  /** Resolver waiting on the verdict for the code we just wrote. */
  pending: ((r: Verdict) => void) | null;
  /** The child has ended — a further code cannot be submitted to it. */
  ended: boolean;
  timer: ReturnType<typeof setTimeout>;
}

type Verdict = "success" | "invalid-code" | "ended" | "timeout";

/**
 * ONE flow at a time for the whole instance: the credentials are machine-global,
 * so a second concurrent login would race the first for the same keychain
 * entry. The upside is free — the web card and Telegram share the same URL, and
 * a code pasted from either finishes the other's flow.
 */
let flow: Flow | null = null;

export function loginPending(): boolean {
  return flow !== null && !flow.ended;
}

export function cancelLogin(): void {
  if (!flow) return;
  clearTimeout(flow.timer);
  flow.child.kill();
  flow = null;
}

export async function startLogin(): Promise<{ url: string } | { error: string }> {
  cancelLogin();
  const child = spawn("claude", ["auth", "login", "--claudeai"], {
    // BROWSER is neutralised: on a desktop host the CLI would otherwise open a
    // tab on the SERVER's machine, which is not where the user is.
    env: { ...process.env, BROWSER: "/usr/bin/true" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const f: Flow = {
    child,
    out: "",
    pending: null,
    ended: false,
    timer: setTimeout(() => cancelLogin(), FLOW_IDLE_MS),
  };
  flow = f;

  const settle = (v: Verdict) => {
    const done = f.pending;
    f.pending = null;
    done?.(v);
  };
  const onData = (d: Buffer) => {
    f.out += d.toString();
    if (parseLoginOutcome(f.out) === "invalid-code") settle("invalid-code");
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  // SUCCESS IS AN EXIT, NOT A STRING. The "Invalid code…" wording was captured
  // from the real CLI; the success wording never was, and inventing one would
  // produce a login that silently never completes. A clean exit after a code
  // was submitted is the signal we can actually prove.
  child.on("exit", (code) => {
    f.ended = true;
    settle(code === 0 ? "success" : "ended");
  });

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      cancelLogin();
      resolve({ error: "claude auth login printed no URL within 30s" });
    }, 30_000);
    const poll = setInterval(() => {
      const url = parseLoginUrl(f.out);
      if (url) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve({ url });
      } else if (flow !== f || f.ended) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve({ error: "the login process ended before printing a URL" });
      }
    }, 100);
  });
}

export async function submitLoginCode(
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const f = flow;
  if (!f || f.ended)
    return { ok: false, error: "no sign-in is in progress — start one first" };
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "empty code" };

  // The user is clearly still here: push the idle deadline back.
  clearTimeout(f.timer);
  f.timer = setTimeout(() => cancelLogin(), FLOW_IDLE_MS);
  // Forget what came before, so a stale "Invalid code" from a previous attempt
  // is never mistaken for the verdict on THIS one.
  f.out = "";

  const verdict = await new Promise<Verdict>((resolve) => {
    const t = setTimeout(() => {
      f.pending = null;
      resolve("timeout");
    }, 30_000);
    f.pending = (r) => {
      clearTimeout(t);
      resolve(r);
    };
    f.child.stdin.write(trimmed + "\n");
  });

  if (verdict === "success") {
    cancelLogin();
    invalidateAuthStatus();
    return { ok: true };
  }
  if (verdict === "invalid-code")
    return { ok: false, error: "Invalid code. Please make sure the full code was copied." };
  if (verdict === "ended")
    return { ok: false, error: "the sign-in was refused — start a new one and try again" };
  return { ok: false, error: "the CLI did not answer within 30s" };
}
```

- [ ] **Step 3: Verify by hand against an isolated HOME — and settle one unknown**

Never against the real one. This step answers a question the probes did not:
**after an invalid code, does the CLI re-prompt or exit?** The code above handles
both (`invalid-code` keeps the flow alive, `ended` tells the user to start over), but the observed behaviour belongs in the spec.

```bash
npm run build
FH=$(mktemp -d)
HOME=$FH node -e '
  import("./dist/claude-auth.js").then(async (m) => {
    console.log("status:", await m.authStatus(true));
    console.log("startLogin:", await m.startLogin());
    console.log("bad code 1:", await m.submitLoginCode("bogus-12345"));
    console.log("bad code 2:", await m.submitLoginCode("bogus-67890"));
    console.log("still pending?", m.loginPending());
    m.cancelLogin();
  });
'
rm -rf "$FH"
```

Expected: `startLogin` returns a `https://claude.com/cai/oauth/authorize?…` URL, and the
first bad code returns `{ok:false, error:"Invalid code. …"}`. Record what the SECOND
one does in the spec's "What was verified" section — either wording is handled,
but a future reader should not have to rediscover which one happens.

Do **not** complete a real login here: it would write credentials for the
throwaway HOME.

- [ ] **Step 4: Run the suite and the build**

Run: `npm test && npm run build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/claude-auth.ts
git commit -m "feat: drive claude auth login as a piped child process"
```

---

### Task 5: HTTP endpoints and the logged-out refusal

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `authStatus`, `startLogin`, `submitLoginCode`, `cancelLogin` from Task 4.
- Produces:
  - `GET /auth` → `{loggedIn, email?, subscriptionType?}`
  - `POST /auth/login` → `{url}` or `{error}` (502)
  - `POST /auth/code` `{code}` → `{ok:true}` or `{ok:false, error}` (400)
  - `DELETE /auth/login` → `{ok:true}`
  - WS `error` with `code: "logged-out"` on a refused `start`.

- [ ] **Step 1: Add the import**

Next to the other local imports in `src/server.ts`:

```ts
import { authStatus, cancelLogin, startLogin, submitLoginCode } from "./claude-auth.js";
```

- [ ] **Step 2: Add the endpoints**

Place them next to `app.get("/version", …)` (~line 631), inside the password-gated area like every other route:

```ts
// Instance-global auth state — NOT per session, hence HTTP rather than WS.
app.get("/auth", async (_req, res) => res.json(await authStatus()));

app.post("/auth/login", async (_req, res) => {
  const r = await startLogin();
  if ("error" in r) return res.status(502).json(r);
  res.json(r);
});

app.post("/auth/code", async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const r = await submitLoginCode(code);
  res.status(r.ok ? 200 : 400).json(r);
});

app.delete("/auth/login", (_req, res) => {
  cancelLogin();
  res.json({ ok: true });
});
```

- [ ] **Step 3: Refuse to spawn while logged out**

In `case "start"` (~line 1778), immediately after `if (session) return fail("session already started");`:

```ts
          // Refusing here is what actually prevents zombies. The historical
          // failure was never "the login was missing" — it was "an agent was
          // allowed to start without one", and then sat on the first-run screen
          // for a day. `code` lets a machine client classify the refusal
          // without matching on message text (same contract as "busy").
          if (!(await authStatus()).loggedIn)
            return fail(
              "this shadok-ai instance is not logged in to Claude — open the cockpit and sign in",
              "logged-out",
            );
```

Note: `case "start"` must already be inside an `async` message handler for the `await` to compile. If it is not, make the handler `async` — check with `npm run build` at the next step and adjust.

- [ ] **Step 4: Build and verify side by side**

```bash
npm run build
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js &
sleep 3
curl -s localhost:3899/auth
curl -s -o /dev/null -w 'prod still up: %{http_code}\n' localhost:3789/
```

Expected: `/auth` answers `{"loggedIn":true,…}` on the developer's machine (which *is* logged in), and 3789 still answers `200`. Confirm the startup output has **no `telegram:` line** — an instance launched from a worktree must not steal the bot. Stop your instance when done.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/server.ts
git commit -m "feat: /auth endpoints and refuse to spawn a logged-out instance"
```

---

### Task 6: The login card in the cockpit

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: the four endpoints from Task 5, and the WS `error` with `code === "logged-out"`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the markup**

After the `#telegramOverlay` block (~line 1414), before `<main>`:

```html
<div id="authOverlay" class="overlay" hidden>
  <div id="authPanel" class="sec-panel">
    <div class="sec-head">
      <strong>Sign in to Claude</strong>
    </div>
    <p class="sec-note">This instance is not signed in, so it cannot start any agent.</p>
    <div class="field">
      <span class="label">1 — Open this link and authorise</span>
      <a id="authLink" href="#" target="_blank" rel="noopener">…</a>
    </div>
    <div class="field">
      <span class="label">2 — Paste the code you get back</span>
      <form id="authCodeForm" style="display:flex;gap:8px">
        <input id="authCode" placeholder="paste the code…" autocomplete="off" spellcheck="false" style="flex:1">
        <button type="submit">Sign in</button>
      </form>
    </div>
    <p class="sec-note" id="authError" hidden></p>
  </div>
</div>
```

The panel has **no close button on purpose**: while the instance is logged out nothing works, so dismissing it would only hide the reason.

- [ ] **Step 2: Wire it, in the existing classic `<script>` block**

Next to the other `addEventListener` wirings (~line 4603). No `onclick=` anywhere — invariant 12.

```js
  // The card exists only while something is missing. No entry point opens it
  // when the instance is healthy: there is nothing for it to say.
  async function checkAuth() {
    try {
      const s = await api("/auth");
      if (s && s.loggedIn) { $("authOverlay").hidden = true; return true; }
      await openAuthCard();
      return false;
    } catch { return true; }   // a failed check must not block a working cockpit
  }

  async function openAuthCard() {
    $("authOverlay").hidden = false;
    $("authError").hidden = true;
    const link = $("authLink");
    link.textContent = "starting…";
    link.removeAttribute("href");
    try {
      const r = await api("/auth/login", { method: "POST" });
      if (r && r.url) { link.href = r.url; link.textContent = r.url; }
      else { link.textContent = (r && r.error) || "could not start the login"; }
    } catch (e) {
      link.textContent = "could not start the login";
    }
  }

  $("authCodeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("authCode").value.trim();
    if (!code) return;
    const err = $("authError");
    err.hidden = true;
    const r = await api("/auth/code", { method: "POST", body: JSON.stringify({ code }) });
    if (r && r.ok) {
      $("authCode").value = "";
      const s = await api("/auth");
      $("authOverlay").hidden = true;
      if (s && s.email) toast("Signed in as " + s.email);
    } else {
      err.textContent = (r && r.error) || "the code was refused";
      err.hidden = false;
    }
  });
```

Adapt `api(...)` and `toast(...)` to whatever the file already uses for fetch-with-auth and transient messages — read the neighbouring code and follow it rather than introducing a second convention.

- [ ] **Step 3: Call it on load and on a refused start**

In the `DOMContentLoaded` handler (invariant 10 — the page must not paint before the ESM bridge is ready), add `checkAuth();`.

In the WS `error` branch of the client, next to where `code === "busy"` is handled:

```js
      if (m.code === "logged-out") { openAuthCard(); return; }
```

- [ ] **Step 4: Verify in a real browser**

`test/csp.test.ts` and `npm run build` cannot see this failing — only the browser can. Run your build side by side and look at the page **and the console**:

```bash
npm run build
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js
```

With no interactive browser available, borrow Playwright from `~/projects/aibrowser` (`node_modules/playwright`, required by **absolute path** — do not install it into the worktree), screenshot `localhost:3899`, and **read the screenshots back**. Capture the console too: a CSP violation or a failed import is silent in the DOM (invariants 10 and 12).

Expected on a logged-in machine: no card, no console error. To see the card, temporarily make `checkAuth` treat the instance as logged out (flip the condition, reload, revert) rather than logging out for real.

- [ ] **Step 5: Commit**

```bash
npm test
git add public/index.html
git commit -m "feat: login card in the cockpit for a logged-out instance"
```

---

### Task 7: Telegram — `/login`, `/code`, and the one-shot alert

**Files:**
- Modify: `src/telegram.ts`

**Interfaces:**
- Consumes: `startLogin`, `submitLoginCode`, `authStatus` from Task 4.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the import**

```ts
import { authStatus, startLogin, submitLoginCode } from "./claude-auth.js";
```

- [ ] **Step 2: Add the two commands to the dispatcher**

In `handleMessage`'s `switch (cmd.cmd)` (`src/telegram.ts`, ~line 942), next to `case "secret"`:

```ts
        case "login": {
          // An OAuth code grants access to the account, so this lives behind
          // the same gate as /secret: the bound board group, or an owner DM.
          // guardDm has already run for private chats, and a group that is not
          // the bound board was rejected above — so reaching here is the gate.
          const r = await startLogin();
          if ("error" in r) {
            await reply(chat.id, threadId, `⚠️ Could not start the login: ${r.error}`);
            return;
          }
          await reply(
            chat.id,
            threadId,
            `🔐 Open this link, authorise, then send me the code with <code>/code &lt;the-code&gt;</code>:\n\n${r.url}`,
          );
          return;
        }
        case "code": {
          const r = await submitLoginCode(cmd.arg);
          if (r.ok) {
            const s = await authStatus(true);
            // Delete the message: an OAuth code has no business lingering in
            // the chat history, same reasoning as /secret.
            await tg("deleteMessage", { chat_id: chat.id, message_id: msg.message_id });
            await reply(chat.id, threadId, `✅ Signed in${s.email ? ` as ${s.email}` : ""}.`);
          } else {
            await reply(chat.id, threadId, `⚠️ ${r.error}`);
          }
          return;
        }
```

- [ ] **Step 3: Extend the `/help` text**

In `case "start": case "help":`, append to the existing string:

```
/login — sign this instance in to Claude · /code <code> — finish the sign-in
```

- [ ] **Step 4: Add the deduplicated alert**

Near the top of `src/telegram.ts`, next to the other module-level state:

```ts
/**
 * Have we already told the user this instance is logged out?
 *
 * Deduplicated until the state flips back: a cron on a 5-minute slot would
 * otherwise turn one logout into a flood, and a channel that cries wolf gets
 * muted long before the day it is right.
 */
let loggedOutAnnounced = false;
```

And the announcer, exported so `server.ts` can call it from the refusal path:

```ts
/** Tell the board group (once) that the instance needs signing in again. */
export async function announceLoggedOut(): Promise<void> {
  if (loggedOutAnnounced) return;
  const group = loadTgGroup();
  if (group === null) return;
  loggedOutAnnounced = true;
  await reply(
    group,
    undefined,
    "🔐 This shadok-ai instance is signed out of Claude — agents cannot start.\nSend /login here to fix it.",
  );
}

/** Called when a login succeeds, so the next logout is announced again. */
export function resetLoggedOutNotice(): void {
  loggedOutAnnounced = false;
}
```

`reply` and `loadTgGroup` are module-local; if `announceLoggedOut` sits outside the closure that owns `reply`, hoist it to where `reply` is reachable rather than duplicating the send logic.

- [ ] **Step 5: Call the announcer from the refusal path**

In `src/server.ts`, in the `logged-out` refusal added in Task 5, before returning:

```ts
            void announceLoggedOut();
```

and in `POST /auth/code`, on success:

```ts
  if (r.ok) resetLoggedOutNotice();
```

Import both from `./telegram.js`.

- [ ] **Step 6: Run the suite and the build**

Run: `npm test && npm run build`
Expected: green. `test/telegram.test.ts` already covers `parseCommand`; `/login` and `/code` match its existing `^\/([a-z]+)` shape, so no parser change is needed — confirm by reading the test rather than assuming.

- [ ] **Step 7: Commit**

```bash
git add src/telegram.ts src/server.ts
git commit -m "feat: sign in from Telegram with /login and /code, announced once"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/architecture.md`

Docs ship with the change that makes them wrong — same PR, not a catch-up pass.

- [ ] **Step 1: `README.md`**

Add a section covering: the login card, the `/login` and `/code` Telegram commands, and the four `/auth` endpoints in the endpoint list. Then **rewrite the container-recreate guidance**: the `docker create` → `docker cp .claude.json` → `docker start` ordering is no longer necessary, because shadok seeds the file itself before any session spawns.

- [ ] **Step 2: `CLAUDE.md`**

Add two rows to the architecture map:

```
| `src/claude-home.ts` | Seeds Claude Code's first-run state in `~/.claude.json` — globals at boot, `projects[<cwd>]` before every spawn (a worktree is a new directory, so a new trust dialog). PURELY ADDITIVE: a key already present is never overwritten, which is why it needs no Docker gate (contrast `src/ssh.ts`, invariant 21). Atomic write; an unparseable file is left alone. |
| `src/claude-auth.ts` | Auth status and the interactive login. `claude auth login --claudeai` needs no PTY: piped, it prints the OAuth URL on stdout and reads the code from stdin — so the login touches NONE of the screen heuristics. One instance-global `LoginFlow`, two doors (the web card, Telegram `/login`+`/code`). |
```

Then amend invariant 25's paragraph about `/root/.claude.json`: record that the seeding removes the race it describes, while keeping the paragraph's history — the symptom it names (`describeStuckScreen`) is still what a *future* onboarding change would surface.

- [ ] **Step 3: `docs/architecture.md`**

Add the onboarding subsystem, citing **symbols** (`ensureClaudeHome`, `startLogin`) rather than line numbers, and record the two decisions worth a reader's time: why the login is a piped child process rather than a piloted screen, and why there is no instance-status panel.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/architecture.md
git commit -m "docs: onboarding and login — architecture map, README, container recreate"
```

---

### Task 9: End-to-end on a clean vps1 container

**Files:** none — this is the acceptance gate.

The published image auto-updates from npm and is pinned, so the container must run **this branch**. Never touch the four production containers (3789–3792).

- [ ] **Step 1: Ship the build**

```bash
npm run build
rsync -a --delete dist/ public/ context/ ubuntu@vps1.alfredclaw.com:/tmp/shadok-onboarding/
```

(Adjust the layout so `dist/`, `public/` and `context/` land where the container expects them; read the production `docker run` recorded in the *claudepilot* project memory, file `vps-shadok-ai-container.md`, before inventing one.)

- [ ] **Step 2: Start a clean container**

Fresh volumes, a free port, and the three settings that make it safe:

```bash
ssh ubuntu@vps1.alfredclaw.com \
  'docker run -d --name shadok-onboarding-test -p 3793:3793 \
     -e PORT=3793 -e SHADOK_HOST=0.0.0.0 -e SHADOK_VERSION_CHECK_MIN=0 \
     -v shadok-onboarding-data:/root/.shadok-ai \
     -v /tmp/shadok-onboarding/dist:/app/dist \
     shadok-ai:latest'
```

`SHADOK_HOST=0.0.0.0` is the only value that works in Docker. `SHADOK_VERSION_CHECK_MIN=0` is not optional: without it the version poll installs the published release and exits, and the build under test vanishes without a word.

- [ ] **Step 3: The onboarding path**

1. Open `http://vps1.alfredclaw.com:3793` → **the card appears unprompted**.
2. Follow the link, authorise, paste the code → the card closes and names the account.
3. Create an agent → **it reaches a prompt**, not the first-run screen.
4. Confirm: **no `docker cp` of `.claude.json` anywhere in the sequence.** Step 4 is the point of the whole feature.

- [ ] **Step 4: The mid-life path — the one that will actually be used repeatedly**

1. Bind a Telegram bot to the test container.
2. `docker exec shadok-onboarding-test claude auth logout`.
3. Attempt a spawn → refused, and **exactly one** message lands in the board group.
4. Attempt a second spawn → **no second message** (the dedup holds).
5. `/login` → the link. `/code <code>` → signed in, and the code message is deleted from the chat.
6. An open web card closes on its own within the 30s status cache.

- [ ] **Step 5: Tear down and record**

```bash
ssh ubuntu@vps1.alfredclaw.com \
  'docker rm -f shadok-onboarding-test && docker volume rm shadok-onboarding-data'
```

Then confirm the four production containers still answer, and note anything surprising in the spec's "What was verified" section — a future reader needs the observed behaviour, not the intended one.

- [ ] **Step 6: Open the PR**

```bash
npm test && npm run build
gh pr create --title "Claude Code onboarding: seeded first-run state and interactive login" --body "…"
```

The PR body must state, in English, what was verified end to end on the clean container and what was not. PRs are authored by **shadok-ai-dev**, not a personal account — check `git config user.name` before creating it.

---

## Self-Review

**Spec coverage:** Part 1 (seeding) → Tasks 1–2. Part 2 (`claude-auth.ts`) → Tasks 3–4. Part 3 (protocol + blocking) → Task 5. Part 4 (the card) → Task 6. Part 5 (Telegram) → Task 7. The spec's "Documentation shipped with the change" → Task 8. The spec's Testing section → the unit tests inside Tasks 1/3 and the whole of Task 9.

**Types:** `seedPlan` / `parseClaudeVersion` / `ClaudeHome` (Task 1) are used unchanged in Task 2. `parseAuthStatus` / `parseLoginUrl` / `parseLoginOutcome` / `AuthStatus` (Task 3) are used unchanged in Task 4. `authStatus` / `startLogin` / `submitLoginCode` / `cancelLogin` (Task 4) are used unchanged in Tasks 5 and 7. `announceLoggedOut` / `resetLoggedOutNotice` (Task 7) are called from `server.ts` in that same task, so no forward reference dangles.

**One thing the plan deliberately does NOT assume:** the CLI's *success* wording.
The "Invalid code…" string was captured from the real binary; a success string
never was. So success is detected by the child **exiting cleanly**, not by a
guessed phrase — a parser that invented one would produce a sign-in that
silently never completes, which is the worst possible failure for this feature.
Task 4 Step 3 also asks the implementer to record what the CLI does after a
*second* bad code (re-prompt or exit); both branches are already handled, but the
observed answer belongs in the spec.

**Known soft spot:** Task 7 Step 4 assumes `reply` and `loadTgGroup` are reachable from module scope in `src/telegram.ts`. `reply` is defined inside the bridge closure in the current code, so the implementer may have to hoist the announcer or pass a sender in. The step says so rather than pretending otherwise — resolve it by reading the file, and do not duplicate the send logic.
