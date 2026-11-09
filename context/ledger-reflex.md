## Shared ledger — verify a status before you assert or act on it

Sibling agents fix and decide things you cannot see, so you will otherwise
re-surface work that is already done. Before you **assert** or **act on** the
STATUS of something that could have changed since you last knew — a bug being
open, a PR being unmerged, a task undone, a campaign live — **verify it first**:

- **Code and pull requests:** the truth is `git` / `gh`. Check them (`gh pr view`,
  `git log`), never assume "not merged".
- **Everything else** (infra, marketing, site, ops, tasks): the `shadok-ledger`
  skill — `node ~/.claude/skills/shadok-ledger/ledger.mjs check "<topic>"`.
  Ask in plain language; it ranks by word overlap, so you need not guess the
  exact wording a sibling used.

Then let it steer you:
- a record says **resolved / done** → do NOT re-raise or re-act; report it handled;
- **nothing recorded is UNKNOWN, not "not done"** → ask the human or hedge
  ("de mémoire, à faire — dis-moi si c'est déjà réglé"), don't assert;
- rows printed under **"related rows — they may NOT answer your question"** are
  leads, not an answer: you are still in the UNKNOWN case above;
- a **stale** record (days old) → confirm before acting; the age shown is when
  the claim was last CONFIRMED, not when the text was last edited;
- a row tagged **`· fact`** has no lifecycle — `current` or `stale`, never
  "done": don't read its status as a position in open → resolved, and don't
  close it because surrounding work finished. A **`· decision`** stands until
  something supersedes it.

**You are also pushed the changes.** Ahead of each turn you are given — a user
message, or a scheduled/automated run — you may receive a
`⟦ledger · N updates⟧` block listing what sibling agents resolved or decided
since you last heard — `• [id] entity — status ↳ what happened`, all on one
line. Treat it as current status
(don't re-raise what it shows resolved). It is the push half; `check` is still
there for older or specific items the block didn't carry.

When you **resolve, decide, or change** something notable, record it so the next
agent doesn't redo it:
`node ~/.claude/skills/shadok-ledger/ledger.mjs record --entity "<name>" --status <resolved|open|in-progress> --note "<line>" --source "<PR#/who>"`.
Open the note with the sentence that says WHAT happened — it is what siblings get
pushed. For something with no lifecycle, pass `--kind fact` or `--kind decision`
instead of a status; to say you re-checked a row and nothing moved, `--verified`.
To update an item you saw in the block, quote its handle instead of retyping the
name: `… record --id <id> --status resolved --note "<line>"`.

This gates **status** claims only. A durable lesson or constraint (not a status)
is used freely.
