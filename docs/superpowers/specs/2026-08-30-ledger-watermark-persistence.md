# The ledger watermark survives a restart

*2026-08-30. Supersedes the "out of scope" bullet of
`2026-08-28-ledger-push-design.md`, which called an in-memory watermark "fine
for near-real-time". Measured against a live instance, it was not: two pushes in
three never arrived.*

## The report

"The ledger works well? I get the impression the messages aren't always sent."

## The measurement

Cross the 29 rows of a real instance's ledger against the prompts its agents
actually received since 2026-08-25. For each prompt: were there rows changed
since that agent's previous prompt, and did a `⟦ledger⟧` block arrive?

| agent | block delivered | **missed** |
|---|---|---|
| general | 1 | **5** |
| PR | 5 | **11** |
| onboarding | 2 | **4** |
| claude code follow | 4 | **5** |
| bug | 1 | **3** |

One agent, prompted at 23:34 with **12 updates pending** — including every PR
merged that evening — received nothing.

## The root cause

`attachPilot` did `s.ledgerSeenAt ??= Date.now()`: everything preceding the
attach counts as seen. A `Live` is rebuilt on **every server restart** — so on
every auto-update — and again whenever a dormant channel is woken. The watermark
jumped to now and the next `deltaSince` returned empty.

The correlation is exact, and it is the worst possible one. The merges that
evening (local) landed at 20:45, 21:13, 21:20, 21:28, 21:31, 21:39, 22:35,
23:03; every one of them published a version, every publish triggered an
auto-update, and every update reset every watermark. **The moment the ledger is
busiest is the moment its deltas are erased** — and the four cron fires that
missed their block sit on those very minutes. Nothing surfaces: an empty delta
and a delta that was wiped are the same absence of a block.

Two hypotheses ruled out on the way, both by reading the transcripts rather than
the code: the cron / agent-notification path *does* carry the block (#179 works),
and the legacy global `ledger.json` has not been written since the per-instance
migration on 08-28, so there is no split-brain between tables.

## The fix

Persist the watermark next to the table it tracks: `<enc launch dir>-seen.json`,
a `sessionId → instant` map, pruned on write against the live channel list
(bounded by live topics, exactly like the table).

- `attachPilot` reads it back: `seenFor(...) ?? Date.now()`.
- `seenFor` returns **`undefined`**, never 0, for a session it does not know.
  That distinction is the whole design: no record means a genuinely NEW agent,
  which still anchors to now (no history flood); a record means an agent that
  came back, which gets its backlog, bounded by `LEDGER_PUSH_CAP` (8) and its
  `+N more` line.
- The advance moves to **after** `pilot.submit` resolves. Advancing before it
  meant a submit that threw — a wedged screen, invariant 23 — burned the block
  for good. A lost *write* costs a duplicated block next turn; a lost *block* is
  silent and permanent, so the asymmetry decides the ordering.

A concurrent write from two agents prompting at once is last-write-wins on an
atomic rename. The loser re-receives one block it had already seen. Same
asymmetry: a duplicate over a loss, every time.

## Verified

Unit: the watermark round-trips, an unknown session reads `undefined`,
`pruneSeen` drops closed agents and never the one being written.

End to end, on a throwaway instance on a free port: prompt an agent (watermark
written to disk), record a row, **kill and restart the server**, prompt again —
the block arrives, carrying the row recorded while the server was down. A
freshly spawned agent on the same instance, with 22 older rows in the table,
receives nothing on its first prompt.

## Still out of scope

- Filtering an agent's own writes out of its delta (unchanged from #179).
- Any notion of acknowledgement: the watermark records what was *pushed*, not
  what was read. An agent that ignores its block is not the ledger's problem.
