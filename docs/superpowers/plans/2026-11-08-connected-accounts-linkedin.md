# Connected accounts (LinkedIn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person clicks *Connect LinkedIn*, then tells an agent "post this"; the server publishes on a connected account under its owner's sharing scope and approval policy, with no token ever reaching an agent.

**Architecture:** A stateless Cloudflare Worker broker (`broker/`, the only holder of the LinkedIn client secret) runs the OAuth code exchange and hands the token back through the browser, encrypted for an ephemeral key the instance generated. The instance stores connected accounts server-side, exposes them to agents through a `shadok-social` skill that can only create drafts or (under the `autonomous` policy) publish, and gates approval on a browser person.

**Tech Stack:** TypeScript ESM/NodeNext, Node 20 (`node:crypto`, global `fetch`, WebCrypto), `node:test` via `tsx`, Express + `ws` (existing), Cloudflare Workers + wrangler (broker only). No new runtime dependency in the instance.

**Spec:** `docs/superpowers/specs/2026-11-08-connected-accounts-linkedin-design.md`

## Global Constraints

- No token in: an agent's env, argv, transcript, skill output, `GET /social/accounts`, `GET /connected-accounts`, the publication log, any console line.
- Approval (`/social/drafts/:id/publish|discard`) and every account mutation: `requestFromBrowser(req)` only (`src/server.ts`, wraps `isBrowserPerson`). Agents: `agentPrincipal(req)` only.
- Defaults: `share: {scope:"private"}`, `policy: "approve"`. Draft TTL 7 days. Pending connect TTL 10 minutes. Expiry warning at 7 days before `expiresAt`.
- Broker URL: `SHADOK_CONNECT_BROKER`, default `https://connect.shadok.ai`. Callback path on the broker: `/linkedin/callback`. Return path on the instance: `/connect/linkedin/done`.
- Return URL accepted by the broker: `https:` any host, or `http:` only on `localhost`, `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`; path must be exactly `/connect/linkedin/done`; no credentials in the URL.
- Crypto: ECDH P-256 → HKDF-SHA256 (info `"shadok-connect-v1"`, empty salt) → AES-256-GCM, 12-byte IV, AAD = the nonce bytes.
- Stores (mode 600, keyed by `instanceKey(process.cwd())` from `src/paths.ts`): `~/.shadok-ai/connected-accounts/<key>.json`, `…/<key>.drafts.json`, `…/<key>.log.jsonl`.
- Account ids are short (8 hex) and resolved by unique prefix; empty/ambiguous refused (invariant 17).
- Every new skill is listed in `SKILL_SOURCES`, seeded behind `SEED_SKILLS`, and its SKILL.md names `x-shadok-session-key` (tests `system-skills`, `skill-auth-docs`).
- Everything written in the repo is English. Docs ship in the same PR as the code they describe.
- Mono-tenant is a SOFT layer (spec "Where the wall is real"): the panel says so in one sentence when `DEPLOYMENT_MODE !== "multi-tenant"`.
- PR split: Tasks 1–2 = PR 1 (broker). Tasks 3–11 = PR 2 (instance). Each PR inert alone.
- Run your build only side by side: `PORT=3899 SHADOK_VERSION_CHECK_MIN=0 SHADOK_SEED_SKILLS=0 node dist/server.js`. Never touch 3789.

## Review Focus

