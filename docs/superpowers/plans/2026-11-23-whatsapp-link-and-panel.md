# WhatsApp step 1 — the seam, linking and the panel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin links a WhatsApp number to the instance from the cockpit, always sees the true state of that link, and can unlink it. No message is handled yet.

**Architecture:** Everything that knows a WhatsApp library sits behind `WaTransport`. A pure reducer owns the link's state; a small server module owns one transport per instance and exposes that state over three admin endpoints; the panel renders exactly one state at a time by polling. A fake transport makes all of it testable, and drivable in a browser, with no phone.

**Tech Stack:** TypeScript, ESM, Node 20, `node:test`. `baileys` (pinned exactly) and `qrcode` as **optionalDependencies**, loaded by dynamic `import()`.

**Spec:** `docs/superpowers/specs/2026-11-23-whatsapp-open-dm-design.md` — read it whole first; this plan covers its "Suggested order of work", step 1 only. Steps 2 and 3 get their own plans.

## Global Constraints

- Read `CLAUDE.md` first and follow it: English everywhere in the repo, comments explain why, docs ship in the same PR, verify in a browser on a side port, never touch port 3789.
- The server and the panel import `src/wa-transport.ts`, never a library. Only `src/wa-baileys.ts` may `import("baileys")`.
- A missing or failing library must leave boot, the cockpit and Telegram untouched (spec constraint 2). `npm ci --omit=optional && npm run build && npm test` must pass.
- The feature is refused unless the instance is multi-tenant AND its groups are migrated (spec constraint 10). Reuse `isolationRefusal`; add the migrated half next to it, do not fork it.
- Session directory: `~/.shadok-ai/whatsapp/<instanceKey>/`, created `0700`, files `0600`. Never logged, never in an agent's env.
- Every write endpoint is admin-only AND browser-only (`accountAdmin(req, res, true, …)`, as `PUT /telegram`). The QR payload is returned only to a signed-in person's browser, never to a caller authenticated by `x-shadok-session-key` (spec constraint 9).
- The QR payload, phone numbers and message bodies never reach a log line. A number is logged masked (`336…93`).
- Every inline `<script>` keeps `__CSP_NONCE__`; no inline handler; no external URL (invariants 12 and 10). New bridged ESM names get a stub.
- `src/telegram.ts` behaviour does not change. `Channel.telegram` is not touched in this step.
- No real phone number, account name or instance name in code, tests, fixtures or docs. Fixtures: `Ada's shop`, `33600000000`.

## Review Focus

- **The "restart required" close right after a scan** is the normal end of linking: the state must go Linking → Connected and never show a failure in between.
- **A QR code nobody scans**: linking expires back to Not linked, the transport is stopped, nothing keeps reconnecting in the background.
- **A dead socket without a logout**: the state leaves Connected within a bounded time (a liveness watchdog), it does not sit on a stale "Connected".
- **Unlink while reconnecting, and a double click on Link**: one transport at most, ever; the stored session is gone after Unlink even if the network call to log out failed.
- **A server restart while linked**: boot finds the stored session and reconnects without a QR; with the library absent it shows Unavailable and does not delete the session.

---

### Task 1: The link's state, as a pure reducer

**Files:**
- Create: `src/wa-link.ts`
- Test: `test/wa-link.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WaAccount { id: string; name?: string; phone?: string }
  export type WaLinkState =
    | { phase: "unavailable"; reason: string }
    | { phase: "unlinked" }
    | { phase: "linking"; startedAt: number; qr?: string; qrExpiresAt?: number }
    | { phase: "connected"; account: WaAccount; linkedAt: number; connectedAt: number; lastSeenAt: number }
    | { phase: "reconnecting"; account: WaAccount; linkedAt: number; lostAt: number; attempt: number }
    | { phase: "logged-out"; account?: WaAccount; at: number; detail: string };
  export type WaLinkEvent =
    | { type: "link-requested" } | { type: "cancel" } | { type: "unlinked" }
    | { type: "qr"; payload: string; ttlMs: number }
    | { type: "open"; account: WaAccount }
    | { type: "alive" }
    | { type: "close"; reason: "restart" | "lost" | "logged-out" | "error"; detail?: string }
    | { type: "stored-session"; account: WaAccount; linkedAt: number }
    | { type: "tick" } | { type: "unavailable"; reason: string };
  export const LINK_TIMEOUT_MS = 3 * 60_000;
  export const LIVENESS_MS = 90_000;
  export function linkReduce(s: WaLinkState, e: WaLinkEvent, now: number): WaLinkState;
  /** Delay before reconnect attempt n (1-based): 2s, 4s, 8s … capped at 60s. */
  export function reconnectDelayMs(attempt: number): number;
  /** What the panel may see. `qr` is included only when `forPerson` is true. */
  export function linkView(s: WaLinkState, now: number, forPerson: boolean): Record<string, unknown>;
  export function maskPhone(p: string | undefined): string | undefined;
  ```

