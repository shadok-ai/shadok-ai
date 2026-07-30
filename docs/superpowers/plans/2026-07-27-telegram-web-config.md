# Telegram Web Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the Telegram bot (token, on/off, allowed chats, status) from the web cockpit, applied hot without restarting the server.

**Architecture:** Make `config.json` (per launch dir) the source of truth for the Telegram bridge (env stays a boot override). Refactor `startTelegram` into a hot-restartable handle with a clean `stop()`. Add a `/telegram` GET/PUT Express endpoint that patches config and tears down + recreates the bridge in-process. Add a header overlay panel mirroring the Secrets/Profiles pattern.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import extensions), Node 20, Express, `ws`, `node --test` + `tsx` for tests, framework-less `public/index.html`.

## Global Constraints

- TypeScript ESM; **all local imports use `.js` extensions** (NodeNext).
- Comments explain **why**, mixed FR/EN, matching surrounding style.
- The bot token is a secret: **never** returned by any endpoint, never logged, never re-shown in the UI (write-only).
- `saveConfig` writes `~/.shadok-ai/config.json` at mode `600` — do not weaken.
- Invariant #7: **no server restart** — only the bridge is stopped and recreated. Closing a Telegram bridge must **not** end the underlying live session (close the WS, never send `stop`).
- Only two `getUpdates` long-poll loops against one bot = Telegram **409 Conflict**. `stop()` must abort the in-flight long-poll so a restart never overlaps.
- One bot per launch directory (unchanged). `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_CHATS` env vars still win when set and lock the token field in the UI.
- Tests run with `npm test`; build with `npm run build` (must pass `tsc`).

---

## File Structure

- `src/config.ts` — **Modify.** Add `telegramAllowed` / `telegramEnabled` to `Config`; add pure helpers `telegramConfig()` and `applyTelegramPatch()`.
- `test/config.test.ts` — **Modify.** Unit tests for the two new helpers.
- `src/telegram.ts` — **Modify.** `startTelegram` reads from `telegramConfig`, returns a `TelegramHandle` with `stop()` + `status()`; add `probeToken()`.
- `src/server.ts` — **Modify.** Keep the handle, add `restartTelegram()`, add `GET`/`PUT /telegram`.
- `public/index.html` — **Modify.** Header `Telegram` button + overlay panel + fetch wiring.

---

## Task 1: Config source-of-truth helpers

