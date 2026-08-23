# Telegram: the text before a question must arrive before the keyboard

**Date:** 2026-07-28
**Status:** design agreed

## The symptom

In Telegram, when the agent writes a paragraph then asks a question
(`AskUserQuestion`), the **inline keyboard arrives first**. The paragraph only
appears *after* the user has answered — so they choose blind.

## The root cause

Evidence taken from a passive WebSocket client attached to a live session:

```
23:56:36.247  dialog      "Order test: …"          ← the keyboard goes out at once
23:58:26.403  prompt-echo                          ← the user answers (1 min 50 later)
23:58:26.994  stream-text "Observer in place…"     ← the text only arrives HERE
23:58:26.994  stream-tool AskUserQuestion
```

Two channels, two latencies:

- **The content** comes from the `.jsonl` tail (`src/tail.ts`). Claude Code only
  writes an assistant message there once **finished**, that is once its
  `tool_use` is resolved. And `AskUserQuestion` only resolves when the user
  answers. The `text` block preceding the call is therefore structurally held
  back until then.
- **The dialog** comes from the TUI screen (`detectDialog`), available
  immediately.

So this is not an ordering bug in the bridge: it is data the tail cannot supply
in time. The same signature reads elsewhere in the log — `stream-tool` and its
`stream-result` land within a millisecond of each other, because the `tool_use`
and its result are flushed together.

The web client does not suffer from the problem: it already has a workaround,
`extractLiveText(screen)` (`public/live-text.js`), which shows a provisional grey
bubble read off the screen. Telegram has no equivalent.

Confirmation that the information IS available server-side — a capture of the TUI
screen at the precise moment the dialog is displayed:

```
⏺ This paragraph is here to act as the test's preface text: a capture of the
  TUI screen fires in 25 seconds, …

❯ /login
────────────────────────────────
 ☐ Capture
```

The text is indeed the screen's last `⏺ ` block, so `extractLiveText` can
recover it. The server holds the information at the exact moment it broadcasts
the `dialog`; it simply does not pass it on.

## A second defect, revealed by the first

In `src/telegram.ts`, every send is fire-and-forget: `send(b, …)` is never
awaited, and each call fires its own `fetch`. Two sends close together are
therefore not guaranteed to arrive in the order they were issued — which can
already interleave a text and the tool line that follows it.

The consequence for this fix: sending the preface "before" the keyboard would not
be enough. A bridge's Telegram writes have to be serialised.

## The solution

### 1. The server attaches the preface to the `dialog`

`finishTurn` (and `sendPendingDialog`, and the re-broadcasts after `choose` /
`toggle`) add a `preface` field to the `dialog` message, extracted from the
screen with `extractLiveText` — the function the web already uses.

An optional field: the web client ignores it and keeps its grey bubble. The
invariant "content is authoritative from the tail" is preserved — the preface is
explicitly **provisional**, exactly like the web preview.

### 2. A serial send queue per bridge

Every Telegram write of a bridge (text, tool line, keyboard, edit) goes through a
promise chain of its own. FIFO guaranteed, with no blocking between different
bridges.

A failed send must not break the chain: the queue swallows rejections.

### 3. Telegram sends the preface, then edits it

- On **creating** a keyboard (not on its multi-select refreshes), when `preface`
  is non-empty: we send it, keep its `message_id` and a dedup key, then send the
  keyboard — in that order, through the queue.
- When the authoritative `stream-text` arrives (after the answer) and matches the
  key we kept: we **edit** the preface message with the real content
  (`editMessageText`), instead of posting a second message. The final rendering
  gets the clean Markdown. The key is consumed.

If the authoritative text exceeds one message's size, the first part replaces the
preface by editing and the rest are sent after it.

### 4. Matching preface ↔ authoritative text

A pure function, testable on its own:

```
prefaceMatches(preface, authoritative) -> boolean
```

The screen unwraps: the terminal's line breaks *and* real paragraph breaks both
become single spaces. So we normalise both sides (any run of spaces → one space,
trim) and test inclusion: `norm(authoritative).includes(norm(preface))`.

Inclusion — rather than a plain prefix — covers the case where the screen has
scrolled the start of the block away: the preface is then an inner fragment of
the authoritative text.

A guardrail: no match below 12 normalised characters, so too short a preface
cannot match by accident.

## Accepted degraded cases

| Situation | Behaviour |
|---|---|
| A `tool_use` sits between the text and the question | `extractLiveText` returns `""` → no preface, the current behaviour unchanged |
| The block scrolled off screen far enough to be unrecognisable | The authoritative text is posted as a second message: a duplicate, never a loss |
| `editMessageText` fails | The preface message stays in place as it is |

## Out of scope

Text preceding a **slow tool** (a two-minute build) stays invisible for the
tool's whole duration: same root cause, but handling it would take flushing the
screen text continuously, with a real risk of duplicates for want of a 1-for-1
replacement in Telegram. To be handled separately if the annoyance is confirmed.

## Tests

Pure unit tests, with no network and no Telegram:

- `prefaceMatches`: the nominal unwrapped case, a preface truncated by scrolling,
  an unrelated text, too short a preface, empty strings.
- The serial queue: operations with decreasing latency still finish in the order
  they were issued; a rejection does not block the ones that follow.
- `extractLiveText` against the real dialog screen captured above (one more case
  in `test/live-text.test.ts`): the paragraph is recovered even though the
  keyboard occupies the bottom of the screen.

A final check under real conditions: `npm run build`, restart the server in its
tmux, then a real question asked from a piloted session — the paragraph must
precede the keyboard in Telegram.