- [ ] **Step 1: Write the failing tests** — one per rule: `link-requested` from `unlinked`/`logged-out` → `linking`, ignored from `connected`; `qr` sets `qr` and `qrExpiresAt = now + ttlMs`; `close{restart}` while `linking` stays `linking`; `open` → `connected` with `linkedAt = now` when coming from `linking` and the stored `linkedAt` when coming from `reconnecting`; `tick` in `linking` past `LINK_TIMEOUT_MS` → `unlinked`; `tick` in `connected` with `now - lastSeenAt > LIVENESS_MS` → `reconnecting{attempt:1}`; `alive` refreshes `lastSeenAt`; `close{lost|error}` in `connected` → `reconnecting`, in `reconnecting` → `attempt + 1`; `close{logged-out}` from anywhere → `logged-out` keeping the account; `unlinked` and `cancel` → `unlinked`; `stored-session` → `reconnecting{attempt:0}`; `unavailable` → `unavailable` from anywhere; `reconnectDelayMs(1..8)` = 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000; `linkView(linking, now, false)` has no `qr` key and `linkView(…, true)` has it; `maskPhone("33600000000") === "336…00"`.
- [ ] **Step 2: Run** `TMUX= node --import tsx --test test/wa-link.test.ts` — expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/wa-link.ts` as plain functions over the union, no I/O, no timers.
- [ ] **Step 4: Run the test** — expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: The transport seam, the session directory and a fake

**Files:**
- Create: `src/wa-transport.ts`, `src/wa-fake.ts`
- Test: `test/wa-transport.test.ts`

**Interfaces:**
- Consumes: `WaAccount` from Task 1.
- Produces:
  ```ts
  // src/wa-transport.ts
  export type WaTransportEvent =
    | { type: "qr"; payload: string; ttlMs: number }
    | { type: "open"; account: WaAccount }
    | { type: "alive" }
    | { type: "close"; reason: "restart" | "lost" | "logged-out" | "error"; detail?: string };
  export interface WaTransport {
    /** Connect (or resume the stored session). Events until `stop`. */
    start(on: (e: WaTransportEvent) => void): Promise<void>;
    /** Log this device out on WhatsApp's side. May reject; the caller wipes the session either way. */
    logout(): Promise<void>;
    stop(): Promise<void>;
  }
  export type WaTransportFactory = (o: { sessionDir: string }) => Promise<WaTransport>;
  export function waSessionDir(home: string, instanceKey: string): string;
  /** mkdir -p with 0700, re-asserted when the directory already exists. */
  export function ensureSessionDir(dir: string): void;
  /** Is there a stored session, and whose? Reads only what the transport wrote through `rememberAccount`. */
  export function storedAccount(dir: string): { account: WaAccount; linkedAt: number } | null;
  export function rememberAccount(dir: string, account: WaAccount, linkedAt: number): void;
  /** Remove the directory's content. Never follows a symlink out of it. */
  export function wipeSession(dir: string): void;
  // src/wa-fake.ts
  export interface FakeScript { scan(account?: WaAccount): void; drop(): void; goSilent(): void; removeFromPhone(): void; rotateQr(): void }
  export function makeFakeTransport(): { factory: WaTransportFactory; script: FakeScript; starts: number; stops: number };
  ```
  The fake emits a `qr` on `start` when its session directory holds no account, `open` when it does; `scan()` emits `close{restart}` and, on the next `start`, `open`.

- [ ] **Step 1: Write the failing tests** — `ensureSessionDir` yields mode `0700` (also on a pre-existing `0755` dir); `rememberAccount` then `storedAccount` round-trips and the file is `0600`; `wipeSession` empties the directory and does not delete a file a symlink inside it points to; the fake follows its script (qr → scan → restart → open; `removeFromPhone` → `close{logged-out}`; `goSilent` emits nothing further, not even `alive`).
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement** both modules. `storedAccount` reads a small `account.json` this module owns, not the library's files.
- [ ] **Step 4: Run** — expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: The instance's WhatsApp handle

**Files:**
- Create: `src/whatsapp.ts`
- Test: `test/whatsapp-handle.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  ```ts
  export interface WhatsAppHandle {
    state(): WaLinkState;
    link(): { ok: true } | { ok: false; error: string };
    cancel(): Promise<void>;
    unlink(): Promise<void>;
    stop(): Promise<void>;
  }
  export function startWhatsApp(o: {
    sessionDir: string;
    refusal: string | null;                       // capability refusal, or null when allowed
    loadFactory: () => Promise<WaTransportFactory>; // rejects when the library is absent
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => { cancel(): void };
    log?: (line: string) => void;
  }): WhatsAppHandle;
  ```
  Rules: with a `refusal`, state is `unavailable{reason: refusal}` and `link()` returns it. With a stored session, it loads the factory and starts at once (`stored-session`); a factory that rejects gives `unavailable` and leaves the session on disk. `link()` is idempotent while linking or connected. One transport at most: every start is preceded by the previous one's `stop()`. `close{restart}` restarts immediately; `lost`/`error` restart after `reconnectDelayMs`; `logged-out` stops for good. A 15-second `tick` drives the reducer's two timeouts and, on leaving `linking` by timeout, stops the transport. `unlink()` = `logout()` (errors swallowed and logged) → `stop()` → `wipeSession` → `unlinked`. One log line per phase change, phone masked, never the QR.

