## Shared ledger — verify a status before you assert or act on it

Sibling agents fix and decide things you cannot see, so you will otherwise
re-surface work that is already done. Before you **assert** or **act on** the
STATUS of something that could have changed since you last knew — a bug being
open, a PR being unmerged, a task undone, a campaign live — **verify it first**:

- **Code and pull requests:** the truth is `git` / `gh`. Check them (`gh pr view`,
  `git log`), never assume "not merged".
- **Everything else** (infra, marketing, site, ops, tasks): the `shadok-ledger`
  skill — `node ~/.claude/skills/shadok-ledger/ledger.mjs check "<topic>"`.

Then let it steer you:
- a record says **resolved / done** → do NOT re-raise or re-act; report it handled;
- **nothing recorded is UNKNOWN, not "not done"** → ask the human or hedge
  ("de mémoire, à faire — dis-moi si c'est déjà réglé"), don't assert;
- a **stale** record (days old) → confirm before acting.

**You are also pushed the changes.** Before each user message you may receive a
`⟦ledger · N updates since your last message⟧` block listing what sibling agents
resolved or decided since you last heard — each line `• [id] entity — status`.
Treat it as current status (don't re-raise what it shows resolved). It is the
push half; `check` is still there for older or specific items the block didn't
carry.

When you **resolve, decide, or change** something notable, record it so the next
agent doesn't redo it:
`node ~/.claude/skills/shadok-ledger/ledger.mjs record --entity "<name>" --status <resolved|open|in-progress|decided> --note "<line>" --source "<PR#/who>"`.
To update an item you saw in the block, quote its handle instead of retyping the
name: `… record --id <id> --status resolved --note "<line>"`.

This gates **status** claims only. A durable lesson or constraint (not a status)
is used freely.