**Files:**
- Modify: `src/config.ts` (add fields to `Config`, add `telegramConfig`, `applyTelegramPatch`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: existing `Config`, `saveConfig` (unused here — helpers are pure).
- Produces:
  - `interface TelegramConfig { token: string | null; envOverride: boolean; enabled: boolean; allowedChats: string[] }`
  - `function telegramConfig(cfg: Config, cwd: string, env?: NodeJS.ProcessEnv): TelegramConfig`
  - `interface TelegramPatch { token?: string | null; enabled?: boolean; allowedChats?: string[] }`
  - `function applyTelegramPatch(cfg: Config, cwd: string, patch: TelegramPatch, envOverride: boolean): Config` — returns a **new** `Config` (pure; caller persists). When `envOverride` is true, a `token` key in the patch is ignored (env wins).

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts`:

```ts
import { telegramConfig, applyTelegramPatch } from "../src/config.js";

test("telegramConfig: env token wins and marks envOverride", () => {
  const c = telegramConfig({ tokens: { "/x": "cfg" } }, "/x", { TELEGRAM_BOT_TOKEN: "env" } as any);
  assert.equal(c.token, "env");
  assert.equal(c.envOverride, true);
});

test("telegramConfig: falls back to this dir's config token, no override", () => {
  const c = telegramConfig({ tokens: { "/x": "cfg" } }, "/x", {} as any);
  assert.equal(c.token, "cfg");
  assert.equal(c.envOverride, false);
});

test("telegramConfig: enabled defaults to true, explicit false respected", () => {
  assert.equal(telegramConfig({}, "/x", {} as any).enabled, true);
  assert.equal(telegramConfig({ telegramEnabled: { "/x": false } }, "/x", {} as any).enabled, false);
});

test("telegramConfig: allowedChats from env (comma-split) wins over config", () => {
  const c = telegramConfig(
    { telegramAllowed: { "/x": ["1"] } },
    "/x",
    { TELEGRAM_ALLOWED_CHATS: "7, 8 ,9" } as any,
  );
  assert.deepEqual(c.allowedChats, ["7", "8", "9"]);
});

test("telegramConfig: allowedChats from config when no env, [] default", () => {
  assert.deepEqual(telegramConfig({ telegramAllowed: { "/x": ["1", "2"] } }, "/x", {} as any).allowedChats, ["1", "2"]);
  assert.deepEqual(telegramConfig({}, "/x", {} as any).allowedChats, []);
});

test("applyTelegramPatch: sets token, enabled, allowedChats per cwd; absent keys untouched", () => {
  const out = applyTelegramPatch({ tokens: { "/x": "old" } }, "/x", { enabled: false }, false);
  assert.equal(out.telegramEnabled!["/x"], false);
  assert.equal(out.tokens!["/x"], "old"); // token key absent → unchanged
});

test("applyTelegramPatch: empty-string/null token removes it", () => {
  assert.equal(applyTelegramPatch({ tokens: { "/x": "t" } }, "/x", { token: "" }, false).tokens!["/x"], null);
  assert.equal(applyTelegramPatch({ tokens: { "/x": "t" } }, "/x", { token: null }, false).tokens!["/x"], null);
});

test("applyTelegramPatch: envOverride ignores token but still applies other fields", () => {
  const out = applyTelegramPatch({ tokens: { "/x": "keep" } }, "/x", { token: "new", allowedChats: ["9"] }, true);
  assert.equal(out.tokens!["/x"], "keep"); // env wins → token untouched
  assert.deepEqual(out.telegramAllowed!["/x"], ["9"]); // other fields still applied
});

test("applyTelegramPatch: does not mutate the input config", () => {
  const input = { tokens: { "/x": "old" } };
  applyTelegramPatch(input, "/x", { token: "new" }, false);
  assert.equal(input.tokens["/x"], "old");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 telegramConfig`
Expected: FAIL — `telegramConfig`/`applyTelegramPatch` are not exported.

- [ ] **Step 3: Add the fields and helpers**

In `src/config.ts`, extend the `Config` interface (right after the `tokens` field):

```ts
  /** Per launch-directory allowed Telegram chats (env TELEGRAM_ALLOWED_CHATS wins). */
  telegramAllowed?: Record<string, string[]>;
  /** Per launch-directory on/off switch for the Telegram bridge (default on). */
  telegramEnabled?: Record<string, boolean>;
```

Then add, near `effectiveToken`:

```ts
export interface TelegramConfig {
  token: string | null;   // effective token (env override wins)
  envOverride: boolean;   // token came from TELEGRAM_BOT_TOKEN
  enabled: boolean;       // bridge on/off (default true)
  allowedChats: string[]; // env override wins if TELEGRAM_ALLOWED_CHATS set
}

/** Resolve the effective Telegram config for `cwd`: env overrides config. */
export function telegramConfig(cfg: Config, cwd: string, env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const envTok = env.TELEGRAM_BOT_TOKEN;
  const token = envTok ?? cfg.tokens?.[cwd] ?? null;
  const envChats = env.TELEGRAM_ALLOWED_CHATS;
  const allowedChats = envChats
    ? envChats.split(",").map((s) => s.trim()).filter(Boolean)
    : cfg.telegramAllowed?.[cwd] ?? [];
  return {
    token,
    envOverride: Boolean(envTok),
    enabled: cfg.telegramEnabled?.[cwd] ?? true,
    allowedChats,
  };
}

export interface TelegramPatch {
  token?: string | null;
  enabled?: boolean;
  allowedChats?: string[];
}

/**
 * Merge a UI patch into a copy of `cfg` (pure — caller persists). A token is
 * stored only when NOT under an env override; "" / null removes it. Absent keys
 * are left untouched.
 */
export function applyTelegramPatch(cfg: Config, cwd: string, patch: TelegramPatch, envOverride: boolean): Config {
  const next: Config = {
    ...cfg,
    tokens: { ...cfg.tokens },
    telegramAllowed: { ...cfg.telegramAllowed },
    telegramEnabled: { ...cfg.telegramEnabled },
  };
  if (patch.token !== undefined && !envOverride) {
    next.tokens![cwd] = patch.token ? patch.token : null;
  }
  if (patch.enabled !== undefined) next.telegramEnabled![cwd] = patch.enabled;
  if (patch.allowedChats !== undefined) next.telegramAllowed![cwd] = patch.allowedChats;
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS (all config tests green).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "config: telegramConfig + applyTelegramPatch (UI-editable bot settings)"
```

---

## Task 2: Hot-restartable Telegram bridge

**Files:**
- Modify: `src/telegram.ts` (`startTelegram` return type, config source, `stop()`, `status()`, `probeToken`, poll abort)

**Interfaces:**
- Consumes: `telegramConfig` (Task 1), existing `loadConfig`, `loadTgGroup`, `bridges` Map, `poll`, `connect`, `reconcileWebChannels`, `tg`.
- Produces:
  - `interface TelegramHandle { stop(): void; running(): boolean; status(): { username: string | null; tokenError: string | null } }`
  - `startTelegram(port: number, authCookie?: string): TelegramHandle`
  - `async function probeToken(token: string | null): Promise<{ username: string | null; error: string | null }>` — one `getMe`; returns `{ username: "@name", error: null }` or `{ username: null, error: "…" }`. No token → `{ username: null, error: null }`.

- [ ] **Step 1: Read the current control flow**

Read `src/telegram.ts` lines ~261–360 (`startTelegram` open, `tg` helper, `bridges`) and ~778–895 (`poll`, `reconcileWebChannels` interval, `connect`, module close). Confirm: `poll` reschedules via `setTimeout(poll, …)`; `reconcileWebChannels` runs under `setInterval(…, 5000)`; `connect` retries via `setTimeout`.

- [ ] **Step 2: Read config instead of env at the top of `startTelegram`**

Replace the current env read:

```ts
export function startTelegram(port: number, authCookie?: string): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const api = `https://api.telegram.org/bot${token}`;
  const allowed = (process.env.TELEGRAM_ALLOWED_CHATS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
```

with a config-sourced version returning a handle even when idle:

```ts
export interface TelegramHandle {
  stop(): void;
  running(): boolean;
  status(): { username: string | null; tokenError: string | null };
}

const NOOP_HANDLE: TelegramHandle = { stop() {}, running: () => false, status: () => ({ username: null, tokenError: null }) };

export function startTelegram(port: number, authCookie?: string): TelegramHandle {
  const cfg = telegramConfig(loadConfig(), process.cwd());
  if (!cfg.enabled || !cfg.token) return NOOP_HANDLE; // off or no token → nothing polling
  const token = cfg.token;
  const api = `https://api.telegram.org/bot${token}`;
  const allowed = cfg.allowedChats;
  let stopped = false;
  let polling = false;
  let botUsername: string | null = null;
  let tokenError: string | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let pollAbort: AbortController | null = null;
```

Add the import at the top of the file:

```ts
import { SHADOK_DIR, loadConfig, telegramConfig } from "./config.js";
```

(Adjust the existing `import { SHADOK_DIR } from "./config.js";` line to this.)

- [ ] **Step 3: Give `tg` an abort signal, and make `poll` abortable + stop-aware**

Change the `tg` helper signature to accept an optional signal:

```ts
  const tg = async (method: string, params: object, signal?: AbortSignal): Promise<any> => {
    try {
      const r = await fetch(`${api}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
      return await r.json();
    } catch {
      return null;
    }
  };
```

Rewrite `poll` (the long-poll loop) to be abortable and to stop rescheduling once stopped:

```ts
  let offset = 0;
  const poll = async () => {
    if (stopped) return;
    pollAbort = new AbortController();
    const res = await tg(
      "getUpdates",
      { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
      pollAbort.signal,
    );
    if (stopped) return; // aborted mid-flight during stop(); do not reschedule
    if (res?.ok && Array.isArray(res.result)) {
      for (const u of res.result) {
        offset = u.update_id + 1;
        handleUpdate(u).catch(() => {});
      }
    }
    setTimeout(poll, res ? 0 : 3000); // back off on network error
  };
```

- [ ] **Step 4: Track poll state, capture status in `connect`, store the reconcile interval**

In `connect`, set the tracked state on success and on 401:

```ts
  const connect = async (attempt = 0): Promise<void> => {
    if (stopped) return;
    const me = await tg("getMe", {});
    if (me?.ok) {
      botUsername = `@${me.result.username}`;
      tokenError = null;
      polling = true;
      console.log(`telegram: bot ${botUsername} connected (long-polling)`);
      poll();
      announceUpdateResult();
      reconcileOnBoot().catch(() => {});
      reconcileTimer = setInterval(() => reconcileWebChannels().catch(() => {}), 5000);
      return;
    }
    if (me && me.error_code === 401) {
      tokenError = "401 Unauthorized — check the bot token";
      console.log("telegram: unauthorized — check the bot token");
      return;
    }
    const delay = Math.min(30_000, 2_000 * 2 ** attempt);
    console.log(`telegram: getMe failed (transient), retrying in ${delay / 1000}s`);
    setTimeout(() => connect(attempt + 1), delay);
  };
  connect();
```

- [ ] **Step 5: Return the handle with a clean `stop()`**

At the very end of `startTelegram` (replacing the implicit `void` return), return:

```ts
  return {
    stop() {
      stopped = true;
      polling = false;
      pollAbort?.abort();               // free the in-flight 30s long-poll → no 409 on restart
      if (reconcileTimer) clearInterval(reconcileTimer);
      // Detach Telegram from its live sessions WITHOUT ending them: close the WS
      // client only, never send `stop` (that would kill the session).
      for (const b of bridges.values()) {
        try { b.ws.close(); } catch { /* already closing */ }
      }
      bridges.clear();
    },
    running: () => polling,
    status: () => ({ username: botUsername, tokenError }),
  };
}
```

- [ ] **Step 6: Add `probeToken` (module-level export, after `startTelegram`)**

```ts
/** One-shot getMe against a candidate token — for the /telegram status view. */
export async function probeToken(token: string | null): Promise<{ username: string | null; error: string | null }> {
  if (!token) return { username: null, error: null };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = await r.json();
    if (j?.ok) return { username: `@${j.result.username}`, error: null };
    return { username: null, error: j?.description ?? `HTTP ${r.status}` };
  } catch (e: any) {
    return { username: null, error: e?.message ?? "network error" };
  }
}
```

- [ ] **Step 7: Build to verify the refactor type-checks**

Run: `npm run build 2>&1 | tail -20`
Expected: no `tsc` errors. (The `startTelegram` call site in `server.ts` still compiles — its return value was previously ignored; Task 3 will consume it.)

- [ ] **Step 8: Run the existing Telegram unit tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS — the pure helpers (`bindKey`, `chunk`, …) are unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/telegram.ts
git commit -m "telegram: hot-restartable bridge (config-sourced, stop()/status(), abortable poll)"
```

---

## Task 3: `/telegram` endpoint

**Files:**
- Modify: `src/server.ts` (hold the handle, add `restartTelegram`, add `GET`/`PUT /telegram`)

**Interfaces:**
- Consumes: `startTelegram` → `TelegramHandle`, `probeToken` (Task 2); `loadConfig`, `saveConfig`, `telegramConfig`, `applyTelegramPatch` (Task 1); existing `loadTgGroup`.
- Produces: `GET /telegram` and `PUT /telegram` returning the state shape below.

State shape (token NEVER included):
```jsonc
{ "hasToken": true, "enabled": true, "running": true, "username": "@Bot",
  "tokenError": null, "boundGroup": { "chatId": -100, "title": "Board" }|null,
  "allowedChats": ["-100"], "envOverride": false }
```

- [ ] **Step 1: Import the new symbols and hold the handle**

At the top of `src/server.ts`, extend the imports:

```ts
import { startTelegram, renameTelegramTopic, closeTelegramTopic, probeToken, type TelegramHandle } from "./telegram.js";
import { loadConfig, saveConfig, telegramConfig, applyTelegramPatch } from "./config.js";
import { loadTgGroup } from "./channels.js";
```

(Merge with any existing imports from those modules rather than duplicating.)

Change the bridge start (in the `server.listen` callback, ~line 1151) to keep the handle and add a restart helper. Replace:

```ts
  startTelegram(port, GUI_PASSWORD ? `sk_auth=${INTERNAL_AUTH_TOKEN}` : undefined);
```

with:

```ts
  tgBridge = startTelegram(port, tgCookie());
```

Add near the top of the module scope (after `INTERNAL_AUTH_TOKEN` is defined):

```ts
let tgBridge: TelegramHandle = { stop() {}, running: () => false, status: () => ({ username: null, tokenError: null }) };
const tgCookie = () => (GUI_PASSWORD ? `sk_auth=${INTERNAL_AUTH_TOKEN}` : undefined);
function restartTelegram(): void {
  tgBridge.stop();
  tgBridge = startTelegram(boundPort, tgCookie());
}
```

If a `boundPort` module variable does not already exist, capture the port the server actually bound in the `server.listen(port, …)` callback: `boundPort = port;` (declare `let boundPort = 0;` at module scope). Use `boundPort` in `restartTelegram`.

- [ ] **Step 2: Add a shared state builder**

Add a helper (module scope, e.g. just above the endpoints):

```ts
/** Build the /telegram state view (token is never included). */
async function telegramState() {
  const tc = telegramConfig(loadConfig(), process.cwd());
  const probe = await probeToken(tc.token);
  const groupId = loadTgGroup();
  return {
    hasToken: Boolean(tc.token),
    enabled: tc.enabled,
    running: tgBridge.running(),
    username: probe.username ?? tgBridge.status().username,
    tokenError: probe.error ?? tgBridge.status().tokenError,
    boundGroup: groupId === null ? null : { chatId: groupId, title: null as string | null },
    allowedChats: tc.allowedChats,
    envOverride: tc.envOverride,
  };
}
```

- [ ] **Step 3: Add the GET and PUT routes**

Place next to the other endpoints (e.g. after `/profiles`):

```ts
// Telegram bot config — token/on-off/allowed-chats, applied hot (no restart).
// Behind the GUI password gate like the rest. The token is write-only: never
// returned here, only set/removed.
app.get("/telegram", async (_req, res) => res.json(await telegramState()));
app.put("/telegram", async (req, res) => {
  const b = req.body ?? {};
  const patch: TelegramPatch = {};
  if (typeof b.token === "string" || b.token === null) patch.token = b.token;
  if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
  if (Array.isArray(b.allowedChats))
    patch.allowedChats = b.allowedChats.map((x: unknown) => String(x).trim()).filter(Boolean);

  const cwd = process.cwd();
  const tc = telegramConfig(loadConfig(), cwd);
  if (patch.token !== undefined && tc.envOverride)
    return res.status(403).json({ error: "token is set by the TELEGRAM_BOT_TOKEN environment variable" });

  saveConfig(applyTelegramPatch(loadConfig(), cwd, patch, tc.envOverride));
  restartTelegram();
  res.json(await telegramState());
});
```

Add the `TelegramPatch` type to the config import from Step 1:
`import { loadConfig, saveConfig, telegramConfig, applyTelegramPatch, type TelegramPatch } from "./config.js";`

- [ ] **Step 4: Build**

Run: `npm run build 2>&1 | tail -20`
Expected: no `tsc` errors.

- [ ] **Step 5: Manually verify the endpoint (server running)**

Rebuild + restart the server in its tmux session (per CLAUDE.md), then:

Run: `curl -s localhost:3789/telegram | jq`
Expected: JSON with `hasToken`, `enabled`, `running`, `envOverride` — and **no** `token` field.

Run: `curl -s -X PUT localhost:3789/telegram -H 'content-type: application/json' -d '{"enabled":false}' | jq .enabled`
Expected: `false`. (If a GUI password is set, pass the auth cookie the browser uses.)

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "server: GET/PUT /telegram — hot-apply bot config, token write-only"
```

---

## Task 4: Telegram settings panel (UI)

**Files:**
- Modify: `public/index.html` (header button + overlay panel + wiring)

**Interfaces:**
- Consumes: `GET /telegram`, `PUT /telegram` (Task 3). Reuses existing `.sec-head` / `.sec-note` / overlay CSS from the Secrets/Profiles panels.

- [ ] **Step 1: Add the header button**

In `<header>` (next to `#profilesBtn`, ~line 832):

```html
  <button id="telegramBtn" title="Configure the Telegram bot (token, on/off, allowed chats)">Telegram</button>
```

- [ ] **Step 2: Add the overlay panel**

After the `#profilesOverlay` block (~line 874):

```html
<div id="telegramOverlay" hidden>
  <div id="telegramPanel" class="sec-panel">
    <div class="sec-head">
      <strong>Telegram bot</strong>
      <button id="telegramClose" title="Close">✕</button>
    </div>
    <p class="sec-note" id="tgStatus">…</p>
    <label class="check"><input type="checkbox" id="tgEnabled"><span>Bot enabled</span></label>
    <div class="field">
      <span class="label">Bot token <span class="check-hint">— write-only, never shown</span></span>
      <div style="display:flex;gap:8px">
        <input id="tgToken" placeholder="paste a new token…" autocomplete="off" spellcheck="false" style="flex:1">
        <button id="tgTokenSave">Save</button>
        <button id="tgTokenRemove">Remove</button>
      </div>
    </div>
    <div class="field">
      <span class="label">Allowed chats <span class="check-hint">— empty = everyone</span></span>
      <ul id="tgChats"></ul>
      <form id="tgChatAdd" style="display:flex;gap:8px">
        <input id="tgChatInput" placeholder="chat id, e.g. -1002…" autocomplete="off" spellcheck="false" style="flex:1">
        <button type="submit">Add</button>
      </form>
    </div>
    <p class="sec-note">Applies live — running sessions are not interrupted.</p>
  </div>
</div>
```

- [ ] **Step 3: Wire open/close (mirror the Profiles wiring)**

Find how `profilesBtn`/`profilesClose` toggle `#profilesOverlay.hidden` and add the same for Telegram, calling a `loadTelegram()` on open:

```js
document.getElementById("telegramBtn").onclick = () => {
  document.getElementById("telegramOverlay").hidden = false;
  loadTelegram();
};
document.getElementById("telegramClose").onclick = () =>
  (document.getElementById("telegramOverlay").hidden = true);
```

- [ ] **Step 4: Add render + fetch logic**

Add this script block near the other panel logic:

```js
let tgAllowed = [];
function renderTelegram(s) {
  tgAllowed = s.allowedChats.slice();
  const dot = s.running && s.username ? "🟢" : s.tokenError ? "🟠" : "⚪";
  const who = s.username ? s.username : s.hasToken ? "(token set)" : "no token";
  const grp = s.boundGroup ? ` · group ${s.boundGroup.chatId}` : " · no group bound (run /setup in Telegram)";
  const err = s.tokenError ? ` — ${s.tokenError}` : "";
  document.getElementById("tgStatus").textContent = `${dot} ${who}${grp}${err}`;
  document.getElementById("tgEnabled").checked = s.enabled;
  const tok = document.getElementById("tgToken");
  tok.disabled = s.envOverride;
  tok.placeholder = s.envOverride ? "set by environment variable" : "paste a new token…";
  const ul = document.getElementById("tgChats");
  ul.innerHTML = "";
  for (const c of s.allowedChats) {
    const li = document.createElement("li");
    li.textContent = c + " ";
    const x = document.createElement("button");
    x.textContent = "✕";
    x.onclick = () => putTelegram({ allowedChats: tgAllowed.filter((v) => v !== c) });
    li.appendChild(x);
    ul.appendChild(li);
  }
}
async function loadTelegram() {
  renderTelegram(await (await fetch("/telegram")).json());
}
async function putTelegram(patch) {
  const r = await fetch("/telegram", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (r.ok) renderTelegram(await r.json());
  else alert((await r.json()).error || "update failed");
}
document.getElementById("tgEnabled").onchange = (e) => putTelegram({ enabled: e.target.checked });
document.getElementById("tgTokenSave").onclick = () => {
  const el = document.getElementById("tgToken");
  if (el.value.trim()) { putTelegram({ token: el.value.trim() }); el.value = ""; }
};
document.getElementById("tgTokenRemove").onclick = () => putTelegram({ token: "" });
document.getElementById("tgChatAdd").onsubmit = (e) => {
  e.preventDefault();
  const el = document.getElementById("tgChatInput");
  const v = el.value.trim();
  if (v && !tgAllowed.includes(v)) putTelegram({ allowedChats: [...tgAllowed, v] });
  el.value = "";
};
```

- [ ] **Step 5: Manual verification in the browser**

Rebuild + restart the server (CLAUDE.md tmux command), open http://localhost:3789.
- Click **Telegram** → panel opens, status line populated from `GET /telegram`.
- Paste a valid token → **Save** → dot turns 🟢, `@username` appears, **no** server restart, a running session keeps streaming.
- Untick **Bot enabled** → bot stops answering in Telegram; re-tick → resumes.
- Add / remove an allowed chat → list updates.
- **Remove** token → dot ⚪, `no token`.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "ui: Telegram settings panel (token, on/off, allowed chats, live status)"
```

---

## Self-Review Notes

- **Spec coverage:** token set/replace/remove (Task 3 PUT + Task 4) ✓; on/off toggle (`enabled`, Tasks 1–4) ✓; allowed-chats (Tasks 1,3,4) ✓; live status incl. `@username`/bound group/token error (Task 2 `status`/`probeToken`, Task 3 `telegramState`, Task 4 render) ✓; hot apply, no restart (Task 2 `stop()` + Task 3 `restartTelegram`) ✓; config as source of truth, env override (Task 1) ✓; write-only token, never returned (Task 3 `telegramState` omits token) ✓; 409-safe restart (Task 2 abortable poll) ✓; GUI-password gate (inherited — endpoints sit behind the same middleware as `/secrets`) ✓.
- **Non-goal upheld:** `/setup` binding stays in Telegram; the panel only *displays* `boundGroup`.
- **Type consistency:** `TelegramHandle`, `TelegramConfig`, `TelegramPatch`, `telegramConfig`, `applyTelegramPatch`, `probeToken`, `telegramState`, `restartTelegram`, `tgBridge`, `boundPort` are used with identical signatures across tasks.
- **Known best-effort:** `boundGroup.title` is `null` (chatId only) — fetching the group title via `getChat` is an optional enhancement, not required by the spec.