- [ ] **Step 1: Write the failing tests** with the fake transport and injected clock/timers — the five Review Focus cases, each as its own test, plus: refusal; library absent with and without a stored session; `open` calls `rememberAccount`; the log lines contain neither the QR payload nor the full number.
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: The library adapter

**Files:**
- Create: `src/wa-baileys.ts`
- Modify: `package.json` (`optionalDependencies`: `baileys` pinned to the exact version the spike ran, `7.0.0-rc14`, and `qrcode`)
- Test: `test/wa-baileys.test.ts`

**Interfaces:**
- Produces: `export const loadBaileysFactory: () => Promise<WaTransportFactory>` and the pure helpers it is built from: `closeReasonOf(statusCode: number | undefined): "restart" | "lost" | "logged-out" | "error"` (515 → restart, 401 → logged-out, 408/428/503 → lost, else error) and `accountOf(me: { id?: string; name?: string } | undefined): WaAccount | null` (digits before `:` or `@` become `phone`).
- Adapter rules, from the spike: `useMultiFileAuthState(sessionDir)`, `syncFullHistory: false`, `markOnlineOnConnect: false`, a silent logger, `Browsers.ubuntu("Chrome")`; QR `ttlMs` 60 000 for the first payload of a start and 20 000 after; every inbound stanza or `connection.update` emits `alive`; never call `requestPairingCode` (broken upstream).

- [ ] **Step 1: Write the failing tests** for the two pure helpers, and a source check that no other file under `src/` contains `import("baileys")` or `from "baileys"`.
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement.** The dynamic import's failure message becomes the `unavailable` reason, shortened to one line.
- [ ] **Step 4: Run the tests, then** `npm ci --omit=optional --no-audit --no-fund && npm run build && TMUX= node --import tsx --test --test-timeout=120000 test/*.ts` — expected: all PASS without the library installed. Then `npm ci` again.
- [ ] **Step 5: Commit.**

