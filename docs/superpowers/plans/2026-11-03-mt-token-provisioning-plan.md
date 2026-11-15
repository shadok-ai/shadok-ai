# In-cockpit subscription-token provisioning — Implementation Plan

> **For agentic workers:** execute task-by-task with TDD. Steps use checkbox syntax.

**Goal:** Let an admin obtain and rotate `MT_CLAUDE_OAUTH_TOKEN` from the cockpit
(web + Telegram), driving `claude setup-token` server-side, the token never
displayed/logged/returned.

**Architecture:** New `src/setup-token.ts` (twin of `src/claude-auth.ts`, but on a
`node-pty` because setup-token is `isatty`-gated). Pure parsers + a single-flow
state machine with an injected vault-store callback. Two endpoints + a web card +
two Telegram commands, all mirroring the existing sign-in flow.

**Tech Stack:** TypeScript/ESM/Node 20, `node-pty`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-03-mt-token-provisioning-design.md`

## Global Constraints
- Everything into the repo in English; chat/Telegram copy follows the user.
- **Never** print/log/return the minted token. Generic error text only.
- Admin + browser-origin for web endpoints; DM-owner for Telegram.
- One flow per instance (shared web+Telegram), mirror `claude-auth.ts`.
- No self-merge; branch `mt-token-provisioning` → PR off `main`.
- Store via `setSecret(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID, "operator:setup-token")`.

## Review Focus
- A failed/cancelled flow never surfaces the capture buffer (may hold a partial token) → generic text. (Task 2)
- A rotation bumps `updatedAt` so the ~1yr window restarts. (Task 1/2: `setSecret` already sets updatedAt=now)
- `filterReserved` keeps the token out of the listing after storage. (Task 3 assert)
- Non-admin / non-browser callers refused at the endpoint, not only hidden in UI. (Task 3)
- Cursor escapes between token characters must not truncate `parseSetupToken`. (Task 1)

---

### Task 1: Pure parsers (`src/setup-token.ts` parse core) + tests

**Files:** Create `src/setup-token.ts` (parsers only this task); Test `test/setup-token.test.ts`.

**Interfaces — Produces:**
- `stripTokenEscapes(s: string): string` — strip OSC-8 (`ESC]8;…;<url>(BEL|ST)`) and CSI (`ESC[…X`) sequences (same family as `claude-auth.ts` `stripEscapes`).
- `parseSetupTokenUrl(chunk: string): string | null` — the `https://…` from the OSC-8 hyperlink target (the URL is the link target, not "visit:" prose).
- `parseSetupTokenOutcome(chunk: string): "invalid-code" | null`.
- `parseSetupToken(chunk: string): string | null` — the `sk-ant-oat01-…` token; tolerate interleaved CSI escapes by stripping first; never match the URL or a prompt line.

- [ ] **Step 1: Failing tests** in `test/setup-token.test.ts` using the REAL measured PTY banner fixture (OSC-8 URL on `claude.com`, "Paste code here if prompted >") and a synthetic token `sk-ant-oat01-AAA…`:
  - URL extracted from the OSC-8 target; returns null before the link appears.
  - token parsed from a clean line AND from a line carrying `^[[2G`-style escapes; null when only the URL/prompt is present (no false token).
  - invalid-code wording detected.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement the four pure functions.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(setup-token): pure parsers for the setup-token PTY stream`.

### Task 2: The PTY flow + vault store (`src/setup-token.ts` state machine)

**Files:** Modify `src/setup-token.ts`.

**Interfaces — Consumes:** Task 1 parsers; `node-pty`; `setSecret` is injected, not imported (keeps the module server-free and testable).
**Produces:**
- `startSetupToken(): Promise<{ url } | { error }>` — `pty.spawn(claudeCommand(), ["setup-token"], {env:{...,BROWSER:"/usr/bin/true"}})`; accumulate `onData`; poll for URL; 30s deadline; `FLOW_IDLE_MS` idle kill; reuse a live flow that already printed its URL (like `startLogin`).
- `submitSetupTokenCode(code, store: (t:string)=>void): Promise<{ok:true}|{ok:false;error}>` — write `code+"\r"` to the pty; success = `parseSetupToken` finds a token AND the child exits/settles; call `store(token)`; wipe buffer; never return the token. Invalid-code and timeout mirror `submitLoginCode`.
- `setupTokenPending(): boolean`, `cancelSetupToken(): void`.

- [ ] **Step 1:** Mirror `claude-auth.ts`'s `Flow`/`settle`/idle-timer structure on a pty. The state machine is thin; the parsers (tested) carry the logic.
- [ ] **Step 2:** `store` default in the server wiring = `(t) => setSecret(MT_CLAUDE_OAUTH_TOKEN_NAME, t, MAIN_GROUP_ID, "operator:setup-token")`.
- [ ] **Step 3:** Build; manual confidence via the already-measured PTY behaviour (full mint needs the operator's browser — exercised at the end-to-end gate, Task 6/verify).
- [ ] **Step 4: Commit** `feat(setup-token): PTY-driven obtain/rotate flow, token stored server-side`.

### Task 3: Server endpoints

**Files:** Modify `src/server.ts`; Test `test/mt-token-endpoints.test.ts` (source-scan, server.ts un-importable — mirror `migrate-groups.test.ts` pattern).

- `POST /mt-token/start` — admin + `browserOrigin`; mono-tenant → `{error:"not applicable"}`; else `startSetupToken()` → `{url}` / `{error}`.
- `POST /mt-token/code` — admin + `browserOrigin`; `{code}` → `submitSetupTokenCode(code, store)` → `{ok}` / `{ok:false,error}`; on success `invalidateAuthStatus()` and anything `mtCredentialMessage` caches so the banner clears. Never return the token.

- [ ] **Step 1:** Failing source-scan test: both routes present, gated by admin + browser-origin, `/mt-token/code` never echoes a token, mono-tenant guard present.
- [ ] **Step 2:** Wire the endpoints near `/auth/login`.
- [ ] **Step 3:** Assert `visibleSecrets`/`filterReserved` still hide the name post-store (unit, in secrets.test or here).
- [ ] **Step 4: Run, pass. Commit** `feat(server): /mt-token/start + /mt-token/code (admin, browser-only)`.

### Task 4: Web card

**Files:** Modify `public/index.html`; Test `test/mt-token-ui.test.ts` (source-scan: nonce on the card's inline script, `?v=__ASSET_V__` on any import, entry points present).

- A `#mtTokenOverlay` card (twin of `#authOverlay`): URL link, code input, submit, generic status. CSP nonce + ESM-bridge + mobile-viewport invariants.
- Entry points: (a) the token-missing / multi-tenant state near `showMigrationBanner`; (b) a "Replace token" control on the expiry line (`tokEl` / `accountExpiryLine`). Admin-only in the UI.

- [ ] **Step 1:** Failing source-scan test (nonce, asset-version, both entry points).
- [ ] **Step 2:** Implement card + wiring + `POST /mt-token/*` calls (ws-scheme/inline-handler rules).
- [ ] **Step 3:** Browser check on a FREE port, mono-tenant local build (`SHADOK_GUI_PASSWORD='' SHADOK_HOST=127.0.0.1`), screenshot the card markup paints (full mint not exercised locally).
- [ ] **Step 4: Commit** `feat(web): obtain/replace subscription-token card`.

### Task 5: Telegram door

**Files:** Modify `src/telegram.ts`; Test `test/telegram-mttoken.test.ts` or source-scan.

- `/mttoken` → `startSetupToken` → send URL + "send the code with /mtcode <code>"; `/mtcode <code>` → `submitSetupTokenCode` → confirm stored, never echo the token. DM-owner gated. Add to `/help`.

- [ ] **Step 1:** Failing test for the two command cases + help text.
- [ ] **Step 2:** Implement mirroring `case "login"`/`case "code"`.
- [ ] **Step 3: Run, pass. Commit** `feat(telegram): /mttoken + /mtcode`.

### Task 6: Docs + end-to-end note

**Files:** `README.md`, `docs/architecture.md`, `CLAUDE.md`.

- README: replace the "operator runs claude setup-token in a shell" provisioning note with the in-cockpit card + Telegram commands (shell remains the fallback).
- architecture.md: the new subsystem (PTY-driven, OSC-8 URL, token off the wire).
- CLAUDE.md: `src/setup-token.ts` row; a short invariant on "setup-token needs a PTY; the token never leaves the server".

- [ ] **Step 1:** Write the docs. **Step 2:** Full `npm test` + `npm run build`. **Step 3: Commit** `docs: in-cockpit subscription-token provisioning`.

## Self-review notes
- Proportion: plan ≈ spec length; bodies are signatures + test names, not code. OK.
- Type consistency: `startSetupToken`/`submitSetupTokenCode`/`setupTokenPending`/`cancelSetupToken` used identically in Tasks 2/3/5.
- Review Focus: each line mapped to a task + test above.
