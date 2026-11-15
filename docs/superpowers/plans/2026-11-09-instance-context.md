# Instance Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One short, per-instance "instance context" that every agent receives at spawn, written once by the lead agent at first run (after a few questions, language deduced) and editable by a human in the cockpit.

**Architecture:** Pure core in `src/instance-context.ts` (normalise, once-only verdict, prompt section); storage per launch dir in `config.json`; injected as one more `--append-system-prompt` right after the profile's; shown in the pre-prompt panel but excluded from the staleness fingerprint. Human writes via a browser-only route; the lead writes once via a session-key route used by a new seeded skill. The greeting brief asks the questions when the context is empty.

**Tech Stack:** TypeScript (NodeNext ESM), Express, vanilla JS in `public/index.html`, node:test (`npm test`), Playwright at `/root/tools/node_modules/playwright`.

**Spec:** `docs/superpowers/specs/2026-11-09-instance-context-design.md`

## Global Constraints

- All repo text in English; the agent still talks to people in their language.
- Context cap: 2,000 characters after trim; above → refused with a message, never truncated. Whitespace-only = empty.
- Empty context → no `--append-system-prompt` and no pre-prompt section (never an empty heading).
- Human write: browser-origin only + admin when accounts are enabled (`accountAdmin(req, res, true, …)`, same as `PUT /title`).
- Lead write: `x-shadok-session-key` (via `localSessionForKey`), caller's channel must satisfy `isHomeChannel`, stored context must be empty — else refused with a plain reason.
- The context never enters `prepromptFingerprint` (no mass "stale").
- Invariants 10/12 (ESM bridge + nonce), 26 (agents never write what every agent is told, beyond the once-only path), 28 (16px touch fields), 36 (prompt text rides the launcher script, never argv of tmux — already true for `--append-system-prompt`).
- Verify builds on a free port only (`PORT=39xx SHADOK_VERSION_CHECK_MIN=0 SHADOK_SEED_SKILLS=0 node dist/server.js`), never 3789.

## Review Focus

1. A context containing quotes, backticks, `$`, newlines and Markdown reaches the agent byte-for-byte (the launcher script path) — Task 2 test on the args builder.
2. Context exactly 2,000 chars accepted, 2,001 refused; whitespace-only stored as empty and re-arms the once-only write — Task 1.
3. A non-home agent, a group lead, or the lead once the context is set → refused, nothing written — Task 1 verdict tests + Task 3 source scan.
4. Saving the context does not change any running agent's staleness — Task 2 fingerprint test.
5. The person ignores the first-run questions → the cockpit works, the context stays empty, the offer still made — Task 5 brief test.

---

### Task 1: Pure core + storage

**Files:** Create `src/instance-context.ts`, `test/instance-context.test.ts`; Modify `src/config.ts` (beside `titleForCwd`).

**Interfaces — Produces:**
```ts
export const INSTANCE_CONTEXT_MAX = 2000;
export const INSTANCE_CONTEXT_LABEL = "Instance context";
export function normalizeInstanceContext(raw: unknown): { ok: true; text: string } | { ok: false; error: string }; // trim; "" allowed; > MAX refused
export function firstWriteVerdict(input: { isHome: boolean; current: string }): string | null; // null = allowed; else reason
export function instanceContextSection(text: string): string | null; // null when empty; else "## This instance\n\n" + text
// config.ts
export function instanceContextForCwd(cfg: Config, cwd: string): string; // "" when unset
export function setInstanceContextForCwd(cfg: Config, cwd: string, text: string): void; // "" deletes the key; saves
```
- [ ] Step 1: tests — `accepts exactly 2000 chars`, `refuses 2001 with a message not containing the text`, `whitespace-only normalises to ""`, `non-string → ok "" only for undefined/null, error for numbers/objects`, `firstWriteVerdict: home+empty → null; non-home → reason; home+non-empty → reason`, `section is null for "" and starts with "## This instance" otherwise`, `config round-trip per cwd, two cwds independent, "" removes`.
- [ ] Step 2: `npm test -- test/instance-context.test.ts` → FAIL (module missing).
- [ ] Step 3: implement. Step 4: green. Step 5: commit `instance context: pure core and per-dir storage`.

### Task 2: Injection + pre-prompt panel, outside the staleness fingerprint

