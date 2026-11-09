# Onboarding "Connect Claude" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two first-run OAuth cards and the red token banner with one "Connect Claude" card (choose 1 month / 1 year → authorise → connected), gated by whether THIS agent can authenticate.

**Architecture:** A pure server-side verdict (`src/connect-gate.ts`) decides, per spawn and per instance, whether the credential the agent will actually use is present; the `start` handler, `firstAgentPlan` and `/auth` all read it. A pure client module (`public/connect-card.js`) decides which card step to show; `index.html` renders it, reusing the existing `/auth/*`, `/mt-token/*`, `/agent-login/*` flows.

**Tech Stack:** TypeScript (NodeNext ESM), Express, vanilla JS + ESM bridge in `public/index.html`, node:test via `npm test`, Playwright from `/root/tools/node_modules/playwright` for browser checks.

**Spec:** `docs/superpowers/specs/2026-11-09-onboarding-connect-claude-design.md`

## Global Constraints

- All repo text (code, comments, UI copy, commits) in English.
- Never put a token or credential value in a response, a log, an error, or the page — only ok/err (as `/mt-token/code` does today).
- Only an OBSERVED "not connected" refuses a spawn; "unknown" lets it through (invariant 27).
- Mono-tenant: no duration choice; spawn gate unchanged (root sign-in).
- Connecting a space is admin-only; the existing `mtTokenGate` / `mtReadGate` stay as they are.
- No regression: a spawn that is allowed today on a running instance stays allowed.
- Every new inline `<script>` carries `__CSP_NONCE__`; no inline handlers (invariant 12). New ESM module → bridged name + stub (invariant 10, `test/esm-bridge.test.ts`), import URL with `?v=__ASSET_V__`.
- Mobile: inputs ≥ 16px (invariant 28), tiles stacked ≤ 640px, primary button full width.
- Verify a build on a free port only (`PORT=3899 SHADOK_VERSION_CHECK_MIN=0 SHADOK_SEED_SKILLS=0 node dist/server.js`), never 3789.

## Review Focus

1. Login mode with the commons user already logged in but NO token stored → spawn must be allowed (today `mtRefusal` refuses it: it ignores `agentAuth`). Test in Task 1.
2. Unmigrated multi-tenant instance (commons = root, `dropUser` null) signed in at root → spawn allowed, card not shown. Test in Task 1.
3. Member (non-admin) on an unconnected space → never an OAuth flow, never a 403 popup; a calm "ask an admin" notice. Test in Task 3.
4. Pasted token with whitespace/newline around it, or a wrong shape → trimmed / refused with a message that does not echo it. Test in Task 2.
5. Phone (390×844, touch): code field stays visible above the keyboard and the page does not zoom. Checked in Task 5.

---

### Task 1: Pure connect verdict + wire it into the spawn gate and first agent

**Files:**
- Create: `src/connect-gate.ts`
- Modify: `src/server.ts` (the `start` handler: replace `mtRefusal` + the root `authStatus()` refusal by the verdict; `/auth` adds a `connect` field)
- Modify: `src/first-agent.ts` (`firstAgentPlan` input `authState` → `connected`)
- Test: `test/connect-gate.test.ts`, update `test/first-agent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Connected = "yes" | "no" | "unknown";
  export interface ConnectFacts {
    multiTenant: boolean;
    customBackend: boolean;
    dropUser: string | null;          // the OS user the agent will run as (null = server's own)
    agentAuth: "token" | "login";
    hasToken: boolean;                // MT_CLAUDE_OAUTH_TOKEN present in Main
    rootAuth: "signed-in" | "signed-out" | "unknown";
    userLoggedIn: boolean | null;     // agentLoginInfo(home).loggedIn for dropUser; null = not looked up
  }
  export type ConnectVerdict =
    | { ok: true }
    | { ok: false; code: "logged-out" | "space-not-connected"; user: string | null; message: string };
  export function connectVerdict(f: ConnectFacts): ConnectVerdict;
  export function connectedState(f: ConnectFacts): Connected; // "yes" if ok, "unknown" if the deciding fact is unknown, else "no"
  ```
  `/auth` JSON gains `connect: { state: Connected; multiTenant: boolean; agentAuth: "token"|"login"; user: string|null; expiresAt: number|null }` computed for the COMMONS user.
  `ws` `error` gains code `"space-not-connected"` with an extra `user` field.

Rules (`connectVerdict`): custom backend → ok. `dropUser === null` (mono, or unmigrated commons) → root: `signed-out` → `logged-out`, else ok. `dropUser` set + `token` → `hasToken` ok, else `space-not-connected`. `dropUser` set + `login` → `userLoggedIn === false` → `space-not-connected`, else ok (null counts as unknown → ok).

