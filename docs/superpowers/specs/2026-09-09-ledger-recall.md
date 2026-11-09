# `check` answers a question, instead of demanding the exact wording

*2026-09-09. Delivers what `2026-08-25-shared-ledger-design.md` deferred:
"word-overlap recall for `check` (a separate improvement)".*

## The report

> "The agents often told me that reading the ledger was hard — too restrictive,
> apparently an exact search. It should surface more generic items for a precise
> request."

## The measurement

`findEntries` matched the **whole normalised query as a substring** of the id,
entity or note. So `check` answered only when the caller already knew the exact
wording — which is precisely when they did not need to ask.

Fifteen queries agents really typed (pulled from the transcripts), each against
the row a human would obviously expect, on the live 64-row table:

**0 of 15 returned anything at all.** Not a wrong row — `n=0`, every time.

Three of them are worth naming, because the ledger's whole purpose is to stop
exactly what happened next:

| the agent asked | the row that was sitting there |
|---|---|
| `claude launcher stub spawn failure` | `[ed97] claude-launcher-stub-breaks-spawns` |
| `onboarding greeting` | `[b567] onboarding: home agent greets and reads the project` |
| `lancement HN Show HN Console.dev …` | `[dc2c] Show HN — shadok-ai` |

Each got `(nothing recorded — treat as UNKNOWN: ask or hedge, do not assert)`.
The reflex is built on that sentence, so a silent recall failure does not read as
a failure: it reads as *there is nothing here*, which is the silo the ledger was
built to close. One of those agents recovered only by guessing the hyphenated
name on a second try; the others did not.

The problem also grows with the table — 29 rows on 2026-08-30, 64 today.

## The design

Rank by **word overlap weighted by IDF**, computed over the table itself.

- **Tokens**, not substrings: lowercase, split on non-alphanumerics, drop
  1-character tokens, strip a trailing plural `s`. That alone is what makes
  `spawn failure` reach `…-breaks-spawns`.
- **IDF from the table**: a term in many rows is weak evidence, a rare one is
  strong. Self-tuning, and no hand-written domain vocabulary to maintain.
- **Field weight**: a hit in the `entity` counts 1, in the `note` or `source`
  0.7 — the details are real evidence, just weaker than the name. It BOOSTS, it
  does not cap: a query fully covered by a note must still be able to be a strong
  match (`apple ads chat frozen` lives entirely in one row's note).
- **Stopwords are derived, never listed**: a term in ≥4 rows *and* >40% of the
  table cannot discriminate. `to` is a stopword here, `ledger` is not, and no
  hand-written list would have got that right for this table.
- **A term the table has never seen is discounted, not ignored.** Ignoring it
  outright (penalty 0) is what let `recette de cuisine au chocolat` score a
  *perfect* match on the two French filler words it shares with a note — the
  query's actual subject was absent and the score never noticed. Counting it in
  full (penalty 1) throws away the long real query above, whose subject IS in the
  table under different words. The score divides by
  `known + 0.2 × unknown`; the sweep is in "Tuning" below.
- **A verbatim substring still wins outright** (score 1), so the old exact
  behaviour is a strict subset of the new one.

### Two tiers, because the UNKNOWN state is load-bearing

`searchEntries` returns `{ strong, weak }` — coverage ≥ 0.55 and ≥ 0.25.

A fuzzy search that always returns *something* would quietly destroy the
reflex's third state. "Nothing recorded is UNKNOWN, not 'not done'" only works
if the agent can still tell "here is your answer" from "here is something that
shares a word with your question". So:

- **strong** → printed as the answer, exactly as today (capped at 5).
- **weak only** → the UNKNOWN sentence is printed **first and unchanged**, then
  the related rows under an explicit *may NOT answer your question* heading
  (capped at 3). Leads, never an assertion.
- **neither** → today's message, untouched.

## Tuning

Fifteen real positives; ten negatives (topics genuinely absent — `kubernetes
helm chart rollout`, `stripe billing webhook`, `recette de cuisine au chocolat`…)
that must NOT produce a strong match.

| unknown-term penalty | positives strong / weak / **missed** | negatives false-strong |
|---|---|---|
| 0 | 13 / 2 / **0** | **2** |
| **0.2** | **12 / 3 / 0** | **0** |
| 0.35 | 12 / 2 / **1** | 0 |
| 0.5 | 12 / 1 / **2** | 0 |
| 1 (old strictness) | 12 / 1 / **2** | 0 |

0.2 is the only value with neither a miss nor a false strong. Raising the weak
threshold past 0.25 trades a real recall (`0.3` → 1 miss) for a little less
noise on absent topics; recall wins, because a weak row costs the agent one line
of reading while a miss costs a re-surfaced resolved issue — the failure this
feature exists to prevent.

## Out of scope

- **Near-duplicate detection on `record`.** The same scorer would flag that
  `home agent greeting (onboarding step 2)` and `onboarding: home agent greets
  and reads the project` are one topic in two rows — the table has a few such
  pairs. That is a WRITE-side change with its own failure mode (a wrongly merged
  row loses a status), and the ask here was about reading.
- Synonyms, embeddings, or anything needing a model call: `check` runs inside an
  agent's shell on a table of dozens of rows.
