# The pushed ledger block goes in as its OWN paste

Status: implemented (2026-10-13)
Follows `2026-10-13-ledger-kind-and-headline.md`, which found the defect and
worked around it. This removes the cause.

## The defect

`pilot.submit` puts a prompt into the TUI as a **bracketed paste**. Claude Code
decides per paste whether to keep it inline or collapse it into
`[Pasted text #N +M lines]`, which the transcript then carries as
`<pasted_content>` — material its own system prompt describes as pasted from
somewhere else, to be acted on *only where the user's own message asks*.

Read off the 2.1.x binary, the rule is two hard-coded constants:

```js
if (body.length <= xK && R$(body) <= 2) { /* stays inline */ }
else { /* collapsed → <pasted_content> */ }
// R$ counts newlines; xK = 800
```

So: **≤ 800 characters AND ≤ 2 newlines (3 lines)**. There is no setting, no
environment variable, nothing to turn off — and nothing should be: marking
pasted material as not-the-user's-words is correct in general.

What was wrong was ours. The ledger delta was **concatenated into the message**
and the whole thing pasted as one blob, so both fell on the same side of that
line. With a block in front, the human's message was inside the wrapper and
stopped being an instruction. A live agent answered a direct order with:

> "Your last message contained only pasted text, with no request of your own
> alongside it. […] I haven't acted on that line, since it came from the pasted
> text and not from you directly."

Measured on 486 real human prompts from this machine's transcripts: **0 of 324
wrapped at ≤3 submitted lines, ~30% of 162 at ≥4** — in absolute terms 85 real
prompts, 24% of every prompt that carried a block.

The previous change made the block one line and budgeted it to 320 characters.
That kept the *total* under the cliff and was verified to work, but it bought
correctness with a size limit, and the limit would bind again the first time a
delta or a human message grew.

## The fix

Paste the block **separately, first**; paste the message **second**.

The threshold is applied **per paste**, not to the assembled text — and only the
*current* paste is eligible to stay inline (`us()` keeps earlier blocks in their
collapsed form: `if (y.id !== o) { u += y.raw; continue }`). So the message, as
the last paste, is judged on its own, and a block too big to stay inline is
wrapped by itself with the message outside it.

`typeIntoBox` takes a `prelude`; both pilots take it through
`submit(text, prelude?)`; the server passes the formatted block there instead of
prepending it to the text.

Measured end to end on a live agent, with the real server path:

| case | submitted | wrapped | agent |
|---|---|---|---|
| one-line block + one-line message | 2 pastes | **none** | obeyed |
| one-line block + **two-line** message (4 lines total — over the old cliff) | 2 pastes | **none** | obeyed |
| 5-row block (345 chars) + message | 2 pastes | **none** | obeyed |
| 1138-char, 8-line block + message | 2 pastes | block only | obeyed |

The first three used to be wrapped roughly a third of the time; now nothing is.
The fourth is the case the 320-character budget cannot carry at all, and it
still delivers the message intact.

## Two ways to get the wait wrong, and both were hit

`typeIntoBox` returns once it believes the text is in the box. With two pastes
that judgement needs a baseline, and the two obvious ones are each broken in
opposite directions:

- **Against the state after the prelude, read through `inputText`.** That helper
  returns the `❯` line alone, so once a prelude has saturated the first visual
  line, everything appended lands on continuation lines and it stops moving. The
  wait times out on a paste that arrived perfectly: six attempts, six Ctrl-U,
  `the text never appeared in the input box`. Hit on a live agent.
- **Against the state before the prelude.** Then the prelude alone satisfies it:
  `typeIntoBox` returns while the message is still in flight, the caller presses
  Enter, and the agent is sent the ledger block with nothing under it. Silent,
  and the user's prompt is simply gone.

So the check is: the box is non-empty *and* — when there is a prelude — the whole
SCREEN has moved since the prelude landed. With no prelude it is byte-for-byte
the condition that was there before. `test/detect.test.ts` fails on both wrong
baselines, which is the only reason to trust it.

A prelude that never lands does **not** fail the submit: the message is pasted
anyway. Losing the injected context is survivable; losing the user's message is
not.

## What stays

The one-line block and its 320-character budget stay, on a different argument.
They no longer carry correctness — they cap the recurring per-turn cost (~90
tokens whatever the delta holds) and keep the block under the 800-character
limit so it stays inline rather than being wrapped. If both ever fail, the
wrapper is now harmless to the message.

`markLedgerBlock` is no longer on the live path. It is kept because it is the
exact shape of every transcript written before this change, which
`stripLedgerBlock` must go on understanding.

`stripLedgerBlock` gained one thing: it eats the blank line the peeled wrapper
leaves behind. `userPromptText` strips the `<pasted_content>` tags but not the
gap, and a leading blank line stops `parsePromptMeta` recognising the
`⟦platform⟧` header — which loses the sender and leaves the header visible in
the chat.
