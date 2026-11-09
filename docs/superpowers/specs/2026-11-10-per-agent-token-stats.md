# Per-agent token + cost stats (the ⋯ menu's 📊 Stats view)

Status: built. `src/token-stats.ts` (pure), `scanUsageSamples` (`src/tail.ts`),
`GET /channels/stats` (`src/server.ts`), `tmuxSessionCreated` (`src/tmux.ts`),
the stats panel in `public/index.html`.

## Ask

The admin wanted, per agent, a counter over the last hour / 24 h / 7 d / 30 d —
tokens and the associated cost — plus how long the agent has been up, and the
last respawn. One hard constraint: **if it risks making everything lag, don't
do it.**

## The data is already there

Every assistant message in the Claude Code transcript carries the full usage
split (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`) with a timestamp and the resolved model name. So
time-windowed, per-model sums are a pure function of data we already read.

## Decisions

- **Scope: the current session file.** The windows are computed from the
  session's own `.jsonl` — not a cross-session/agent sweep. This is what keeps it
  cheap: the full scan already happens once at `Live` creation (`scanUsageSamples`
  seeds both the context gauge's last-message usage and the stats samples in one
  read), and the live `usage` event updates one map entry. The panel reads memory,
  no per-request file I/O. A dormant agent (no `Live`) costs one bounded scan on
  open. Cross-session history (resume chains) is deliberately out of v1.
- **Cost is NOTIONAL.** shadok runs on the Claude subscription, so nothing is
  billed per token. `MODEL_PRICING` prices the tokens at Anthropic API list rates
  (cache-read ≈ 0.1×, cache-write ≈ 1.25× input, except where a rate is listed) to
  make agents comparable. An unknown model → no price for that message: the window
  still counts its tokens and flags `costPartial` (the cost is shown as a `≥`
  floor), never a guessed number. The UI says "notional" in full.
- **Two times, two sources.** "Up since" is the transcript's earliest timestamp —
  it survives restarts and auto-updates, so it reads as the agent's true age.
  "Last respawn" is the running process's start: for a tmux agent that is the
  pane's `session_created` (which survives a *server* restart, because the pane is
  adopted — invariant 25), and for node-pty it is the `Live`'s build time. The two
  differ on purpose: an agent "up 5 days" whose process "respawned 2 h ago"
  (an auto-update) is the normal, honest picture.

## Why it cannot drag

The windowing is `O(messages in the current file)`, over a map already held in
memory, computed only when the panel opens. The one file read is the scan we
already do at spawn/adopt — extended to bucket, not added. No timer, no
cross-session walk, no per-render I/O. That is the answer to the "don't make it
lag" constraint.

## Streaming double-count trap

The live `usage` event fires several times per message with growing counts. The
samples map is keyed by message id (last-wins, like `scanUsage`), so a message is
counted once at its final usage — never summed across its partials. A
first-seen message is stamped with arrival time (the event carries none); a
growing partial keeps that first instant.

## Verification

- Pure units: `messageCostUSD` (known vs unknown model), `windowStats` (nesting,
  age boundaries, future-skew skip, `costPartial`), `scanUsageSamples` (partials
  collapse, `firstAt` is the first prompt).
- End to end on a real 946-message transcript: 30 d = 17.8 M tokens, ~$13.3
  notional, cache-read dominating, `costPartial` false (all one priced model).
- Served build (free port): page serves the panel, every inline script parses
  (invariant 12), `GET /channels/stats` wired (400 no id, 404 unknown). Prod 3789
  untouched. No browser on this host (Playwright absent), so the render was
  checked by syntax + served-markup, not a screenshot.
