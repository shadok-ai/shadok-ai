# The box that would not clear — a submit failure that survived its own fix

2026-10-26. Reported from Telegram, on an instance already running the fix for
invariant 36: `⚠️ submit: the text never appeared in the input box — the input
box was not empty — it still held 2 lines beginning "⟦telegram · 2026-10-26
21:27 · Alexandre Cognard⟧⟦"`.

The live composer held **six copies of the message header and none of the
message**. Six is `typeIntoBox`'s `attempts`.

## What was already true

PR #278 made every reading of the box go through `boxText` — the whole
composer, not the `❯` line — and that was necessary: without it a paste into an
occupied box is invisible. It was present in the running build (0.15.14,
verified in the installed `dist`, not inferred from the version number). So the
remaining hole was elsewhere, and the measurement had to be made on a real pane.

## Measured, on a throwaway `claude` pane (2.1.310)

Capturing between keypresses, starting from `⟦header⟧` + `Test`:

| press | box |
|---|---|
| — | `⟦header⟧` / `Test` |
| Ctrl-U | `⟦header⟧` / *(blank)* |
| Ctrl-U | `⟦header⟧` |
| Ctrl-U | *(empty)* |

And: **one Ctrl-C empties it in a single press**; a second one, on a box already
empty, did nothing visible.

## The two strikes

`emptyBox` stops after two presses that changed nothing — "there is nothing left
to clear". It was collecting both for free.

**Strike one is invisible by construction.** The middle press removes the blank
line: `"⟦header⟧\n"` and `"⟦header⟧"` are the same string once `boxText` trims.
Every multi-line prompt pays it, every time; it is not a timing fluke.

**Strike two was a stale read.** The loop took its baseline from `screen()` — on
tmux a fresh `capture-pane` — and judged the change with `waitFor`, which polls
the poller's MIRROR, refreshed every `SCREEN_FAST_MS` (300 ms) at best, against
the 400 ms the press is given. The capture is synchronous, so on a host with
twenty agents the remaining margin is routinely spent.

## Why one miss was permanent

`emptyBox` then returns with the header still in the box. That header is a
**prefix of the text the next attempt pastes**, so `survives` answers true, the
attempt is discarded, and the discard leaves one more header behind. The loop
ratchets: six attempts, six headers, no message, no recovery. A human with a
terminal is the only way out — which is how this was found, twice.

## The fix

- `boxRaw` — the box untrimmed. `boxText` becomes `boxRaw(…).trim()` and keeps
  its contract ("is there anything in there?"); the clear loop uses `boxRaw`
  ("did that press do anything?").
- `waitForBoxChange` — polls `pilot.screen()`, the same thing the baseline is
  read from. The baseline and the check can no longer disagree about which
  screen they are looking at.
- `shouldHardClear` / `hardClearIfLeftover` — one Ctrl-C when Ctrl-U could not
  empty the box. Gated three ways, each for a reason:
  - never while the screen shows work (Ctrl-C is also the interrupt);
  - at most once, never in a loop (a second in a row exits Claude Code);
  - only when the leftover is OURS — more than one line, or carrying the head
    of the text being pasted. At rest the box displays an example or a previous
    message as a ghost, both of which render exactly like typed text, and
    spending the one keystroke with a real cost on a box that holds nothing is
    the mistake this guard exists to prevent.

## Tests

`test/detect.test.ts` gains a pilot whose `waitFor` reads a mirror that can be
STARVED — a blocked event loop does not starve one press — while `screen()`
stays fresh. The previous fake made the two the same string, which is why the
first fix looked complete and the box still filled up in production.

Against the pre-fix code that scenario reproduces the live box exactly: six
pastes, `ok === false`, and the header stacked once per attempt. Both new
behavioural tests were run against the pre-fix code and fail there.

## Reproduced end to end, on a real pane

A throwaway `claude` 2.1.310 in tmux, driven by the actual `TmuxPilot`, seeded
with the ratchet's starting state (a leftover header in the box), while a
synchronous busy-wait starves the event loop the way twenty captures do.

| build | starved loop | result |
|---|---|---|
| pre-fix | no | submit OK, 3939 ms |
| pre-fix | yes | **`submit: the text never appeared in the input box — the input box was not empty — it still held 4 lines beginning "⟦telegram · …⟧⟦"`**, box left holding seven concatenated headers and no message |
| fixed | no | submit OK, 2805 ms |
| fixed | yes | submit OK, 5808 / 5841 ms, box empty, one copy of the message, agent answered |

The starvation is what the previous bench did not have, and it is the whole
difference between a bug that looks fixed and one that is.
