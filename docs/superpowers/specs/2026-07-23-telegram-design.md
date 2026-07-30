# Telegram control — design

Date: 2026-07-23 · Status: increments 1 & 2 shipped (PRs #2, #3)

## Goal

Pilot shadok-ai agents from Telegram (two-way), so the durable tmux agents
are controllable from a phone without the web UI.

## Mapping (decided)

- **1 shadok-ai instance = 1 Telegram bot** (`TELEGRAM_BOT_TOKEN`).
- **1 DM (private chat) = 1 session.**
- **1 forum topic in a group = 1 session** (`message_thread_id`). The bot
  **creates topics itself** (`createForumTopic`) so it configures its own
  channels — a group becomes a board of agents, one topic each.
- Binding key: `private:<chatId>` or `topic:<chatId>:<threadId>` → sessionId.
  Persisted per launch directory in
  `~/.shadok-ai/channels/<encoded cwd>-telegram.json`, so it survives
  restarts like the web channel list.

## Architecture — Telegram is just another client

The Telegram bridge runs inside the server process (started only when
`TELEGRAM_BOT_TOKEN` is set) and connects **to the server's own `/ws`** as a
WebSocket client, one connection per bound chat/topic. This means **zero
changes to session handling**: a Telegram-driven session is the same `Live`
session the web UI sees, shared live. It reuses the entire protocol.

```
Telegram  ──getUpdates(poll)──▶  telegram.ts  ──ws://localhost/ws──▶  server sessions
   ▲                                  │  (one WS per bound chat/topic)      │
   └──── sendMessage / editMessage ───┘◀──── stream-text / dialog / turn-done
```

- **Connection**: long-polling (`getUpdates`), no public URL / webhook needed.

## Behaviour

- **Text message** in a bound chat/topic → `{type:"prompt", text}` to its WS.
  `stream-text` → a Telegram message; `stream-tool`/`stream-result` → compact
  italic lines; `turn-done` → stop the "typing…" action.
- **First message with no binding** → auto-spawn a session (worktree off by
  default in DMs) and bind it, then send the prompt.
- **Commands**:
  - `/spawn [name]` (in a forum group) → `createForumTopic` + bind a new
    session to it; the confirmation and future replies live in that topic.
  - `/new` (DM) → end the current session binding, start fresh.
  - `/list` → the bound sessions and their state.
  - `/cwd <path>`, `/worktree` → configure the next spawn.
  - `/end` → stop the session bound to this chat/topic.
- **Dialogs** (`dialog` message) → an inline keyboard; a `callback_query` maps
  to `choose`/`toggle`/`confirm`. Multi-select toggles update the keyboard.
- **Streaming granularity**: message-level (same as the tail). Telegram has a
  ~4096-char message limit → long blocks are chunked.

## Increment plan

1. **Done (PR #2)** — bridge skeleton: long-poll, DM = session, text prompt →
   streamed text reply → turn-done, binding persistence, `/new` `/end` `/list`.
   Pure helpers unit-tested (update parsing, key derivation, chunking).
2. **Done (PR #3)** — forum topics + `/setup` (bind the single board group,
   one group per instance) + `/spawn <name>` (createForumTopic → isolated
   worktree agent), dialogs as inline keyboards (`callback_query` →
   choose/toggle/confirm), `stream-tool` lines. `dialogKeyboard`/`parseCallback`
   unit-tested.
3. (later) notifications on turn-done when idle; `/cwd` override; media.

## Non-goals (for now)

- Webhooks (polling is enough locally). Voice/media. Multi-bot per instance.
- Auth beyond "whoever can DM the bot": add an allowlist of chat IDs later.

## Security

- `TELEGRAM_BOT_TOKEN` via env only, never committed. Optional
  `TELEGRAM_ALLOWED_CHATS` allowlist so only known chats can drive agents.
