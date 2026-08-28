# Ledger push: per-instance scope, delta-before-prompt, update-by-id

**Date:** 2026-08-28
**Status:** built. Follows the shared ledger (2026-08-25) and its GUI viewer.

## Problem

The shared ledger (a state table of what agents resolved/decided) worked only if
an agent remembered to `check` — and `check` is substring-only, so a paraphrase
missed. Agents stayed effectively siloed. Three changes make it active rather
than passive:

1. **Per instance.** The ledger was a single machine-global `~/.shadok-ai/
   ledger.json`, shared across every cockpit on the host. It should be scoped to
   the instance, like channels / crons / config (all keyed by the launch dir).
2. **Pushed, not pulled.** Ahead of each user message, inject what changed in the
   ledger since this agent last saw it — so it learns siblings' resolutions in
   near-real-time without having to think to `check`.
3. **A handle to update by.** The key was the (long, freeform) entity name;
   updating meant reproducing it verbatim, and any drift forked a second row. A
   short stable id lets an agent update a row it just saw without that risk.

## Design (as built)

### 1. Per-instance storage

`ledgerFileFor(cwd)` → `~/.shadok-ai/ledger/<enc>.json`, the launch dir encoded
the same way channels/crons encode it. Both readers key by it: the server's
`GET /ledger` uses `process.cwd()`; the skill runs *inside an agent* whose cwd is
a worktree, so it cannot derive the launch dir — the server passes the resolved
path in **`SHADOK_LEDGER_FILE`** at spawn (next to `SHADOK_SESSION_ID` /
`SHADOK_SESSION_KEY`). A hand-run CLI with no env falls back to the legacy global
file.

`ensureLedgerFile(cwd)` runs at boot: if the scoped file is absent, seed it from
the legacy global ledger (COPY — a second instance seeds its own from the same
source, then they diverge, which is the point), and backfill an id onto every
id-less row. Best-effort; a failure never blocks boot.

### 2. Delta pushed before each human prompt

`Live.ledgerSeenAt` is a per-agent watermark, anchored to `now` at attach (so the
first message shows changes from then on, not the whole backlog). In the `prompt`
handler, for **human origins only** (`web`/`telegram`/`cli`) and only when
`ledgerEnabled`:

- `deltaSince(rows, ledgerSeenAt, cap)` → the rows with `updatedAt > watermark`,
  newest-first, capped at `LEDGER_PUSH_CAP` (8) with a `+N more` line;
- advance `ledgerSeenAt = now` (whether or not there was a delta — by now the
  agent has seen everything up to this moment);
- if non-empty, `markLedgerBlock` prepends the block ahead of the existing
  `⟦platform⟧` prompt-meta header.

The block (English — it is transcript-side):

```
⟦ledger · 2 updates since your last message⟧
• [a965] biosense nightly export — resolved (agentA)
• [7565] fork-follow (context overflow) — resolved (PR#164)
```

It is stripped from the display in `extract.ts` `loadHistory` via
`stripLedgerBlock` run **before** `stripPromptMeta` — the `⟦ledger⟧` header line
also satisfies `hasPromptMeta` (it has ` · `), so the whole ledger block must be
removed first (its header + the contiguous `• ` bullets), then the platform
header. The agent sees the block; the chat shows only the message. Because a
delta is usually empty, most prompts carry nothing, so the transcript does not
bloat. In-memory watermark (near-real-time, not an audit): a restart re-anchors.

### 3. Short id, update-by-id

Every row carries a 4-hex `id`, minted once and **preserved across every
supersede** (`upsertEntry` reuses an existing entity's id). `resolveId(entries,
idOrPrefix)` — exact, else a unique prefix, else null (empty/ambiguous refused,
per invariant 17). `record --id <id> [--status …] [--note …]` updates that exact
row in place (keeps its entity; a rename only if `--entity` is given); an unknown
id throws rather than silently creating. The id shows in `check` / `list`, in the
pushed block, and in the GUI viewer, so an agent can quote the handle it just saw.

## Boundaries kept

- Split by side: `context/ledger-skill/ledger-core.mjs` (agent side — upsert with
  id-preserve, `resolveId`, find) and `src/ledger.ts` (server side — path,
  migration, delta, block, strip). The tiny cwd-encoding is duplicated the way
  the rest of the codebase duplicates it (channels/crons/tail).
- Only human prompts get the block; cron/agent prompts carry their own marks and
  are left alone, exactly as prompt-meta already is.

## Out of scope (deliberate)

- Persisting the watermark across restarts (in-memory is fine for near-real-time).
- Filtering out an agent's own writes from its delta (low noise; seeing your own
  confirms it landed).
- Word-overlap recall for `check` (a separate improvement; the push reduces the
  reliance on `check` for recent items but does not replace it for older ones).

## Verification

Pure units: `test/ledger.test.ts` (id-preserve upsert, update-by-id, `resolveId`)
and `test/ledger-inject.test.ts` (`deltaSince`, block format, strip composing with
prompt-meta, `ledgerFileFor`, `mintLedgerId`). End-to-end on a side instance:
boot migrated the global ledger into the scoped file with ids backfilled; the
skill created + updated-by-id against `SHADOK_LEDGER_FILE`; a real agent driven a
prompt received the `⟦ledger⟧` block in its transcript while `loadHistory`
returned only the message. Full suite green (743).