- [ ] **Step 1: Write failing tests** in `test/connect-gate.test.ts`:
  - `mono signed-out refuses logged-out`, `mono unknown allows`, `custom backend always allows`
  - `unmigrated MT (dropUser null) signed-in allows` (Review Focus 2)
  - `MT token mode without token refuses space-not-connected, user=main`
  - `MT token mode with token allows even when root signed-out` (the double-OAuth fix)
  - `MT login mode, user logged in, no token → allows` (Review Focus 1)
  - `MT login mode, user not logged in → space-not-connected`
  - `connectedState maps ok→yes, refusal→no, unknown root→unknown`
  - message never contains the substring `sk-ant`.
- [ ] **Step 2:** `npm test -- test/connect-gate.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/connect-gate.ts`. Messages: logged-out keeps today's text; space-not-connected: `"This space isn't connected to Claude yet — an admin can connect it from the cockpit."`.
- [ ] **Step 4: Wire the start handler.** Build the facts with the same `dropUser`/`earlyUser` the code already computes; `rootAuth` from `authStatus()` only when `dropUser` is null (keep the probe off the dropped path); `userLoggedIn` from `agentLoginInfo(agentStateHome(dropUser)).loggedIn` only in login mode. Replace both `mtRefusal` calls and the `auth.state === "signed-out"` branch with `connectVerdict`; on refusal `fail(message, code)` and include `user`. Keep `announceLoggedOut()` for `logged-out`; log `space-not-connected` once per user (same dedupe idea as `mtTokenWarned`).
- [ ] **Step 5: `firstAgentPlan`** takes `connected: Connected` instead of `authState`; spawn only on `"yes"`; reason stays `"not-signed-in"` for no/unknown. `ensureFirstAgent` computes it via `connectedState` for the commons user. Update `test/first-agent.test.ts` accordingly (fresh MT with token + root signed-out → spawn).
- [ ] **Step 6: `/auth`** adds `connect` (commons facts; `expiresAt` = login `expiresAt` in login mode, `longLivedExpiresAt` in token mode, `readTokenExpiry` refresh expiry for root).
- [ ] **Step 7:** `npm run build && npm test` → all green.
- [ ] **Step 8: Commit** `connect gate: refuse a spawn only when ITS credential is missing`.

### Task 2: Server hooks for the card — mode choice, paste token, first-agent trigger

**Files:**
- Modify: `src/server.ts` (`/mt-token/code`, `/agent-login/code`, new `POST /mt-token/paste`)
- Create: `src/token-paste.ts` (pure)
- Test: `test/token-paste.test.ts`

**Interfaces:**
- Consumes: `connectedState` (Task 1).
- Produces: `export function normalizePastedToken(raw: unknown): { ok: true; token: string } | { ok: false; error: string }` — trims whitespace/newlines, requires `/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/`; the error never includes the input.
  `POST /mt-token/paste {token}` → `mtTokenGate`; stores via `setSecret(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID, "operator:paste")`; also sets `agentAuth = "token"` (same writer as `/agent-login/mode`, no restart when unchanged); responds `{ok}` only.

- [ ] **Step 1: Failing tests** `test/token-paste.test.ts`: trims `"  sk-ant-oat01-<24 chars>\n"`; refuses `""`, `"hello"`, an `sk-ant-api03-…` key; error string does not contain the input (Review Focus 4).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement `src/token-paste.ts` and the route.
- [ ] **Step 4:** after a successful `/mt-token/code`, `/mt-token/paste` and `/agent-login/code` (the latter only when the user is the commons user), call `void startFirstAgent(); void maybeRunGroupsMigration("post-sign-in");` exactly as `/auth/code` does, after answering.
- [ ] **Step 5:** `npm run build && npm test` green.
- [ ] **Step 6: Commit** `connect: paste a long-lived token; a space connection starts the first agent`.

### Task 3: Pure card state (client)

**Files:**
- Create: `public/connect-card.js` (ESM, bridged)
- Test: `test/connect-card.test.ts`
- Modify: `test/esm-bridge.test.ts` only if it enumerates names (add `connectCardPlan`)

**Interfaces:**
- Consumes: `/auth` `connect` field (Task 1), `me.role`.
- Produces:
  ```js
  /** @returns {{open: boolean, step: "choose"|"authorise"|"ask-admin"|null, flow: "instance"|"token"|"login"|null, user: string|null, dismissable: boolean}} */
  export function connectCardPlan({ connect, backend, isAdmin, refusal /* {code, user}|null */, force /* bool */ })
  ```
  Rules: `backend === "custom"` → closed. `refusal?.code === "space-not-connected"` → admin: `authorise` (flow = `connect.agentAuth === "login" ? "login" : "token"`, user = refusal.user), member: `ask-admin`, dismissable. `connect.state === "no"` → admin MT: `choose`, not dismissable; admin mono: `authorise` flow `instance`; member: `ask-admin`. `"unknown"`/`"yes"` → closed unless `force` (re-login) → `authorise` with the current flow, dismissable.

- [ ] **Step 1: Failing tests** covering each rule above, plus `member never gets choose or authorise` (Review Focus 3).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** green.
- [ ] **Step 5: Commit** `connect card: pure plan of which step to show`.

### Task 4: The card UI (desktop), replacing the two cards and the banner