**Files:** Modify `src/server.ts` (`makePilot` args, `buildPreprompt`), `src/preprompt.ts` (`PrepromptInput.instanceContext?: string`, part label `INSTANCE_CONTEXT_LABEL`, source `"Instance context (cockpit menu)"`, `prepromptFingerprint` skips that label); Test `test/preprompt.test.ts` (or the existing preprompt test file), `test/instance-context.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:** `instanceContextArgs(text: string): string[]` in `src/instance-context.ts` → `[]` or `["--append-system-prompt", section]`.
- [ ] Step 1: tests — `instanceContextArgs("") → []`; `a hostile context (quotes, $, backticks, newline, Markdown) survives byte-for-byte in the arg`; `prepromptParts includes the Instance context part when set, placed right after Role`; `prepromptFingerprint is identical with and without the instance context part`.
- [ ] Step 2: run → FAIL. Step 3: implement; in `makePilot` insert `...instanceContextArgs(instanceContextForCwd(loadConfig(), process.cwd()))` right after `...profileArgs(...)`; `buildPreprompt` passes `instanceContext`. Step 4: `npm run build && npm test` green.
- [ ] Step 5 (live, once): run the build on a free port with a temp context, spawn one agent, ask it to quote its "This instance" section — confirms Claude Code keeps every `--append-system-prompt` value. Record the result in the ledger.
- [ ] Step 6: commit `instance context: every agent receives it at spawn`.

### Task 3: Routes

**Files:** Modify `src/server.ts`; Test `test/instance-context-routes.test.ts` (source scan, like `test/mt-token-ui.test.ts`).

**Interfaces — Consumes:** Task 1. **Produces:**
- `GET /instance-context` → `{ text: string, max: 2000 }` (any authenticated caller).
- `PUT /instance-context {text}` → `accountAdmin(req,res,true,"edit the instance context")`; normalise; store; `{ text }`. 400 with the normaliser's error.
- `PUT /instance-context/first {text}` → key from header `x-shadok-session-key` → `localSessionForKey`; 403 without; channel lookup → `isHomeChannel`; `firstWriteVerdict`; 409 with the reason when refused; else store, `{ ok: true }`.
- `POST /instance-context/draft` → `accountAdmin(…true…)`; finds the home channel; 409 if none or context non-empty; delivers a hidden `markAgentPrompt` via `driveChannel` (same as `greetHomeAgent`) carrying `instanceContextInterviewBrief()` (Task 5).
- [ ] Step 1: scan tests — the PUT uses `accountAdmin(` with `true`; `/first` reads `x-shadok-session-key` and calls `isHomeChannel(` and `firstWriteVerdict(`; no route echoes a session key. Step 2: FAIL. Step 3: implement. Step 4: green.
- [ ] Step 5: on a free port, curl: PUT without Origin → 403; with Origin → stored; `/first` with a bogus key → 403. Step 6: commit `instance context: human and once-only lead routes`.

### Task 4: The `shadok-instance-context` skill

**Files:** Create `context/instance-context-skill/SKILL.md`, `context/instance-context-skill/scripts/write.mjs`; Modify `src/server.ts` (`SKILL_SOURCES` += `["instance-context-skill","shadok-instance-context"]`; seed into the server HOME like `seedFilesSkill`); Test `test/instance-context-skill.test.ts`.

- `write.mjs --stdin` only (no argv text), PUTs `/instance-context/first` with `SHADOK_PORT` + `SHADOK_SESSION_KEY` exactly like `files-skill/scripts/send.mjs`; prints the server's refusal reason verbatim.
- SKILL.md rules (locked by the test): write it ONCE, only when asked during first run or by the "draft" prompt; keep it to a handful of lines (purpose, people, conversation language, deliverables language if different, tone/constraints); afterwards never rewrite — suggest the change in chat and point to the cockpit menu.
- [ ] Step 1: tests — SKILL.md contains "once", "suggest", "language"; the script is RUN against a fake HTTP server and sends the header + stdin body; `test/system-skills.test.ts` stays green. Step 2: FAIL. Step 3: implement. Step 4: green. Step 5: commit `instance context: the lead's once-only write skill`.

### Task 5: First-run greeting asks, then writes

**Files:** Modify `src/greeting.ts` (`GreetingBriefInput.instanceContextEmpty: boolean`; new `instanceContextInterviewBrief(): string`), `src/server.ts` (`greetHomeAgent` passes it); Test the existing greeting test file.

Brief when empty (exact intent, copy may be polished): after the one-line intro, ask two or three short questions in ONE message about what this instance is for and who will use it; deduce the language from the answer and ask only if unclear; note deliverables' language if it differs; when they answer, write the context with the `shadok-instance-context` skill, show it back in a few lines, say it can be edited from the cockpit menu; then make the single offer. If they ignore the questions, carry on — nothing waits on them.
- [ ] Step 1: tests — `empty context brief names the skill and "language"`; `filled context brief is unchanged from today` (snapshot of the existing parts); `the brief still says nothing blocks on the answer`. Step 2: FAIL. Step 3: implement; `instanceContextInterviewBrief` reuses the same questions paragraph (used by `/instance-context/draft`). Step 4: green. Step 5: commit `instance context: the lead asks at first run`.

### Task 6: Cockpit editor

**Files:** Modify `public/index.html` (version-menu entry "Instance context…" → popin `#icOverlay` with `.overlay`, textarea, char counter `n / 2000`, Save, "Ask general to draft it" shown only when empty, note "Running agents see it at their next reload" + a button reusing the existing restart-all); Test `test/instance-context-ui.test.ts` (scan: entry wired with `addEventListener`, no inline handler, nonce rules, `fetch("/instance-context"`, PUT, draft POST).

- [ ] Step 1: scan tests. Step 2: FAIL. Step 3: implement (textarea is covered by the `(pointer: coarse)` 16px rule; assert it in the test). Step 4: `npm run build && npm test` green.
- [ ] Step 5: Playwright on a free port, desktop + iPhone 13: open the menu entry, type, save, reload, text persists; counter; no console errors; screenshots read back. Step 6: commit `instance context: editor in the cockpit`.

### Task 7: Docs + end-to-end on test.shadok.ai

**Files:** `README.md` (feature), `docs/architecture.md` (prompt assembly section), `CLAUDE.md` (map rows `src/instance-context.ts`, `context/instance-context-skill/`).
- [ ] Step 1: docs. Step 2: reset test.shadok.ai with this build (same recipe as the onboarding PR: recreate container, install the two missing `@simplewebauthn` deps), ask the operator to connect Claude and answer the lead's questions; verify the stored context, that a newly spawned agent quotes it, and that `/first` is refused afterwards. Step 3: `npm test` green; commit; push; open PR (author `shadok-ai-dev`), report the link.