1. **Reserved characters in post text** (`(`, `)`, `#`, `@`, `*`, `_`, `~`, `<`, `>`, `[`, `]`, `{`, `}`, `|`, `\`) — the post appears on LinkedIn exactly as written, not truncated at the first `(`. Pinned in Task 5.
2. **Double approval** (double-click, two tabs, web + retry) — one post, the second click answers "already published" with the URL. Pinned in Task 7.
3. **Account unshared / disconnected / expired while a draft is pending** — Publish refuses with a sentence naming the account and who can fix it; nothing is posted. Pinned in Task 7.
4. **LinkedIn answers 401 before `expiresAt`** (the person revoked the app) — the account flips to `expired`, the publish fails with the reconnect sentence, the log records it. Pinned in Task 7.
5. **Server restart between Connect and the callback** — `/connect/linkedin/complete` answers "this connection attempt expired — click Connect again", never a 500. Pinned in Task 6.

---

### Task 1: Broker pure core

**Files:**
- Create: `broker/src/core.ts`, `broker/tsconfig.json` (target ES2022, `lib: ["ES2022","WebWorker"]`, `noEmit`)
- Test: `test/broker-core.test.ts`

**Interfaces:**
- Produces:
  - `validateReturnUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string }`
  - `signState(s: ConnectState, key: string): Promise<string>` / `verifyState(token: string, key: string): Promise<ConnectState | null>` where `interface ConnectState { v: 1; provider: "linkedin"; returnUrl: string; pub: string /* base64url raw P-256 point */; nonce: string /* base64url 16 bytes */; iat: number }`; state = `base64url(json) + "." + base64url(HMAC-SHA256)`; refused when `Date.now() - iat > 15 min`.
  - `encryptForInstance(pubB64u: string, nonceB64u: string, payload: TokenPayload): Promise<string>` → `base64url(brokerPubRaw).base64url(iv).base64url(ciphertext)`; `interface TokenPayload { access_token: string; expires_in: number; scope: string; refresh_token?: string; refresh_token_expires_in?: number }`.
  - Uses only `globalThis.crypto.subtle` (runs in Workers and Node 20).

- [ ] **Step 1: Write failing tests** — `validateReturnUrl`: accepts `https://cockpit.acme.com/connect/linkedin/done`, `http://localhost:3789/connect/linkedin/done`, `http://192.168.1.5:3789/connect/linkedin/done`; refuses `http://evil.com/connect/linkedin/done`, `https://x.com/other`, `https://u:p@x.com/connect/linkedin/done`, `javascript:…`. `signState`→`verifyState` round-trips; a flipped byte → null; wrong key → null; `iat` 16 min old → null.
- [ ] **Step 2: Run** `node --import tsx --test test/broker-core.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `broker/src/core.ts` with the signatures above.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Broker: return-URL validation, signed state, encryption for the instance"`

### Task 2: Broker Worker routes

**Files:**
- Create: `broker/src/worker.ts`, `broker/wrangler.toml` (name `shadok-connect`, route `connect.shadok.ai/*`), `broker/README.md` (secrets `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `STATE_KEY`; `wrangler dev`; deploy)
- Test: `test/broker-worker.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `export default { fetch(req: Request, env: Env): Promise<Response> }` with routes:
  - `GET /health` → `{ ok: true, providers: ["linkedin"] }`
  - `GET /linkedin/start?return&pub&nonce` → 302 to `https://www.linkedin.com/oauth/v2/authorization` with `response_type=code`, `client_id`, `redirect_uri=https://<broker host>/linkedin/callback`, `scope=openid profile w_member_social`, `state=signState(...)`. 400 page on invalid input.
  - `GET /linkedin/callback?code&state` (or `?error&state`) → verify state; POST `https://www.linkedin.com/oauth/v2/accessToken` (form: `grant_type=authorization_code`, code, redirect_uri, client_id, client_secret); render the interstitial HTML: *"You are connecting LinkedIn to the shadok cockpit at **{returnUrl host}**. Only continue if that is your cockpit."* with a **Continue** link to `returnUrl#n=<nonce>&c=<ciphertext>` and a *Cancel* link to `returnUrl#n=<nonce>&error=cancelled`. LinkedIn `error` → link to `returnUrl#n=<nonce>&error=<code>`. (The nonce is not secret; the instance needs it to find its pending key.) A bad state → 400 page, no link.
  - Response headers on HTML: `cache-control: no-store`, `referrer-policy: no-referrer`, CSP `default-src 'none'; style-src 'unsafe-inline'`.

- [ ] **Step 1: Failing tests** calling `worker.fetch(new Request(...), env)` with `globalThis.fetch` stubbed: `/health` shape; `/linkedin/start` 302 with the exact query params and a state that `verifyState` accepts; `/linkedin/start` with a public `http:` return → 400; callback with stubbed token response → HTML contains the host and a `#n=<nonce>&c=` link, and the ciphertext decrypts (use WebCrypto in the test with the private key generated for `pub`) to the stubbed token; callback with `error=user_cancelled_authorize` → link `#n=<nonce>&error=user_cancelled_authorize`; tampered state → 400 and the token endpoint stub was never called.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `worker.ts`.
- [ ] **Step 4: Run** — PASS. Also `npx tsc -p broker/tsconfig.json` clean.
- [ ] **Step 5: Commit** `"Broker: Cloudflare Worker for the LinkedIn connect flow"` — **end of PR 1**.

### Task 3: Instance-side connect crypto + pending attempts

**Files:**
- Create: `src/connect-crypto.ts`
- Test: `test/connect-crypto.test.ts`

**Interfaces:**
- Consumes: `encryptForInstance` (Task 1) — test only, imported by relative path `../broker/src/core.js`.
- Produces:
  - `newAttempt(person: string, now: number): { attempt: PendingAttempt; pub: string; nonce: string }` — `interface PendingAttempt { nonce: string; person: string; privateKey: KeyObject; createdAt: number }`
  - `decryptPayload(attempt: PendingAttempt, blob: string): TokenPayload` (throws on tamper) — `node:crypto` (`createECDH('prime256v1')` or `generateKeyPairSync('ec')` + `diffieHellman`, `hkdfSync`, `createDecipheriv('aes-256-gcm')`).
  - `class PendingAttempts { add(a); take(nonce, person, now): PendingAttempt | "unknown" | "expired" | "wrong-person" }` — single use, TTL `CONNECT_TTL_MS = 10 * 60_000`.

- [ ] **Step 1: Failing tests:** Worker-side `encryptForInstance` → `decryptPayload` round-trip; wrong nonce AAD throws; `take` twice → second `"unknown"`; after 10 min → `"expired"`; other person → `"wrong-person"` and the attempt is NOT consumed.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `"Connect: instance-side key agreement and single-use attempts"`

### Task 4: Connected-account store and visibility

**Files:**
- Create: `src/connected-accounts.ts`
- Test: `test/connected-accounts.test.ts`

**Interfaces:**
- Consumes: `Group`, `Viewer`, `MAIN_GROUP_ID`, `viewerInGroup`, `memberOf` from `src/groups.ts`; `instanceKey` from `src/paths.ts`.
- Produces:
  - `ConnectedAccount` exactly as in the spec §3, plus `status?: "ok" | "expired"`.
  - `accountsFileFor(cwd: string): string`; `loadAccountsStore(file): ConnectedAccount[]`; `saveAccountsStore(file, list)` (atomic, 600).
  - `upsertAccount(list, incoming, now): { list; account }` — same `provider + externalId` supersedes token/expiry/`connectedVia`/`label` in place, keeps `id`, `owner`, `share`, `policy`.
  - `resolveAccountId(list, prefix): ConnectedAccount | "none" | "ambiguous"` (empty prefix → `"none"`).
  - `commonsGroupIds(groups): Set<string>` — Main + every `public` group (same tier as the vault's commons in `src/secrets.ts`; reuse its helper if exported, else extract it there and import it).
  - `accountVisible(a, viewer: Viewer | null, groups, opts: { peerBox: string | null }): boolean` — rules in spec §3 (as amended).
  - `accountEditVerdict(a, viewer, change: "share" | "policy" | "reconnect" | "disconnect", next?): { ok: true } | { ok: false; reason: string }` — owner: all; admin non-owner: `disconnect` only; `policy → autonomous` owner only; `share.groups` must all be groups the owner is a member of.
  - `publicView(a): Omit<ConnectedAccount, "token" | "refreshToken">` — the ONLY shape any route returns.

- [ ] **Step 1: Failing tests:** the matrix scope {private, groups[restricted g1], groups[Main], instance} × viewer {owner, member of g1, non-member, admin non-owner, agent in owner's private group, agent in g1, agent in Main, agent in someone else's private group, any viewer with `peerBox`}. Must include: owner's agent in a shared group does NOT see a private account; `instance` is NOT visible to an agent in another person's private group; `peerBox` → never visible. Edit verdicts: admin can disconnect, cannot switch policy; share to a group the owner isn't in → refused. `upsertAccount` keeps id/share/policy. `publicView` has no `token` key (`assert.ok(!("token" in v))`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `"Connected accounts: store, visibility, edit rules"`

### Task 5: LinkedIn client

**Files:**
- Create: `src/linkedin.ts`
- Test: `test/linkedin.test.ts`

**Interfaces:**
- Produces (all HTTP through an injected `fetchFn: typeof fetch`, header `LinkedIn-Version: <LINKEDIN_VERSION>` and `X-Restli-Protocol-Version: 2.0.0` on `/rest/*`):
  - `LINKEDIN_VERSION` — a `YYYYMM` constant; builder sets it to a currently supported version (Verify-first 4).
  - `MAX_COMMENTARY = 3000` (verify) — `postTextVerdict(text): { ok: true } | { ok: false; reason: string }` (empty, over-length).
  - `escapeCommentary(text: string): string` — backslash-escapes `\ | { } @ [ ] ( ) < > # * _ ~` (the "little text" reserved set; confirm in Verify-first 4).
  - `fetchMember(token, fetchFn): Promise<{ sub: string; name: string }>` — `GET https://api.linkedin.com/v2/userinfo`.
  - `uploadImage(token, authorUrn, bytes: Buffer, mime, fetchFn): Promise<string /* urn:li:image */>` — `POST /rest/images?action=initializeUpload` then `PUT uploadUrl`.
  - `createPost(token, { authorUrn, text, imageUrn? }, fetchFn): Promise<{ urn: string; url: string }>` — `POST /rest/posts`, body `{author, commentary: escapeCommentary(text), visibility:"PUBLIC", distribution:{feedDistribution:"MAIN_FEED", targetEntities:[], thirdPartyDistributionChannels:[]}, lifecycleState:"PUBLISHED", isReshareDisabledByAuthor:false, content?:{media:{id}}}`; the URN comes from the `x-restli-id` response header; `url = https://www.linkedin.com/feed/update/<urn>/`.
  - `class LinkedInError extends Error { status: number; expired: boolean /* status 401 */ }`.

- [ ] **Step 1: Failing tests:** `escapeCommentary("Launch (beta) #shadok @Ada 50% *new*")` equals `"Launch \\(beta\\) \\#shadok \\@Ada 50% \\*new\\*"`; every reserved char escaped once, nothing else touched, accents/emoji untouched; `createPost` sends the exact body/headers to a stub and returns the urn from `x-restli-id`; 401 → `LinkedInError` with `expired: true`; 3001 chars → `postTextVerdict` refuses.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `"LinkedIn client: posts, images, userinfo, commentary escaping"`

### Task 6: Connect routes and account management routes

**Files:**
- Modify: `src/server.ts` (new routes near the `/secrets` routes; one `PendingAttempts` instance; a cached broker health probe)
- Test: `test/connect-routes.test.ts` (pure verdict helpers extracted to `src/connect-routes.ts` if needed, same split as `route-guards.ts`)

**Interfaces:**
- Consumes: Tasks 3, 4, 5; `requestFromBrowser`, `currentAccount`/`viewerFor`, `loadGroups`.
- Produces (all browser-person only unless noted):
  - `GET /connect/status` → `{ available: boolean }` — broker `/health` fetched at most every 5 min, `available` = it answered with `linkedin`.
  - `POST /connect/linkedin/start` `{ origin: string }` → `{ url }` = `${BROKER}/linkedin/start?return=${origin}/connect/linkedin/done&pub&nonce`. `origin` must equal the request's `Origin` header.
  - `GET /connect/linkedin/done` — reachable behind the gate like any page; served from `public/connect-done.html` with `__CSP_NONCE__` (invariant 12); its script POSTs `{ hash: location.hash }` to `/connect/linkedin/complete`, `history.replaceState` to drop the hash, shows the outcome sentence, links back to `/`.
  - `POST /connect/linkedin/complete` `{ hash }` → parses `#n=…&c=…` / `#n=…&error=…`; `take(nonce…)`; `decryptPayload`; `fetchMember`; `upsertAccount` with `owner = connectedVia = person`, `kind:"member"`, `externalId = urn:li:person:<sub>`, `expiresAt = now + expires_in*1000`; → `{ account: publicView }`. Outcomes as sentences: `"unknown"/"expired"` → *"This connection attempt expired — click Connect LinkedIn again."*; `error=user_cancelled_authorize`/`cancelled` → *"Connection cancelled."*.
  - `GET /connected-accounts` → `publicView[]` visible to the person + `{ softLayer: DEPLOYMENT_MODE !== "multi-tenant" }`.
  - `PUT /connected-accounts/:id` `{ share?, policy? }`, `DELETE /connected-accounts/:id` — through `accountEditVerdict`; 403 with the reason.

- [ ] **Step 1: Failing tests** for the pure parts: hash parsing (`#n=..&c=..`, `#error=..`, garbage → error); origin check; the outcome-sentence mapping (Review Focus 5: unknown nonce → the "expired, click again" sentence, status 410 not 500).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** routes + `public/connect-done.html`. **Step 4: Run** tests — PASS; `npm run build` clean; `test/csp.test.ts` still green (the new page carries the nonce).
- [ ] **Step 5: Commit** `"Connect LinkedIn: start/done/complete routes and account management"`

### Task 7: Drafts, publishing, the log

**Files:**
- Create: `src/social-drafts.ts`
- Modify: `src/server.ts` (routes; `historyWithOffers` → also merge drafts; agent notice)
- Test: `test/social-drafts.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5; `agentPrincipal`, `restrictedBoxOf`, `requestFromBrowser`, `broadcast`, `driveChannel` + `markAgentPrompt` + `resolveSessionTarget` (same delivery as `deliverToParent`), `channelLabel`.
- Produces:
  - `interface Draft { id: string; sessionId: string; accountId: string; text: string; imagePath?: string; status: "pending" | "publishing" | "published" | "discarded" | "expired" | "failed"; createdAt: number; decidedBy?: string; postUrl?: string; error?: string }`
  - `DRAFT_TTL_MS = 7 * 24 * 3600_000`; `expireDrafts(list, now): { list; expired: Draft[] }`.
  - `publishVerdict(draft, account | undefined, viewer, groups, now): { ok: true } | { ok: false; status: number; reason: string }` — refusals (sentences): draft not pending (`published` → 409 *"Already published: <url>"*); account gone → *"The LinkedIn account this draft was for has been disconnected."*; not visible to the approver → 403; account expired → *"LinkedIn account '<label>' expired on <date> — <owner> must reconnect it in Secrets → Connected accounts."*
  - `interface LogEntry { at; accountId; sessionId?; channel?; origin: "agent" | "cron" | "person"; approvedBy: string | "autonomous"; text; outcome: "published" | "refused" | "failed" | "expired"; postUrl?; error? }`; `appendLog(file, e)`.
  - Routes:
    - `GET /social/accounts` (agent) → visible accounts: `{id, label, provider, kind, policy, expiresAt, status}`.
    - `POST /social/posts` (agent) `{ account, text, image? }` → resolve id prefix; visible?; `postTextVerdict`; image must be an absolute path readable via `statForOfferAs`/`readSessionFile` (the agent's rights, invariant 60). `approve` → save draft, `broadcast(session, {type:"social-draft", draft: draftView})`, → `{status:"pending", draftId}`. `autonomous` → publish now → `{status:"published", url}`.
    - `POST /social/drafts/:id/publish|discard` (browser person) → `publishVerdict`; set `status:"publishing"` and save BEFORE the LinkedIn call (Review Focus 2: a second click sees `publishing`/`published` and gets 409); on `LinkedInError.expired` set the account `status:"expired"` (Review Focus 4); log; broadcast the updated draft; notify the agent with `markAgentPrompt("Your LinkedIn draft <id8> was published: <url>")` / discarded / failed reason.
    - `origin` in the log: `"cron"` when the session's current turn was a cron fire (read it where the `Live` records the submitted origin; if none is recorded, `"agent"`).
  - `historyWithOffers` also interleaves the session's drafts as `{ role: "social-draft", draft }` turns by `createdAt`.

- [ ] **Step 1: Failing tests (pure):** `publishVerdict` for each refusal above, including Review Focus 3 (account unshared after draft creation → 403 sentence; disconnected → sentence; expired → sentence naming owner); a `publishing` draft refuses a second publish (Review Focus 2); `expireDrafts` at 7 days; an agent viewer can never pass `publishVerdict` — the route also checks `requestFromBrowser` (assert via a pure `approvalCaller({hasAgentKey, ...})` helper reusing `isBrowserPerson`). A log entry serialised by `appendLog` contains no `token`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `npm run build` clean.
- [ ] **Step 5: Commit** `"Social posting: drafts, approval gate, autonomous policy, publication log"`

### Task 8: The `shadok-social` skill

**Files:**
- Create: `context/social-skill/SKILL.md`, `context/social-skill/scripts/social.mjs`, `context/social-skill/test/social.test.mjs`
- Modify: `src/server.ts` (`seedSocialSkill()` behind `SEED_SKILLS`, twin of `seedFilesSkill`; add `["social-skill","shadok-social"]` to `SKILL_SOURCES`); `test/skill-auth-docs.test.ts` (add the skill to its list if it enumerates them)

**Interfaces:**
- Consumes: Task 7 routes.
- Produces: `social.mjs accounts` (table: id8, label, policy, expires) and `social.mjs post --account <id> [--image <abs>] --stdin`; sends `x-shadok-session-key: $SHADOK_SESSION_KEY` to `http://127.0.0.1:${SHADOK_PORT}`; prints *"Draft <id8> is waiting for approval in the cockpit."* or the post URL; a refusal prints the server's sentence and exits 1; text over 3000 chars refused locally before sending.
- SKILL.md: when to use (the person asks to post on LinkedIn); ALWAYS show the final text in the chat first; never claim a draft is published until told; the 401 sentence shared with the other skills (`skill-auth-docs`).

- [ ] **Step 1: Failing test** (`social.test.mjs`, a stub HTTP server): `post --stdin` sends the body + header; `--image` relative → refused locally; `accounts` never prints a field named `token` even if the stub returns one.
- [ ] **Step 2: Run** `npm test` — the new test FAILs; `system-skills` FAILs until `SKILL_SOURCES` lists it.
- [ ] **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `"shadok-social skill: list accounts, draft or publish a LinkedIn post"`

### Task 9: Expiry watch and owner notifications

**Files:**
- Modify: `src/server.ts` (an unref'd hourly timer beside `cronTimer`), `src/telegram.ts` (`TelegramHandle.notifyOwner(text: string): Promise<boolean>` — DMs the DM owner; `NOOP_HANDLE` returns false)
- Create: `src/account-expiry.ts`
- Test: `test/account-expiry.test.ts`

**Interfaces:**
- Produces: `expiryActions(accounts, drafts, now, lastWarned: Record<string, number>): { warn: ConnectedAccount[]; expire: ConnectedAccount[]; expiredDrafts: Draft[] }` — warn once per account when `expiresAt - now <= 7 days` and not warned in the last 24h; expire when `now >= expiresAt`.
- Server applies: warn → `notifyOwner` when the account owner is the bootstrap admin (the Telegram DM owner is the instance operator; no other person↔Telegram mapping exists — spec non-goal) + the panel shows it (Task 10); expire → `status:"expired"`; expired drafts → log `expired` + agent notice *"Your LinkedIn draft <id8> expired after 7 days without approval — it was not published."*
- New pending draft → `notifyOwner` (*"<channel> has a LinkedIn post waiting for your approval in the cockpit."*) under the same owner condition.

- [ ] **Step 1: Failing tests:** warn at J-7, not at J-8; no re-warn within 24h; expire at `expiresAt`; drafts at 7 days.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `"Connected accounts: expiry warnings, expired drafts, owner DM"`

### Task 10: Web UI

**Files:**
- Modify: `public/index.html` (Connected accounts section at the top of `#secretsPanel`; the draft card renderer; tab mood)
- Create: `public/social-card.js` (pure `draftCardModel(draft)` → `{title, text, actions, statusLine}`; `accountRowModel(account, now)` → `{label, via, expiryText, tone: "ok"|"soon"|"expired", shareText, policyText}`), bridged with a stub per invariant 10
- Test: `test/social-card.test.ts`; extend `test/esm-bridge.test.ts` if it enumerates bridged names

**Interfaces:**
- Consumes: `GET /connect/status`, `POST /connect/linkedin/start` (then `location.href = url`), `GET/PUT/DELETE /connected-accounts`, `POST /social/drafts/:id/publish|discard`, WS `social-draft`, history turns `social-draft`.
- Produces:
  - Panel: *Connect LinkedIn* (hidden when `available:false`, replaced by *"LinkedIn connection is unavailable right now."*); per account: label, *via*, expiry (tone `soon` < 7 days, `expired`), share picker (Private / my groups / Everyone), policy toggle with the confirm copy *"Agents in <scope> will be able to post as <label> without asking anyone."*, Reconnect, Disconnect; when `softLayer`: *"On this instance agents run as the same system user as the cockpit: approval protects against mistakes, not against an agent that tries to work around it."*
  - Draft card in the chat: account label, the exact text (textContent, never innerHTML — invariant 13), the image, *Publish* / *Discard*; after decision the status line (*Published — <link>* / *Discarded by <name>* / the refusal sentence). A pending draft sets the tab mood to `needs-answer` (so `notifyState` badges it).
- All handlers via `addEventListener` (invariant 12).

- [ ] **Step 1: Failing tests** for `draftCardModel` / `accountRowModel` (tones at 8d/6d/-1d; published shows the URL; text with `<script>` stays in `text` untouched — rendering uses textContent).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Browser check** on `PORT=3899 …` with Playwright from `~/projects/aibrowser`: open Secrets, screenshot the section (unavailable broker state), inject a fake `social-draft` via a test account and screenshot the card; read the screenshots back; console has no CSP error or bridge banner.
- [ ] **Step 6: Commit** `"Web: connected accounts panel and LinkedIn draft card"`

### Task 11: End-to-end, docs

**Files:**
- Modify: `README.md` (Connected accounts: what it is, the skill, soft layer in mono-tenant, operator setup pointing at `broker/README.md`), `docs/architecture.md` (broker, store, publish gate, trade-offs), `CLAUDE.md` (map rows for `src/connect-crypto.ts`, `src/connected-accounts.ts`, `src/linkedin.ts`, `src/social-drafts.ts`, `src/account-expiry.ts`, `public/social-card.js`, `context/social-skill/`, `broker/`; HTTP list)

- [ ] **Step 1: E2E against a local broker:** `cd broker && npx wrangler dev` with a test LinkedIn app's credentials (or, without one, a stub LinkedIn served on localhost and `SHADOK_CONNECT_BROKER=http://127.0.0.1:8787`); instance on 3899. Connect → account appears; an agent runs `social.mjs post` → card → Publish → post URL (or stub URN); `grep -r <token> ~/.shadok-ai/connected-accounts/*.log.jsonl` and the agent's transcript → nothing. Confirm `curl -s -o /dev/null -w '%{http_code}' localhost:3789/` is `200` before and after.
- [ ] **Step 2: Docs** as listed.
- [ ] **Step 3:** `npm run build && npm test` — all green.
- [ ] **Step 4: Commit** `"Docs: connected accounts and the LinkedIn broker"` — **end of PR 2**.
