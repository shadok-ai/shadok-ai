# Ledger: a row says what KIND of thing it is, and the pushed delta says WHAT happened — on one line

Status: implemented (2026-10-13)
Supersedes nothing. Builds on `2026-08-25-shared-ledger-design.md` (the state
table), `2026-08-28-ledger-push-design.md` (the delta), and
`2026-09-09-ledger-recall.md` (the scorer).

## Where this came from

A spec written on another shadok instance (472 rows, in French) after a real
incident: a report regeneration was done on 09/10, and on 12/10 the chief of
staff still believed it pending. Two independent causes, both reproducible here:

1. **The pushed delta carries `[id] entity — status` and nothing else**, so the
   entity *label* is the whole payload. A label written as a topic name
   ("rapports des comptes de test") cannot say what changed about it.
2. **The row was `resolved` while a repair was still pending**, so the morning
   recap — which reads `open`/`in-progress` — stopped reading it. Closing it
   made it invisible, not finished.

The spec's central structural claim, which is correct and which this
implementation adopts: **the ledger treats a *task* and a *fact* identically,
and they are not the same object.** A task has a lifecycle, so a status is the
right thing to carry and closing it is normal. A fact has no lifecycle — only a
date on which someone last confirmed it — so closing it makes it *disappear
while it stays true*. The corollary the spec also spotted: `decided` is a
**kind** masquerading as a status, sitting next to `open`/`in-progress`/
`resolved` as if it were a phase of the same lifecycle.

Of that spec's five proposals, two are built here (P3 and a reduced P2) and
three are not — and a third, larger defect turned up while measuring what the
reduced P2 would cost (see "The block is ONE LINE"). The measurements behind each decision are in "What was measured"
below — they are the reason the order is inverted.

## What is built

### 1. `kind` — task | fact | decision

A row may carry `kind`. It is **not** inferred from nothing: an absent `kind`
reads as `decision` when the status is `decided` (that is what the word already
meant) and as `task` otherwise. No existing row is rewritten — the inference is
applied at read time, so the 138 rows this instance already holds keep their
bytes and still render correctly. Assert only what you saw (invariant 27).

