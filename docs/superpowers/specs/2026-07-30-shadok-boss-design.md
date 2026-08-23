# Shadok-Boss — a lead agent that delegates

Date: 2026-07-30
Status: agreed, implemented

## Problem

The `general` channel is the environment's first agent (`src/channels.ts` forces
its name): it is the one the user talks to first. Yet it had no role at all — a
bare Claude, handling every request itself.

But the point of the cockpit is to run **several** agents in parallel. The entry
agent should therefore mostly know how to *distribute* work.

And one gap made that impossible to do properly: `pilotctl.mjs` — the client
through which the `shadok-ai-agents` skill creates agents — did not know
`--profile`. The `start` WS message has accepted `profile` since agent profiles
landed. The result: **every delegated agent started as bare Claude**, with no
role, no guardrail, no secrets. A boss that delegates to anonymous agents is not
really delegating.

## 1. `--profile` in pilotctl

`parseArgs`: `--profile` joins the value flags (`--cwd`, `--resume`,
`--timeout`). `cmdSpawn`: `if (flags.profile) startMsg.profile = flags.profile`.
Nothing to change server-side.

The profile only takes effect on a **new** session: with `--resume` /
`--continue`, the session keeps the one it already had. That is the server's
existing rule, and the skill's documentation restates it.

## 2. The `Shadok-Boss` profile

The fourth entry of `DEFAULT_PROFILES`, **placed first**: it is the way in, hence
the first card of the "New agent" box.

- `deny: READONLY_DENY` — the same git writes blocked as for Marketing and
  Support.
- `secrets: []`, **no forced `model`** — consistent with the other three; the
  user pins one from the Profiles panel if they want.

**Why read-only is the heart of the design.** A boss that can commit ends up
fixing "just that typo" itself, then the function next to it, and stops
delegating. Blocked writes are not distrust: they are what makes delegation
mandatory rather than optional.

The system prompt gives it two jobs, in order:

1. **Know** — read the repo, `CLAUDE.md`, `docs/` and the history before
   answering; answer questions itself, conclusion first. Never make someone wait
   behind an agent when a read would do.
2. **Delegate** — all real work goes to a dedicated agent, via
   `spawn --worktree --profile <role>` then `prompt` in the background, with a
   brief that is executable without it; then read the `diff` and present it.

It picks the role (`Shadok-dev` for code, `Shadok-Marketing`, `Shadok-Support`),
**announces what it is spawning and why before doing it** (every agent consumes
the same quota as an ordinary session), never merges itself (invariant 9), and
never stops a session it did not create.

## Delivery

`seedDefaultProfiles` only seeds when the file is **empty**: adding the entry to
the code therefore gives existing installations nothing. The profile is also
created in the running vault through `PUT /profiles`.

## Tests

- `helpers.test.mjs`: `--profile` takes a value and does not leak into
  positionals.
- `spawn.test.mjs`: the `start` received by the mock server does contain
  `profile`.
- `profiles.test.ts`: the boss is read-only, first in the list, and its prompt
  mentions `shadok-ai-agents`, `--profile` and the three delegable roles — which
  must exist in `DEFAULT_PROFILES`.