### Task 5: Endpoints

**Files:**
- Modify: `src/server.ts` (boot wiring beside `startTelegram`; routes beside `/telegram`)
- Test: `test/whatsapp-routes.test.ts` (source-level, like `test/tg-guests-routes.test.ts`)

**Interfaces:**
- `GET /whatsapp` — admin. Returns `linkView(state, now, forPerson)` where `forPerson` is true only for a cookie-authenticated person (`cookieAccount`), plus `qrSvg` (rendered server-side with `qrcode`, same condition) and `fake: true` when the fake transport is in use.
- `POST /whatsapp/link` — admin, browser-only. Starts linking; `409` with the reason when refused or unavailable.
- `DELETE /whatsapp/link` — admin, browser-only. Cancels while linking, unlinks otherwise.
- Boot: `refusal` = the capability refusal, extended with the not-migrated case; `loadFactory` = `loadBaileysFactory`, or the fake when `SHADOK_WA_FAKE=1` (side-instance verification only — it also registers `POST /whatsapp/fake/:action` for `scan`, `drop`, `goSilent`, `removeFromPhone`, refused unless that env var is set). Stop the handle on shutdown where Telegram's is stopped.

- [ ] **Step 1: Write the failing tests** — the two writes use `accountAdmin(req, res, true`; the GET computes `forPerson` from `cookieAccount`; the fake routes are behind the env check; `startWhatsApp` receives the refusal.
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite and `npm run build`** — expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: The panel

**Files:**
- Create: `public/wa-panel.js` (pure, ESM, bridged)
- Modify: `public/index.html`
- Test: `test/wa-panel.test.ts`; extend `test/esm-bridge.test.ts` and `test/csp.test.ts` as they require

**Interfaces:**
- Produces: `waPanelModel(view, now) → { tone: "off"|"wait"|"ok"|"err", status: string, blocks: string[], actions: string[] }` — the whole decision of what a state shows (`blocks` among `intro`, `warning`, `qr`, `steps`, `identity`, `since`, `lost`, `removed`, `reason`; `actions` among `link`, `cancel`, `unlink`, `relink`, `retry`). Durations are worded from `now` ("connection lost 6 min ago").
- The panel: a header button beside Telegram's, admin-only, an `.overlay` popin. It polls `GET /whatsapp` every 2 s while open and stops when closed. The six states of the approved mockup, one at a time; the QR is the server's SVG inserted through `DOMPurify`; the ban warning is shown in Not linked and stays reachable when linked. The "Open DMs" block of the mockup belongs to step 2 and is NOT built here.

- [ ] **Step 1: Write the failing tests** for `waPanelModel`: each of the six phases gives the expected tone, blocks and actions; `linking` without `qr` shows `steps` and no `qr`; `unavailable` never offers `link`.
- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement** the module and the markup/wiring.
- [ ] **Step 4: Verify in a browser.** Side instance on a free port with `SHADOK_WA_FAKE=1`, in the mode the capability gate accepts (see `CLAUDE.md`, "Running YOUR build"; never port 3789). With Playwright, screenshot and READ BACK each state: not linked → link → QR shown → `scan` → connected → `goSilent` → reconnecting within the liveness bound → `removeFromPhone` → unlinked remotely → link again; then a run with the library absent → unavailable. Capture the console: no CSP violation, no failed import.
- [ ] **Step 5: Commit.**

### Task 7: Docs

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/invariants.md` and its index in `CLAUDE.md`

- [ ] **Step 1:** README — a "WhatsApp" section beside Telegram's: what linking is, the ban warning, "one number, one instance", that only linking exists so far. Architecture — module rows for the five new files and the link's states. Invariants — "only the adapter imports the library; a missing library is a panel state, never a boot failure".
- [ ] **Step 2:** Run the doc-locking tests the suite has, then commit.

## After the last task

Open a PR against `main` titled for what it delivers. Say plainly in its body what was verified in a browser with the fake transport and that **linking a real number has not been exercised by this PR** — that check needs a person with the test phone, and is requested from the admin once the PR is up.