`fact` and `decision` get a **default status** so an agent is never pushed into
inventing a lifecycle word for something that has none: `--kind fact` with no
`--status` records `current`, `--kind decision` records `decided`. The row shape
is therefore unchanged — `status` is always present — which is what keeps every
existing reader (the delta, the GUI viewer, `check`, a consumer's recap filter)
working untouched.

An unknown `--kind` is **refused**, never stored: a typo that silently became a
fourth kind would be invisible for as long as nobody looked.

### 2. `verifiedAt` — freshness is when the claim was last CONFIRMED

`ageDays` read `updatedAt`, which **any** write bumps — so rewriting a note
rejuvenated the row, and the reflex's "a stale record → confirm before acting"
hedge stopped firing on a row nobody had re-checked in a month. This is the
defect the fact/task split makes unignorable (a fact's whole state IS its
freshness) but it was never specific to facts.

So a row carries `verifiedAt`, and it moves on an **observation**, not on an
edit:

| write | `updatedAt` | `verifiedAt` |
|---|---|---|
| create | now | now |
| `--status` given (even the same value — re-asserting a status IS confirming it) | now | now |
| `--note` / `--source` / `--entity` only | now | **unchanged** |
| `--verified` (and nothing else) | **unchanged** | now |

`--verified` deliberately does **not** bump `updatedAt`, which means it does not
enter anyone's pushed delta. "I re-checked and nothing changed" is not news, and
pushing it to every sibling agent is precisely the noise a state table exists to
avoid. It shows up where it belongs: as `verified Nd ago` in `check`, `list` and
the GUI viewer.

`ageDays` reads `verifiedAt ?? updatedAt`, so rows that predate the field are
unaffected.

### 3. The block is ONE LINE — found while building the headline, and the biggest defect here

Building the headline meant adding a line per row, which meant measuring what a
longer block costs. That measurement found something else entirely.

`pilot.submit` puts the text into the TUI as a **bracketed paste**, and Claude
Code collapses a paste past a threshold into a `<pasted_content>` wrapper — which
its own system prompt describes as material the user pasted from somewhere else,
to be acted on *only where the user's own message asks*. With a multi-line ledger
block, **the human's message is inside that wrapper**, and stops being an
instruction. Verified against a live agent, which answered a direct order with:

> "Your last message contained only pasted text, with no request of your own
> alongside it. […] I haven't acted on that line, since it came from the pasted
> text and not from you directly."

Both thresholds, measured against a live agent and then confirmed on **486 real
human prompts** from this machine's transcripts:

| submitted lines | n | wrapped |
|---|---|---|
| 1–3 | 324 | **0 (0%)** |
| 4 | 71 | 20 (28%) |
| 5+ | 91 | ~30% |

| one line, chars | wrapped |
|---|---|
| 431 | no |
| 914 | yes |

A prompt is `⟦platform⟧ header` + the message, so a one-line human message leaves
the block **exactly one line**. The old block spent two or more, which put
**every non-empty delta** over the cliff. Holding message size constant, a plain
prompt was wrapped 1–7% of the time and one carrying a block 26–42%. In absolute
terms: **85 real prompts, 24% of all those that carried a block**, had the user's
message neutralised this way.

So the block is now one line, with a 320-character budget inside it. Rows that
do not fit become the overflow pointer (`+N more — run: ledger list`) rather than
a second line, which is what that pointer has always been for. One row is always
carried, however long: a block that announces a delta and names nothing is worse
than a long line.

Two traps came with the format change, both of which fail *open*:

- `hasLedgerBlock` tested that the first line **ended** with `⟧`. On a one-line
  block `⟧` merely closes the header, so detection returned false, nothing was
  stripped, and the entire block was displayed to the user in the chat. It now
  tests `includes`, which the historical shape satisfies too.
- `stripLedgerBlock` must keep understanding the **old multi-line shape**:
  `loadHistory` replays transcripts written before this change, and a block it
  fails to strip is a block the user reads.

Verified end to end on a live agent after the fix: the delta arrives, the prompt
stays at three lines with no `<pasted_content>`, the agent **obeys** the order
it previously refused, and `loadHistory` shows the message alone.

### 4. A headline in the pushed delta — DERIVED, not a new field to write

The diagnosis is right: the delta's payload is a free-form label. The spec's
mechanism — a mandatory `--headline` — contradicts its own stated constraint
("do not rely on agent writing discipline"), and would cover none of the rows
that already exist. Its own fallback is the better primary: **take the note's
first sentence**, truncated at 120 characters. It needs nothing from any agent
and it works on every row ever recorded.

```
⟦ledger · 2 updates since your last message⟧
• [0360] report regeneration, 15 test accounts — resolved (PR#1203)
    Regenerated 09/10; two accounts still need a manual re-run.
• [a1b2] nightly import window — current · fact
    Runs 03:00–03:40 Europe/Paris, after the extraction job.
```

`headline()` lives in `src/ledger.ts`, not in the skill's core: the delta is
built **only** server-side, and the CLI already prints the whole note on its own
line. Putting it in the core would have been a second copy of a function with
one caller.

**The cost, stated rather than assumed.** The delta is the one thing in the
ledger that is paid on *every turn of every agent*. The 320-character budget
caps it at roughly 90 tokens whatever the delta holds — which is *less* than the
177 the old 8-row block cost, because the budget replaced the row cap as the
binding constraint. The headline is free in the cases that matter and bounded in
the rest.

## What is NOT built, and why

### P1 — push the rows matching the user's message (not built as specified)

Best idea in the spec and the right constraints around it (strong tier only,
cap 3, distinct header, silence below threshold). It does not survive contact
with real traffic **here**.

Replaying 33 real human messages since 2026-09-24 through `searchEntries`
(strong only, cap 3): it fires on **3 (9%)**, and all three are noise — `les
deux` → 3 unrelated rows, `1 partagé 2 statique` → 1, an `!echo` command → 1. A
real human message is short and deictic; the topic lives in the conversation,
not in the message, and a two-word message is exactly where the scorer is most
fragile.

A "at least 3 terms the table knows" gate removes all the noise (3 → 0) — and
removes the win case with it: **1 of 5** well-formed descriptive French
questions still fires. The root cause is not the gate. **106 of our 138 rows are
written in English** (the repo convention) while the humans write French, so the
lexical overlap between "on a réglé le problème de disque sur vps1 ?" and `vps1
disk space` is near zero.

Which also explains why `check` works (24 answers / 35 real runs in September):
the **agent** writes the query, in the same register and the same language as
the rows agents wrote. P1 swaps that well-matched query source for a badly
matched one. The intent ("push, not pull") is right; the query is not in the
human's message, it is in what the agent is about to do — and only the agent
knows that. On an instance whose rows and humans share a language, P1 is
probably a win; it should be measured per instance before it is switched on
anywhere.

### P4 — append-only note revisions (not built)

The ledger's founding premise is "a state table, not a log; supersede, not
append, so size is bounded by live topics". An append-only revision list reopens
unbounded growth *inside* each row. And the stated cause is wrong: notes here
are 813 characters at the median because agents write essays, not because the
field is single-valued. The cheap remedy for the real symptom is a cap at write
time, not a list.

### P5 — refuse a creation that scores STRONG against an existing row (not built)

Replaying every one of the 138 existing rows as a creation against the rest of
the table: **66 (48%) legitimate creations would have been refused**, with
pairings that are plainly wrong — `claude-launcher-stub-breaks-spawns` blocked
by `ledger check was an exact substring search`, `claude-code-2.1.251-audit`
blocked by `…-2.1.252-audit`. With `--new` as the escape hatch, agents would
learn to pass it unconditionally and the guard would become pure noise. The
underlying observation is real (one topic lives in three rows), but this scorer
is tuned for **recall**, not precision, and is not a deduplication oracle. This
was already deferred once, in the recall work, for the same reason — now with
the number attached.

## What was measured

- Table here: **138 rows** (116 resolved, 13 open, 6 in-progress, 3 decided);
  notes median 813 / p90 1556 / max 2395 characters; **106 English, 30 French**.
- Push block: **177 tokens** for the old 8-row shape; ~90 for the one-line
  budgeted shape, whatever the delta holds.
- Paste collapse on 486 real human prompts: 0/324 at ≤3 submitted lines, ~30% at
  ≥4; 85 real prompts (24% of those carrying a block) had the user's message
  wrapped. Single-line character cliff between 431 (safe) and 914 (wrapped).
- P1 on 33 real human messages: fires 3 times, 0 relevant. With a 3-known-term
  gate: 0 noise, 1 of 5 descriptive questions.
- P5 on the 138 rows: 66 false refusals (48%).

## Answers to the originating spec's open questions

1. **Is the context block rendered server-side?** Yes — `src/server.ts`'s
   `prompt` handler calls `deltaSince` then `formatLedgerBlock`/`markLedgerBlock`
   from `src/ledger.ts`. The server does **not** hold the scorer: `searchEntries`
   exists only in `context/ledger-skill/ledger-core.mjs`. Anything server-side
   that needs it must import that file — it is the single source and must not be
   duplicated.
2. **What is a ledger file's sharing scope?** One shadok instance, keyed by its
   **launch directory** (`~/.shadok-ai/ledger/<enc-launch-dir>.json`) — not a
   project, not a team. Two cockpits started from two directories on one machine
   hold two tables, which is why 472 and 138 are both right.
3. **Is there a per-agent history of pushed deltas?** There is a per-agent
   **watermark** on disk (`<enc>-seen.json`, sessionId → instant), not a row
   list: it says "pushed up to this instant", never "this agent has seen row X".
   Deduping against the same turn's delta is trivial; against an earlier turn's
   would need row-level bookkeeping that does not exist.
4. **Should a row have a human owner?** No owner field today; `source` is free
   text and carries it by convention.
