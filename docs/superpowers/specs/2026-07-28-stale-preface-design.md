# A question's preface must never repeat the previous answer

*2026-07-28*

## The problem (reproduced)

Every question asked in Telegram could be preceded by a **copy of the previous
turn's answer**.

A direct capture of the `dialog` event on `/ws`, with the agent explicitly
instructed to say nothing before the question:

```json
{"type":"dialog","question":"Tea or coffee?", …, "preface":"UNIQUE-MARKER-42"}
```

`UNIQUE-MARKER-42` was the previous turn's answer, already posted. In the
channel: the duplicate, then the question.

**The cause.** `dialogMessage` builds the preface with
`extractLiveText(s.pilot.screen())`: the last text block **visible on screen**.
When the new turn has written nothing yet, that block is the previous turn's. The
preface is stale.

**Why the web does not suffer from it.** The client tracks the blocks already
delivered (`finalizedNorms` / `isFinalizedBlock`) and clears the preview when it
recognises one. The Telegram bridge has no memory: it posts.

**Why it never repairs itself.** `prefaceMatches` waits for the tail's
"authoritative twin" to edit the message in place. That twin arrived on the
previous turn; it will not come back. The duplicate stays.

## The fix

On the **server**, once for every client — and not in the bridge: a future
client with no browser-side memory would otherwise inherit the same bug.

A preface only makes sense when it is **new**.

### `isStalePreface` (`src/telegram.ts`)

```ts
export function isStalePreface(preface: string, recent: string[]): boolean;
```

Placed next to `prefaceMatches`, of which it is an application: the preface is
stale when it matches **one** of the blocks already broadcast. The same
comparator on both sides — same alphanumeric skeleton, same fingerprint, same
guardrails (too short a fragment never matches). One definition of "this is the
same block" across the whole project.

### The memory of blocks (`src/server.ts`)

`Live` gains `recentTexts: string[]`, filled where the tail already broadcasts
the blocks (`e.kind === "text"`). **Bounded to the last 8**: a preface can only
describe a block visible on screen, hence recent; keeping more would only raise
the risk of a wrong match on a long session.

`dialogMessage` then only attaches the preface when it is not stale.

## What this does not fix

A block that was **never broadcast** cannot be recognised. That is the case when
the server restarts (an auto-update) while a turn is writing: the tail restarts
from the end of the file (`pos = fs.statSync(file).size`) and those blocks are
never emitted. They are then missing from Telegram — the web, for its part, finds
them again by reloading the history. **A separate bug, to be handled on its own.**

## Tests

- `isStalePreface`: a preface identical to an already broadcast block is stale; a
  brand-new text is not; an empty list stales nothing; too short a fragment
  (below `PREFACE_MIN`) does not match, even when contained in a block.
- The screen-rendered form (bold flattened, different punctuation) must be
  recognised as the same block as the transcript's Markdown source.
