# shadok-ai CLI + self-update supervisor — design

Date: 2026-07-23 · Status: approved

## Goal

Ship shadok-ai as an `npx`-runnable CLI so anyone can start the whole cockpit
with one command, be prompted (once) for an optional Telegram bot token, and
keep the instance up to date from Telegram with `/update` — no manual git/build.

## Decisions (locked)

- **Distribution:** published to npm as `shadok-ai`. `npx shadok-ai@latest`
  launches it. (Not a git-clone runner.)
- **Group binding:** the CLI prompts only for the **token**. The board **group
  binds itself via `/setup`** in Telegram (already implemented). No group-ID
  copy-paste.
- **Update model:** a **supervisor self-respawns** the server child. `/update`
  fetches `shadok-ai@latest` and respawns — no external process manager.
- **`/update` auth:** allowed **only from the bound board group**, and further
  gated by `TELEGRAM_ALLOWED_CHATS` when that allowlist is set.

## Architecture — thin supervisor over a managed server install

```
npx shadok-ai@latest                    (supervisor, from the npx cache)
  │  ensure ~/.shadok-ai/app  ──────────▶  npm i shadok-ai@latest  (if absent)
  │  first-run: prompt token → config
  └─ spawn child: node ~/.shadok-ai/app/node_modules/shadok-ai/dist/server.js
        ▲  restart on crash (backoff)         │ exit 75 = "update requested"
        └─────────────────────────────────────┘
```

Why a managed install dir (`~/.shadok-ai/app`) rather than running the server
straight from the npx package: it lets `/update` refresh **only the server**
(`npm i shadok-ai@latest` into that dir + respawn) while the supervisor keeps
running. The supervisor code changes rarely; a full `npx shadok-ai@latest`
re-run picks up a new supervisor when needed.

### Components

| File | Responsibility |
|---|---|
| `src/main.ts` | The `bin`. Parse args (`--port`, `--no-telegram`); ensure config (first-run prompt); ensure `~/.shadok-ai/app`; run the supervisor loop. |
| `src/supervisor.ts` | Pure-ish orchestration: spawn the server child, watch its exit, decide **respawn / update / give-up**. Restart backoff + cap. On exit code `75`, run the updater then respawn. |
| `src/config.ts` | `loadConfig()/saveConfig()` at `~/.shadok-ai/config.json` (mode 600): `{ telegramToken?, port? }`. Replaces the `telegram.env` shell-sourcing. |
| `src/setup-prompt.ts` | `readline`-based first-run prompt (masked input) for the token. TTY-only. |
| `src/updater.ts` | `npm i shadok-ai@latest --prefix ~/.shadok-ai/app` (or equivalent); returns the resolved version. Never touches the running child on failure. |
| `src/server.ts` | Unchanged transport/hub. Two additions: read token from config (env still overrides); on boot, if `~/.shadok-ai/.update-result` exists, post the success/failure notice to the board group and delete it. |
| `src/telegram.ts` | New `/update` command (board-group + allowlist gated) → reply "updating…", then request update by exiting the process with code `75`. |

`package.json`: add `"bin": { "shadok-ai": "dist/main.js" }`, `"files"`,
`"engines": { "node": ">=20" }`, and a `prepublishOnly: npm run build`.

## Config & first run

1. `loadConfig()` reads `~/.shadok-ai/config.json`. Env vars still win:
   `TELEGRAM_BOT_TOKEN`, `PORT`, `SHADOK_*`.
2. If **no token** in config/env **and** stdin is a TTY and not `--no-telegram`:
   prompt once (masked). Empty input → record `telegramToken: null` (a
   deliberate skip, so we never prompt again). Save (mode 600).
3. Non-TTY (headless/npx in CI): never prompt. Start web-only if no token.
4. The token is passed to the server child via `TELEGRAM_BOT_TOKEN` in its env.
   **Never logged or printed.** The legacy `~/.shadok-ai/telegram.env` is
   migrated into `config.json` on first run if present, then ignored.

## `/update` flow

1. In the board group (and passing the allowlist, if any): `/update`.
2. Bot replies "🔄 updating…", then `process.exit(75)`.
3. Supervisor sees code `75` → `updater.update()` = `npm i shadok-ai@latest`
   into `~/.shadok-ai/app`. Either way it writes a single result file
   `~/.shadok-ai/.update-result` (JSON: `{ ok, version }` or `{ ok:false,
   error }`), then respawns the child — from the refreshed dir on success, from
   the **current** version on failure (no downtime; a working instance is never
   left down).
4. New server boots, reads `.update-result` if present, posts either
   `✅ updated to v<X>` or `⚠️ update failed: <error>` to the board group, then
   deletes the file. Absence of the file = a normal (non-update) boot, silent.

Exit codes: `0` = clean stop (supervisor exits too); `75` = update; anything
else = crash → backoff respawn (cap N in a rolling window, then give up with a
clear log).

## Errors & robustness

- **Crash loop:** exponential backoff (1s→30s), cap at e.g. 5 restarts / 60s →
  give up and exit non-zero with a diagnostic (so a wrapping tmux/systemd shows
  the failure instead of hot-looping).
- **Update safety net:** the running child is killed **only after** a
  successful `npm install`.
- **Port in use:** surfaced as a fatal, actionable message (not a silent loop).

## Testing

Unit tests (pure logic, spawner/updater mocked):

- `config`: load/save round-trip, env override precedence, `telegram.env`
  migration, 600 perms, the "skip = null, never prompt again" rule.
- `supervisor`: exit-code → action mapping (`0`/`75`/crash), backoff schedule,
  give-up threshold. Injected fake spawner + clock.
- arg parsing (`--port`, `--no-telegram`), version read from package.json.
- `telegram`: `/update` gating (board group required, allowlist honored) — pure
  predicate, no network.

The actual `npm install` and child spawning are thin adapters behind
interfaces, exercised by the decision tests via mocks.

## Non-goals (for now)

- Versioned installs + healthcheck-gated rollback of the **supervisor** itself
  (v1 re-runs `npx …@latest` for that). Windows service integration. Auto-update
  on a schedule (only on-demand `/update`).
