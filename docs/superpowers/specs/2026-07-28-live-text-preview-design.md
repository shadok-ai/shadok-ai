# Live preview of the assistant's text (token-by-token streaming, web side)

## Problem

The web client shows the assistant's text by reading it from the `.jsonl`
transcript (through the tail — a reliable, untruncated source). But **Claude Code
only writes a text block into the `.jsonl` once it is entirely finished** — never
token by token (verified: 0 incremental text records; a 1155-character block
appears in a single jump after ~11 s of invisible generation).

The consequence: a long paragraph stays invisible for its whole generation, then
surges out at once. Tools *seem* to stream because (a) they are small, frequent
blocks and above all (b) the engine room shows the PTY's raw TUI screen, updated
live — independently of the file. Hence the feeling that "everything you write,
we only see at the end".

This is not a regression in shadok-ai's code (the streaming handler is unchanged
since the initial commit): it is inherent to sourcing the text from a transcript
written block by block.

## Goal

Give a **best-effort live preview** of the text block being generated, then
**replace** it with the authoritative version (clean markdown) as soon as the
complete block lands in the `.jsonl`. We keep the live view *and* the correction:
no lasting truncation.

Non-goals: reconstructing the source markdown from the screen; touching the
server or the protocol; guaranteeing a perfect rendering of the provisional text.

## Constraints / decisions

- **100 % client-side** (`public/index.html`). Zero server change, no risk to the
  fragile invariants. The only token-granular source is the PTY screen, already
  broadcast through the `screen` messages (~3×/s, on change) and already stored in
  `t.screenText`.
- **Best-effort fidelity, accepted**: the provisional text is the screen's raw
  text (wrapped, pseudo-ASCII, potentially truncated), displayed greyed, without
  markdown. It is never persisted.
- **Graceful degradation**: if the extraction fails (a new TUI, a changed
  marker), we show no provisional text → we fall back exactly onto the current
  behaviour (block-level text). Never worse than today.

## Architecture (the flow)

Nothing changes server-side. Everything lives in the client:

1. The server already broadcasts `screen` (the full TUI screen's text) on every
   change, ~every 300 ms during a turn.
2. The client, during an active turn, extracts the in-flight text block from the
   screen and shows it in a **provisional bubble** that updates in place.
3. When `stream-text` (the complete authoritative block) arrives, the provisional
   bubble is **replaced** by the usual markdown rendering
   (`addTurn(..., "live")`).
4. On `turn-done`, any leftover provisional bubble is dropped.

## Components

### 1. `extractLiveText(screen) -> string` (pure, testable)

The regular structure observed in the TUI:
- An assistant text block = a `⏺ <text>` line (the U+23FA marker at column 0) +
  continuation lines indented by 2 spaces.
- Tools render `  Ran … command` / boxes; the prompt echo is `❯ …`.
- The end of the assistant's output = the spinner line: running
  `✽ … (Xs · esc to interrupt)` or variants, finished `✻ Brewed for 10s`. We
  reuse the existing detection logic (`SPINNER_STATUS` / `ESC_TO_INTERRUPT` from
  `detect.ts`, ported to JS in the client).
- Then the `────` separator, the `❯` input box, the footer (`… ctx:NN% …`).

The algorithm:
1. Cut the bottom of the screen off: truncate from the last
   separator/input-box/footer block (everything after the assistant's output).
2. Locate the spinner line → the upper bound of the assistant's output.
3. Walk back to the **last** `⏺ ` marker above the spinner; take that line + its
   indented continuation lines.
4. Unwrap: join the marker and the continuations, dropping the indentation, to
   produce readable text.
5. Return `""` when: no `⏺` was found, or the last `⏺` is obviously a tool (a
   simple heuristic), or the result is empty → no preview.

That function is the single fragile point; it is isolated and unit-tested against
screen fixtures.

### 2. Life cycle of the provisional bubble (per `tab`)

State added on `tab`: `tab.livePreviewEl` (the provisional DOM element or null).

- **`working`**: `tab.livePreviewEl = null` (a new turn, nothing yet).
- **`screen`** (while busy): `const txt = extractLiveText(msg.text)`. If `txt` is
  non-empty: create (if absent) a `.turn.claude.live-preview` bubble (greyed,
  `textContent = txt`, no markdown), keep it at the bottom of the transcript and
  scroll; otherwise update its text. If `txt` is empty and a bubble exists: leave
  it as is (do not clear an already displayed provisional over a mere extraction
  gap).
- **`stream-text`**: remove `tab.livePreviewEl` (when present), set it to null,
  then run the usual markdown `addTurn(t, "claude", "claude", msg.text, "live")`.
  The authoritative block takes its place 1 for 1.
- **`turn-done`**: remove any leftover `tab.livePreviewEl` and set it to null
  (the case where the turn ends with no final stream-text — e.g. a dialog).

### 3. Styling

`.turn.claude.live-preview .bubble`: the same shape as a claude bubble, but
greyed (opacity ~0.6) and in a mono font / `white-space: pre-wrap` to reflect
that it is raw screen text, not markdown. A discreet visual marker (an optional
blinking cursor) — to be tuned to taste, cosmetic.

## Reconciliation & guarantees

The provisional text is purely transient. The key guarantee that removes the risk
of screen scraping: **every provisional bubble is either replaced by the `.jsonl`
block (stream-text) or dropped (turn-done)** — it never survives the turn. A
wrong or truncated extraction is therefore corrected in <1 s.

## Edge cases

- A screen with no assistant text (tools only) → `extractLiveText` returns `""` →
  no provisional text, and tools stream as they do today.
- Several text blocks in one turn → each `stream-text` replaces the current
  provisional one; the next provisional is recreated on the following `screen`s.
- A turn ended by a dialog (no final stream-text) → `turn-done`/`dialog` cleans
  the provisional bubble.
- A new TUI / a changed `⏺` marker → `""` → degradation to the current
  behaviour.
- The provisional text must never be counted as history nor persisted
  (`persistChannels` / `loadHistory` never see it — it is ephemeral DOM).

## Tests

`extractLiveText` being pure, unit tests (node:test) against captured screen
fixtures:
- a single-block generation in progress (spinner active) → returns the current
  paragraph;
- multi-block with an interleaved `Ran … command` → returns the last text block;
- a finished spinner (`✻ Brewed for Xs`) → returns the last block (or `""`, to be
  pinned down);
- a screen with no `⏺` → `""`;
- a screen with a filled input box + footer → the lower bound correctly cut.

No browser integration test: the DOM life cycle is simple and the degradation
guarantees an extraction bug breaks nothing.

## Scope

A single code file (`public/index.html`) + a testable pure module/function
(either inline plus a small test importing it, or a tiny shared
`public/live-text.js` so it can be `import`ed in a node test). Implementation
decision: put `extractLiveText` in a separate, importable file for testability.

## Coordination

⚠️ Another channel (`0e330518`) was discussing the same subject and believed agent
`43b478e9` was already on it. Check that no parallel work on `public/index.html`
conflicts before landing (invariant #8). This work happens in the isolated
worktree `worktree-live-text-preview`.
