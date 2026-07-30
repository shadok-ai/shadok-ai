# Telegram bot web configuration — design

**Date:** 2026-07-27
**Status:** approved (brainstorming)
**Related:** `2026-07-23-telegram-design.md`, `src/telegram.ts`, `src/config.ts`, `src/server.ts`, `public/index.html`

## Problem

The Telegram bot token can only be set from the CLI (first-run prompt in
`setup-prompt.ts`, `--no-telegram`, or the `TELEGRAM_BOT_TOKEN` env var). It is
read **once at server boot** by `startTelegram`. Changing the token, the allowed
chats, or turning the bot off means editing `~/.shadok-ai/config.json` by hand
and **restarting the server** — which kills all live PTY sessions (invariant #7).

We want to configure the bot from the web cockpit: set/replace/remove the token,
toggle the bridge on/off, manage the allowed-chats list, and see live status —
all applied **hot**, without restarting the server.

## Goals

- Set / replace / remove the bot token from the UI (write-only, never re-shown).
- Toggle the Telegram bridge on/off at runtime (token preserved when off).
- Manage the allowed-chats list (`TELEGRAM_ALLOWED_CHATS` equivalent) from the UI.
- Show live status: connected `@username`, bound board group, token errors.
- Zero server restart; no live session is interrupted.

## Non-goals

- Doing the group `/setup` binding from the UI (still done in Telegram). The
  panel *displays* the bound group but does not create the binding.
- Multi-bot per directory (still one bot per launch dir).
- Exposing the token in cleartext (write-only only).

## Architecture

### Config is the source of truth (env becomes an override)

Today the server reads `process.env.TELEGRAM_BOT_TOKEN` directly. We make
`config.json` (per launch dir) the source of truth so UI edits take effect, and
keep the env var as a boot-time override.

`src/config.ts` — extend `Config` with two per-cwd sibling maps (leave the
existing `tokens[cwd]` untouched so the legacy-token migration keeps working):

```ts
export interface Config {
  // … existing …
  tokens?: Record<string, string | null>;       // bot token (unchanged)
  telegramAllowed?: Record<string, string[]>;    // allowed chats, per cwd
  telegramEnabled?: Record<string, boolean>;     // on/off switch, per cwd
}
```

New helper:

```ts
export interface TelegramConfig {
  token: string | null;      // effective token (env override wins)
  envOverride: boolean;      // token came from TELEGRAM_BOT_TOKEN
  enabled: boolean;          // bridge on/off (default true when a token exists)
  allowedChats: string[];    // env override wins if TELEGRAM_ALLOWED_CHATS set
}

export function telegramConfig(cfg: Config, cwd: string,
  env?: NodeJS.ProcessEnv): TelegramConfig;
```

Rules:
- `token`: `env.TELEGRAM_BOT_TOKEN` if set (→ `envOverride: true`), else
  `cfg.tokens[cwd]`.
- `enabled`: `cfg.telegramEnabled[cwd]` if defined, else `true`. A `false` value
  stops the bridge but the token stays stored. No token ⇒ effectively off.
- `allowedChats`: `env.TELEGRAM_ALLOWED_CHATS` (comma-split) if set, else
  `cfg.telegramAllowed[cwd] ?? []`.

### Hot-restartable bridge

`startTelegram` currently returns `void` and reads env directly. Refactor:

- Signature becomes `startTelegram(port, authCookie?): TelegramHandle` where
  `TelegramHandle = { stop(): void }`.
- It reads its token / allowedChats / enabled from `telegramConfig(loadConfig(),
  process.cwd())` instead of the env directly. If `!enabled || !token`, it
  returns a no-op handle (nothing polling).
- `stop()` must cleanly halt the `getUpdates` long-poll loop (a shared
  `stopped` flag checked around/after each poll, plus aborting/awaiting the
  in-flight fetch) and close every internal WS `Bridge`. This is critical:
  two overlapping `getUpdates` loops against the same bot get a Telegram
  **409 Conflict**. `stop()` then a fresh `startTelegram` must never leave two
  loops alive.

`server.ts` keeps the handle:

```ts
let tgBridge: TelegramHandle = startTelegram(port, cookie);
function restartTelegram() {
  tgBridge.stop();
  tgBridge = startTelegram(port, cookie);
}
```

### Endpoint `/telegram` (behind the GUI password gate)

**`GET /telegram`** → current state, token never returned:

```jsonc
{
  "hasToken": true,
  "enabled": true,
  "running": true,          // a bridge is actually polling right now
  "username": "@MyBot",     // from getMe; null if no/invalid token
  "tokenError": null,       // e.g. "401 Unauthorized" when getMe fails
  "boundGroup": { "chatId": -100, "title": "Board" } | null,
  "allowedChats": ["123", "-100"],
  "envOverride": false      // token forced by env → token field read-only in UI
}
```

`username`/`tokenError` come from a `getMe` call made when the handler runs (or a
value cached by the running bridge). `boundGroup` comes from the persisted
Telegram group binding (`loadTgGroup()` / channel registry).

**`PUT /telegram`** → apply a patch, then `restartTelegram()`, then return the
fresh `GET`-shaped state (re-runs `getMe` so the UI confirms `@username`):

```jsonc
{ "token": "12345:AB", "enabled": true, "allowedChats": ["-100"] }
```

- `token`: `string` = set; `""` or `null` = remove; **absent = unchanged**
  (write-only; the UI never sends the old value back).
- `enabled` / `allowedChats`: absent = unchanged.
- Writes `config.json` (mode 600 via `saveConfig`), restarts the bridge.
- If `envOverride` is active and the patch tries to change `token`: respond
  `403` with a message; other fields still apply.

### UI — header button + overlay panel (`public/index.html`)

A `Telegram` button in the header (next to `Profiles`) opens an overlay built on
the existing Secrets/Profiles pattern (`#…Overlay` + `#…Panel` + `.sec-head` /
`.sec-note`, a `✕` close button, GET-on-open, PUT-on-change).

Panel contents:
- **Status line**: a dot (green = `running && username`, orange = token present
  but `tokenError`, grey = off / no token) + `@username`, and the bound group
  name (or "no group bound — run /setup in your Telegram group").
- **Enabled toggle** → `PUT { enabled }`.
- **Token**: write-only input + `Save` (`PUT { token }`) and `Remove`
  (`PUT { token: "" }`). Never shows the current value; placeholder only. When
  `envOverride`, the input is disabled with a "set by environment variable" note.
- **Allowed chats**: editable list (vide = tous). `+` add / `✕` remove →
  `PUT { allowedChats }`.
- A note: "applies live, without interrupting running sessions."

Every mutation re-renders from the PUT response so `@username` / status update
immediately.

## Data flow

1. User opens the panel → `GET /telegram` → render.
2. User edits a field → `PUT /telegram` with only the changed key.
3. Server writes `config.json`, `stop()`s the old bridge, `startTelegram()`s a
   new one from the fresh config, runs `getMe`, returns the new state.
4. Panel re-renders. Web sessions and PTY processes are untouched.

## Error handling

- Invalid token: `getMe` fails → `tokenError` populated, dot orange, bridge not
  polling (or polling and 401ing — either way surfaced). Token still stored so
  the user can fix it.
- `envOverride` + token change attempt → `403`, explained inline in the panel.
- `PUT` with a malformed body → `400`, config untouched, bridge untouched.
- `stop()`/restart must be race-safe: never two `getUpdates` loops (→ Telegram
  409). Guarded by the `stopped` flag + awaiting the in-flight poll.

## Testing

Pure/unit tests (matching the existing style in `telegram.ts` / `config.ts`):
- `telegramConfig`: env override precedence (token + allowedChats), `enabled`
  default (undefined → true, explicit false), no-token ⇒ off.
- PUT patch merge: absent keys unchanged; `token: ""`/`null` removes; env
  override blocks token change but allows other fields.
- GET/PUT response never contains the raw token.
- Bridge lifecycle: `stop()` sets the stopped flag and no further poll fires;
  a start-after-stop does not leave a second loop (assert single active loop).

Manual verification after build + tmux restart:
- Set a token from the UI → dot goes green, `@username` shows, bot answers in
  Telegram, **without** a server restart and with a live session still running.
- Toggle off → bot stops; toggle on → resumes. Remove token → grey.

## Rollout / invariants touched

- Invariant #7 (don't restart the server) is *upheld*: this is the mechanism
  that avoids a restart. Only the bridge is torn down and recreated.
- Legacy `migrateLegacyToken` path is untouched (`tokens[cwd]` unchanged).
- Env var behaviour preserved: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_CHATS`
  still win when set, and lock the token field in the UI.
