# Ledger: the pushed block names three rows, not one — budget, order of service, and the paste rule re-read

Status: built (2026-10-14)
Follows `2026-10-13-ledger-kind-and-headline.md` (the block's content) and
`2026-10-13-ledger-prelude-paste.md` (#261, the block as its own paste).
Written against a proposal from a sibling instance, whose §1/§2/§3/§4/§5 are
largely taken and whose premise about the paste cliff is corrected.

## The premise moved under the proposal

The proposal budgets the block against the cliff measured in the first spec —
"431 safe, 914 wrapped" — and asks for 430 on the grounds that it is free. That
measurement was of the WHOLE prompt, back when the block was concatenated into
the user's message. #261 (merged, `de97ca0`) made the block its own paste, so it
is judged ALONE, and by a rule read out of the binary rather than bisected:

```js
if (y.body.length <= xK && R$(y.body) <= 2) { /* stays inline */ }
// var xK = 800 ; R$ counts newlines
```

Three things follow, and two of them are corrections:

- **The cliff for the block is 800, not 430.** 430 is not "free against the same
  measurement"; it is a third of the room there actually is.
- **The defensive clamp was never the hazard it was reported to be.** The
  proposal notes `BLOCK_MAX * 2 = 640` sits past the 431 cliff and could itself
  cause the wrapping #261 removed. Post-#261 that clamp is inside 800, so it
  could not. (It is still replaced here, by an explicit `LINE_CEILING = 700`, so
  the number says what it is instead of being a multiple of something else.)
- **Two newlines means the prelude may carry a SECOND line.** The proposal's §6
  closes on "a separate line is not available (the paste cliff)" and leaves the
  tension unresolved. It is available. The delta keeps the first line; the second
  is free, and is deliberately left free here.

## What was built

### Labels before headlines (their §4) — the one change that matters

`formatLedgerBlock` appended row *i*'s headline before testing whether row *i+1*
fitted, so the first row's detail outbid the second row's existence. Measured on
this instance's own table, a delta of 2, 3, 5, 7 or 9 rows named **exactly one of
them, every time**, with 50-odd characters of the budget unspent. The sibling
instance reported the same symptom on a table 3.6× larger with labels twice as
long — so the cause is the order of service, not the labels.

Now: every row that fits is named first, then headlines are distributed over what
remains, first row first. A headline is only ever served **whole** — a sentence
cut by whatever happened to be left is the defect `HEADLINE_MAX` already exists
to bound, and the cut can invert the meaning it loses.

### The budget is expressed in ROWS (their open question 1)

`ROWS_TARGET = 3`, bounded by `BLOCK_MAX = 560`. Their question was whether
`BLOCK_MAX` should be per-instance, since a table whose labels average 156
characters and one whose labels average 37 do not want the same constant. They
do not — but the per-instance knob is the wrong shape for it. What the reader
needs ("there are nine; here is who three of them are") is the same everywhere;
only its price differs. So the rows are the budget and the characters are the
bound: a short-label table pays less for the same payload, a long-label one pays
more, up to the ceiling. Nothing to configure, and nothing drifts when a table
grows.

### The headline cap: 120 → 160 (their §3)

Their case is exact: a real `decision` row whose first sentence is 126 characters
was cut to `… aucune action directe déclenchée par…`, losing the complement that
carried the decision — what remains can be read as its opposite. On this table,
19% of notes were cut at 120, 13% at 160, 9% at 200.

It stops at 160 rather than their proposed "160, and never cut within 200",
because a headline is served whole or not at all: past the labels, the room left
is ~160, so a larger cap does not buy better headlines, it buys **fewer** of them.

### The overflow carries ids (their §2), and never overstates them

` • (+8 more — run: ledger list)` spends 31 characters to say nothing; the ids
cost ~68 and are the handle `record --id` takes and `check` resolves.

One correction to their format. The delta is **capped** (`LEDGER_PUSH_CAP = 8`)
while `total` is the full count of changed rows, so the rows we hold can be fewer
than the rows we are short of — their own example announces `+7 : <7 ids>` where
8 were unnamed. The mark therefore has two honest shapes:

```
 • (+5 : 95fb ec75 a90f f469 e480 — run: ledger list)      we hold them all
 • (+54 more, 5 newest: 3f8e 2fcb 456a 8371 9ba6 — …)      we do not
```

### A label is capped in the block, warned about at write (their §5)

Their diagnosis of their own instance is right and worth keeping: labels grew
into sentences once the headline shipped, which is a note wearing a label's
clothes, and it is what took their rendered row to a 156-character median.

They propose a write-time cap, "warn and keep, do not refuse". Taken — a refused
write is a lost fact — but a warning alone only asks for the writing discipline
the `--headline` refusal already declined to rely on. So both ends: the CLI warns
(it teaches, and the table keeps the full text, which `check` and `list` still
print whole), and the block truncates at `LABEL_MAX = 80` at render time (it
guarantees, whatever any agent writes). The `[id]` is unaffected and remains the
handle to quote.

## What was measured

Against this instance's live table (144 rows) and its real transcripts.

| | before | after |
|---|---|---|
| rows named, delta of 2 / 3 / 5 / 8 | 1 / 1 / 1 / 1 | 2 / 3 / 3 / 3 |
| block chars, same deltas | 302 / 302 / 302 / 302 | 471 / 529 / 522 / 537 |
| delta of 1 (156 of 365 real blocks) | 270 | 313 |
| ids offered for unnamed rows | 0 | all we hold |

Table shape here, for the record, against theirs: labels median 37 / p90 64 /
max 100 (4 rows over 80) where theirs are ~116; rendered bare row median 83 /
p90 108 / max 150 where theirs is 130 / 180 / 239. The format was the fault on
both; the labels are only theirs.

End to end on a throwaway instance (free port, tmux transport, production
answering throughout), a live agent driven through the real `prompt` path:

| case | block | wrapped | agent |
|---|---|---|---|
| 8-row delta, ordinary labels | 386 chars, 3 named + 5 ids | none | obeyed |
| 8-row delta, 150-char labels | 507 chars, 3 named + 5 ids | none | obeyed |

`loadHistory` returned the message alone with `from=admin` in both.

## Not built, and why

**P1 — push the rows that match the human's message.** Refused on this instance's
numbers (3 fires on 33 real messages, 0 relevant), explicitly scoped to "measure
per instance before switching it on anywhere". They measured it: 406 real
messages, 24 fires with a ≥6-word gate, **18 relevant** — same fire rate,
opposite precision, on an instance whose rows and humans share a language. That
earns it, and the objection they could not resolve (nowhere to put it) is gone:
the prelude's second line is free. What is deliberately NOT done here is building
it blind on another instance's measurement. It wants its own change, its own
per-instance flag, off by default, and this table to stay the way it is.

**The stopword gap they found on the way.** Stopwords are derived from the rows
(`df >= 4 && df > 0.4N`), so a word that is rare in a 498-row table but ubiquitous
in spoken French — `coup`, `partout` — reads as discriminating, and produced 3 of
their 6 noise fires. That is a defect in `check` itself, independent of P1, and it
costs precision today for every agent. It is not fixed here because changing the
scorer blind would undo the September recall numbers it was tuned against; it
needs the same treatment those got — real queries, before and after.

**P4 and P5** were refused with numbers and stay refused. One data point they
added for P4's file: overwriting a note destroyed the previous day's account of
how a spec was delivered, recoverable only from the repo's PR bodies. Still not
worth unbounded rows inside a state table.

---

# Addendum, same day: the delta carries ALL of it, in several pastes

Status: built (2026-10-14), after the above shipped.

The reasoning above — and the two specs before it — all took the paste threshold
for a ceiling on what the delta may carry. The admin asked the obvious question
nobody had asked: *the threshold is per paste, so why not several pastes?*

It is right, and it was measured before it was believed. Eight separate pastes
plus the message, into a live `claude` pane:

```
WRAPPED: false | chars: 1272 | rows present: 8/8   → the agent answered MULTI8
```

**1272 characters over nine lines, entirely in the clear.** A payload no single
paste can deliver by any formatting, because `800 / 2 newlines` is the size of
one paste and we choose how many there are.

So the ceiling was never the wrapper. What actually bounds the prelude is
**latency**: each chunk has to be waited for before the next is pasted, or two
reach the pane as one paste event and the split is undone. Measured against a
real pane, through the production `typeIntoBox`:

| delta | chunks | submit |
|---|---|---|
| none | 0 | 347 ms |
| 1–3 rows | 1 | 664 ms |
| 8 rows | 2 | 1.0 s |
| 20 rows | 4 | 1.65 s |
| 40 rows | 6 | 2.5 s |

~330 ms per chunk, which is the screen poll. Deterministic over five repeats.

## What that changes

The admin's requirement was *"I want all of it, otherwise we lose ledger
information that never got through"* — and that names the right asymmetry. A row
the reader is never told about is the silo this feature exists to close; a row
named without its sentence is one `ledger list` away. So the budget is spent in
this order and degrades in the opposite one:

1. **every** changed row gets `• [id] entity — status (source)`;
2. the newest `HEADLINE_ROWS` (3) also get `↳ <what happened>`;
3. only if even step 1 exceeds `PRELUDE_MAX_CHUNKS` (8) do the oldest rows
   collapse into the overflow mark, which still carries their **ids**;
4. and only when there are more than we hold does it fall back to a count.

`LEDGER_PUSH_CAP` goes from 8 to 40 — it was the thing turning a returning
agent's backlog into a number. At 40 rows everything is still named, in 6
chunks (~4400 characters). `ROWS_TARGET`/`BLOCK_MAX`/`LINE_CEILING` are gone:
nothing is sized against the wrapper any more.

`formatLedgerChunks` is the new shape of the block; `formatLedgerBlock` is the
same thing joined, which is what lands in the transcript and what
`stripLedgerBlock` removes (its bullet test is made on the TRIMMED line now —
a continuation chunk starts with the ` • ` separating two rows, and anchoring on
column zero would have left every chunk but the first in the displayed message).

## The one that could bite

The chunk ceiling is counted on the **packed** result, never estimated from a
character budget. Greedy packing leaves a chunk short whenever the next row does
not fit, so `chunks × PASTE_MAX` and the sum of the rows do not agree — the
first version computed room that way and produced **9 chunks against a ceiling
of 8**, caught only because the test counted the chunks rather than the
characters.

## Verified

`test/detect.test.ts` goes red if the chunks are pasted as one blob (checked by
making that regression on purpose), and pins that a chunk which never lands does
not take the message with it. On live agents, both transports, production
answering throughout:

| transport | delta | chars | lines | named | wrapped | agent |
|---|---|---|---|---|---|---|
| tmux | 20 rows | 2037 | 5 | 20/20 | none | obeyed |
| node-pty | 20 rows | 1994 | 5 | 20/20 | none | obeyed |

1107/1107 tests.
