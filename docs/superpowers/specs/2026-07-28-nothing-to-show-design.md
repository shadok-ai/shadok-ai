# `NOTHING TO SHOW`: letting an agent say nothing

*2026-07-28*

## The problem

An agent must always answer something. A scheduled session (a monitoring cron,
say) that detected nothing therefore has no way to stay silent: it posts
"nothing to report", which buzzes a phone to say that nothing happened. That
noise is exactly what a quiet cron was meant to avoid.

## The intended behaviour

A text block whose **entire** content is `NOTHING TO SHOW` is neither streamed
nor replayed: no bubble in the web UI, no Telegram message, nothing in the
history after a reload. The rest of the turn (other blocks, tool calls, token
usage) is unchanged.

The convention is documented in `context/pilot-prompt.md`, so every piloted
session knows it.

## Architecture

### The predicate (`src/tail.ts`)

```ts
const NOTHING_TO_SHOW = /^[*_`\s]*nothing to show[*_`\s.!]*$/i;
export function isNothingToShow(text: string): boolean;
```

Deliberately **strict**: the sentinel must be the whole block (Markdown emphasis
and a trailing period tolerated, case-insensitive). An agent that *explains* the
convention in a sentence does not get muzzled. Invariant 2 of CLAUDE.md is the
reminder of what an over-broad heuristic has already cost here: quoting "esc to
interrupt" was enough to leave a session stuck as "busy".

`tail.ts` is the source of truth for content: putting the filter there makes it
hold for every consumer at once (the web and Telegram go through the same
`stream-text`).

### The three filtering points

| Where | Why |
|---|---|
| `parseLine` (`src/tail.ts`) | The live stream: the block is never emitted. |
| `loadHistory` (`src/extract.ts`) | History replayed on reload — filtered **block by block**, like the tail, otherwise the sentinel would reappear after an F5 though it was never displayed. |
| `updateLivePreview` (`public/index.html`) | The provisional grey preview is read off the screen, not from the transcript: with no guard it would stay up the whole turn, waiting for a `stream-text` that will never come. Twin of the server-side regex — there is no bundler here. |

## Tests

- `test/tail.test.ts`: the predicate (case, emphasis, trailing period; the phrase
  *inside* a sentence is not the sentinel) and `parseLine` letting the rest of
  the message through.
- `test/extract.test.ts`: a sentinel block in the transcript creates no turn in
  the replayed history.

## Out of scope

- Making the sentinel configurable: a hardcoded string is enough and documents
  itself in the pilot prompt.
- Reporting "this turn said nothing" in the UI: the silence is the point.

## Refinement — the trailing sign-off (*2026-11-04*)

A monitoring agent produced a real answer and then put the sentinel on its own
**last line** (a single block: `"…nothing it should carry.\n\nNOTHING TO SHOW"`).
`isNothingToShow` is whole-block, so the block was neither dropped nor cleaned —
and the marker leaked into the chat. Reported from the live cockpit, screenshot
in hand.

The rule the admin asked for is the safe one: **strip the sentinel only when it
is at the END of the message; keep it if it is in the middle.** A trailing marker
is an accidental sign-off; a mid-message one is text the agent chose to show
(explaining the convention, quoting a sibling) — the same invariant-2 line the
whole-block predicate already walks.

```ts
const TRAILING_NOTHING_TO_SHOW = /\n[ \t*_`]*nothing to show[ \t*_`.!]*\s*$/i;
export function stripTrailingNothingToShow(text: string): string; // src/tail.ts
```

The marker must be its **own trailing line** (same emphasis / dot tolerance), so
`…so there was nothing to show.` inside a sentence is untouched. The block is
reached only after `isNothingToShow` has already handled the whole-block case, so
the strip can never empty it — the content above the marker is real, the turn is
**not** silent, and a parent is still notified (the `src/server.ts` notify guard
keeps using whole-block `isNothingToShow`, deliberately: a child that *did* work
should wake its parent). Applied on the same three paths as the whole-block drop;
the `index.html` live-preview copy mirrors the regex (no bundler).

New tests: `test/tail.test.ts` (trailing stripped / mid-message kept / inline
prose kept, plus the pure helper) and `test/extract.test.ts` (a replayed history
turn ends with the answer, not the marker).