**Files:**
- Modify: `public/index.html` (markup of `#authOverlay` → the 3-step card; CSS; `checkAuth`, `openAuthCard`, `startClaudeLogin`, the mtToken card JS, `updateMtTokenBanner`, the `logged-out` WS handler)

**Interfaces:**
- Consumes: `connectCardPlan` (Task 3), routes `/auth/login|code`, `/mt-token/start|code|paste`, `/agent-login/mode|start|code` (Task 2).

Copy (from the approved mockups, may be polished):
- Choose: tag "Step 1 of 2 · Connect Claude"; title "Connect your Claude subscription"; lead "Every agent here is a real Claude Code session, and it runs on your Claude plan — nothing is billed per call. Shadok needs your permission once to use it. Pick how long that permission lasts:"; tiles "1 month" (recommended: "Your agents get your claude.ai connectors (Gmail, Drive, Slack…)", "Shadok reminds you a few days before it expires") / "1 year" ("Set it and forget it", "Model access only — no connectors"); links "I already have a token" and "Use another model" (opens today's custom-backend form).
- Authorise: "Authorise Shadok on claude.ai" + "A Claude page opens in a new tab. Approve it, then Claude shows you a short code — come back to this tab and paste it."; primary button "Open claude.ai ↗" (an `<a target=_blank rel=noopener>` styled as a button, href = the flow URL; disabled "Preparing…" until it arrives); "copy the link instead" (Clipboard API, "Copied" for 2s); field "Paste the code Claude gave you" + "Connect"; footer "← change duration" (MT only) and "The code expires after about 10 minutes."
- Connected: "✓ Claude is connected", "until <date>" when known, "Your first agent, general, is starting." when the instance had no channel; button "Let's go".
- Ask-admin: "This space isn't connected to Claude yet. Ask an admin to connect it." + "OK".

- [ ] **Step 1:** Choosing 1 month → `POST /agent-login/mode {mode:"login"}` then `/agent-login/start {user}`; 1 year → mode `token` then `/mt-token/start`; mono → `/auth/login`. The raw URL is never rendered as text.
- [ ] **Step 2:** Remove `updateMtTokenBanner` and its call; the `#mtTokenOverlay` card stays reachable only from the version menu's existing "rotate token" entry (reuse the new authorise step there if cheap, else leave it).
- [ ] **Step 2b:** Admin indicator of unconnected spaces: the existing per-user list (`GET /agent-login`, version menu) already carries `loggedIn` per space — mark a not-logged-in space "Not connected" with a Connect button that opens the authorise step for that user. No new panel.
- [ ] **Step 3:** `checkAuth()` (after the tour) and the WS `error` handler (`logged-out` / `space-not-connected`) both call `connectCardPlan` and render.
- [ ] **Step 4:** `npm run build`, run on port 3899 with a temp HOME is NOT enough for MT (needs root + accounts) → verify on test.shadok.ai in Task 5; locally check the mono path: signed-out page shows the authorise step with the button, no raw URL, console clean (`npm test` for csp/esm-bridge green).
- [ ] **Step 5: Commit** `onboarding: one Connect Claude card, no red banner on first run`.

### Task 5: Mobile, docs, and end-to-end on test.shadok.ai

**Files:**
- Modify: `public/index.html` (CSS under the existing `max-width: 640px` query), `test/mobile-viewport.test.ts` (assert the new code input is covered by the ≥16px rule)
- Modify: `README.md` (first run), `docs/architecture.md` (auth section: the connect gate), `CLAUDE.md` (map row for `src/connect-gate.ts`, `public/connect-card.js`; note the gate change next to invariant 27)

- [ ] **Step 1:** CSS: tiles `flex-direction: column` ≤ 640px, primary button `width: 100%`, panel full width (existing `.sec-panel` rule). Add the mobile-viewport assertion; `npm test` green.
- [ ] **Step 2: Deploy to test.shadok.ai** following the mt373 pattern (bind-mount `dist/`, `public/`, `context/` from `~/test-build/` into a recreated `test` container, `SHADOK_AUTOUPDATE=0`), after trashing it: `docker rm -f test`, `docker volume rm test-data test-workspace`, empty `claude-home-test`, recreate (network `test-net`, port 3806).
- [ ] **Step 3: Playwright, desktop 1280×800 and phone 390×844 touch**, screenshots read back: login → tour → choose card (no banner) → 1 year → authorise (button, no raw URL); "← change duration" → 1 month → authorise. Console free of CSP/module errors. On the phone: no horizontal scroll, input font ≥ 16px (computed style), tiles stacked (Review Focus 5).
- [ ] **Step 4: Live OAuth with the operator** (only they can approve on claude.ai): 1 year on a root-NOT-signed-in instance → token stored, first agent `general` spawns and greets. This is the spec's open check (setup-token without root login); if it fails, stop and report.
- [ ] **Step 5:** Docs updated; `npm run build && npm test` green.
- [ ] **Step 6: Commit** `onboarding: mobile layout, docs`, push branch, open PR (author `shadok-ai-dev`), report the link.
