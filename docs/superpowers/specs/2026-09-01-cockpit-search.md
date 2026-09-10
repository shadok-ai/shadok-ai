# Cockpit search — full-text across every agent

## Problem

There was no way to find a message once it scrolled out of view, and none at
all across agents. The web client only holds what it has loaded — the opened
channels, and only their last 100 turns (`loadHistory` caps there). The full
corpus lives on the server as the `.jsonl` transcripts (hundreds of files, ~
hundreds of MB), so a "pure front-end" search can only ever cover the current
conversation. A real engine has to run on the server.

## Shape

- **`GET /search?q=…`** (behind the same auth gate as everything else — a
  transcript can hold anything an agent printed). Scans **this cockpit's
  channels** (`loadChannels`), each channel's WHOLE transcript
  (`readHistoryTurns`, uncapped), and returns hits newest-first across agents,
  capped at 80. Each hit: `{ sessionId, agent, role, at, snippet:{before,match,after} }`.
- **`src/search.ts`** — the pure half (no fs): `normalizeQuery`, `makeSnippet`
  (a one-line context window around the first case-insensitive match, ellipsised),
  `searchTurns` (newest-first, capped per agent). Tested like the other pure
  front cores.
- **`readHistoryTurns`** (extract.ts) is `loadHistory` without the `slice(-100)`
  — same filters, so search matches exactly the text a human would have read
  (tool noise, cron/agent marks, NOTHING TO SHOW, stripped `⟦…⟧` header + ledger
  block all gone). `loadHistory` is now `readHistoryTurns(…).slice(-100)`.
- **Client**: a 🔍 toolbar button (or ⌘/Ctrl-K) opens a popin; a debounced query
  hits `/search`; hits render as `agent · role · time` + the snippet with the
  match `<mark>`ed (via `textContent`, never innerHTML — it's agent text); a
  click opens the agent (`activate` the tab by `sessionId`).

## Decisions / limits

- **Substring, case-insensitive.** What "find where I talked about X" means, no
  regex surprises. A smarter index can slot in behind the same endpoint later.
- **Scan on demand**, no index: the corpus is small and the client debounces.
- **Scope = the cockpit's channels** (named agents). Past/closed sessions with
  no channel are not searched — they have no friendly name to show and are the
  rarer need; can extend later.
