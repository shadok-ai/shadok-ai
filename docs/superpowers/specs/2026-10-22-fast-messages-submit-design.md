# Two messages in a row, and "the text never appeared in the input box"

## The report

> "When you send 2 messages very quickly from telegram, it often says
> `submit: the text never appeared in the input box`. Can you test and improve."

## Reproduced, then traced

A bench server on a free port, driving a real agent, with a client that replays
exactly what the Telegram bridge does: send, and on an `error code:busy` send an
Escape then resend once `turn-done` arrives (`shouldPreempt`, PR #158).

Sweeping the gap between the two messages:

| gap | result |
|---|---|
| 0 ms | both answered |
| 150 ms | both answered |
| 600 ms | both answered |
| **1200 ms** | **`submit: the text never appeared in the input box` — and NEITHER message answered** |

The gap matters because of what the Escape meets. Below ~600 ms the first
message is still being typed, there is no turn yet, and the Escape does nothing
a retry cannot absorb. Around a second, the turn is genuinely running — and
that is the case the user hits, since two messages typed by a human are a second
or two apart.

A pane trace, captured every 250 ms, shows the whole thing:

```
1832ms |      | ⟦telegram · …⟧ ⏎ MSG-ONE: count slowly from 1 to 30…
2617ms | WORK | (empty)                      ← Enter accepted, turn running
3141ms |      | ⟦telegram · …⟧ ⏎ MSG-ONE: count slowly from 1 to 30…
4185ms |      | ⟦telegram · …⟧ ⏎ MSG-ONE: …ALPHA⟦telegram · …⟧ ⏎ ⟦telegram · …⟧ …
```

At 3141 ms the Escape has landed and **Claude Code has put the interrupted
prompt back into the input box**. At 4185 ms the resend is pasting into it.

## Why that broke everything downstream

`typeIntoBox` watched `inputText` — the `❯` line, and only that line. The box is
multi-line: continuation lines carry no marker. So with MSG-ONE's header sitting
on the `❯` line:

- the paste landed on a continuation line → the watched line never moved → "the
  text never appeared";
- the recovery's "is the box clear?" compared that same unmoving line → it read
  as already clear → Ctrl-U was pressed once and the loop broke out;
- the next attempt pasted again.

Six attempts, six copies of the header stacked in the box, one error to the
user, and both messages lost — the first because its turn was interrupted before
it answered, the second because it never reached the TUI.

## The fix

**Read the whole box.** `boxText(screen)` returns everything between the `❯`
line and the composer's bottom border (or the status line, for a screen that
carries no frame — that line moves on its own as background shells come and go,
and swallowed into the box it would read as a paste that landed). Every check in
`typeIntoBox` now uses it, and so does the Enter-phase "has it been sent?"
predicate in both pilots.

**Then ask whether the paste replaced what was there, or joined it.** A box that
reads non-empty is usually a GHOST: Claude Code offers a previous message as a
greyed-out suggestion. Verified on 2.1.301 — typing replaces it, while Ctrl-U,
Ctrl-K and Escape all leave it exactly where it is, and backspacing to empty
brings it back. A plain `capture-pane` renders that ghost and real restored text
identically, so the code does not try to tell them apart: it pastes, then checks
whether what the box held is still in it. Replaced → done, first try, nothing
spent. Still there → the attempt is thrown away, the box is emptied, and the
next attempt starts clean.

That ordering is deliberate. Clearing the box BEFORE pasting would be simpler
and would charge **every** message a Ctrl-U and a 400 ms wait to find out what
is in a box that is almost always just a ghost. The cost is moved onto the rare
case instead: one discarded attempt, about a second, when the box really was
dirty — or when you send the very same message twice in a row, where the ghost
carries your own words and the check cannot tell the difference.

**And keep an interrupt away from a submit in flight.** `busy` covers the
stretch where the prompt is being TYPED, so a message arriving then is refused
with `busy` and the bridge answers with an Escape — aimed at a turn that does
not exist yet. Pressed on a box being filled, it deletes the text; a box that
then reads empty is exactly what `submit` takes for "the prompt was sent", so
the first message disappears with no error at all. `submitGuarded` (server)
HOLDS such a key until the submit has landed and presses it then, where it
interrupts the turn it was meant for.

## Verification

Twelve rounds on the bench across gaps 0–2800 ms, before and after:

- before: 1200 ms failed on both attempts, with no answer at all;
- after: **zero submit failures**, the second message answered every time, each
  round back to 9–12 s (the dirty-box detour costs ~1 s, not the ~8 s an
  appearance timeout would).
- The same message sent twice in a row: answered in 2.2 s, the same as the
  first.

Unit tests pin the parts a bench cannot: `boxText` against real captures
(wrapped prompt, shell mode, the moving status line), `typeIntoBox` against a
fake box that holds leftover text and clears one line per Ctrl-U, and
`describeStuckScreen` naming a full box — but NOT the one-line suggestion, since
a confident wrong diagnosis is the thing that function exists to avoid.
