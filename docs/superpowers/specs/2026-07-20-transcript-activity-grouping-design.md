# Transcript: grouping activity and folding past turns

## Problem

The web transcript appends one flat `.turn` element per stream event. A turn that
reads six files and runs four commands produces twenty stacked blocks, most of
them tool output nobody rereads. The signal — what Claude *said* — is buried in
its own scrollback, and the noise never goes away: a fifty-turn session keeps
every byte of every `grep` on screen forever.

This is a structural problem, not a spacing one. Tightening padding makes more
noise fit on screen; it does not make the noise recede.

## Goal

Activity recedes as the conversation advances, without ever hiding a failure.
Claude's prose stays permanently visible; tool activity collapses progressively
as it becomes history.

## Design

### Three levels of folding

| level | unit | default state | folded form |
|---|---|---|---|
| output | one tool call + its result | folded | `→ Read public/index.html` |
| run | consecutive calls to the same tool | folded when ≥2 calls | `→ Read ×4 ▸` |
| activity block | consecutive tool events between two texts | open during the turn, folded at `turn-done` | `▸ 12 operations` |

An **activity block** is a maximal run of tool events uninterrupted by assistant
text. A turn with `text → tools → text → tools` yields two blocks, preserving the
real interleaving; folding never reorders the transcript.

Assistant text is never folded. It belongs to the turn, not to any block.

### Errors are exempt at every level

`isError` propagates upward: an errored result stays open, the run containing it
refuses to condense, and its activity block resists the `turn-done` fold. A
folded turn that contained a failure still shows that failure in the clear.

Hiding an error is hiding the one thing worth scrolling back for.

### Pairing outputs to calls

`src/tail.ts` currently drops `block.id` (on `tool_use`) and `block.tool_use_id`
(on `tool_result`), so the client receives anonymous events in arrival order.

Positional pairing is not viable: a single assistant message routinely carries
several `tool_use` blocks (parallel calls), and their results arrive batched in a
later `user` event in unspecified order. Pairing by position would render Bash's
output beneath the Read call.

So the extractor keeps the identifiers, and the server forwards them:

- `kind: "tool"` gains `id`
- `kind: "result"` gains `toolUseId`
- `stream-tool` / `stream-result` relay both

Two additive fields. A client ignoring them behaves exactly as today.

The client pairs by id, and falls back to "attach to the most recent unmatched
call" when an id is absent — which keeps older servers and any unforeseen gap
rendering sanely rather than dropping output.

### Client structure

A single `activityLog` module owns all fold state, exposing four operations:

- `addText(text)` — closes the current activity block, appends a text bubble
- `addTool(msg)` — appends to the current block, opening one if needed
- `addResult(msg)` — attaches output to its call by id
- `sealTurn()` — folds every block of the turn that contains no error

The WebSocket dispatch stays flat: each `case` is one call. All grouping,
counting and folding logic lives behind that interface, testable without a
socket.

### Out of scope

Replayed history (`case "history"`) carries only `role` and `text` — the server
never sends tool events for it. Folding applies to the live stream only. Making
history replay carry activity is a separate change to the extractor's history
path.

### Styling

Keeps the contextual margins and the one-label-per-speaker-run rule introduced
alongside this work — both reinforce the grouping. Restores the original
paddings and font sizes: density now comes from folding, so the bubbles that
remain on screen can stay comfortable to read.
