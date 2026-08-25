# A shared ledger so agents stop re-surfacing what's already resolved

**Date:** 2026-08-25
**Status:** design — MVP scoped, phase 2 deferred until phase 1 proves out.

## Problem

Agents run siloed — one isolated Claude session + one worktree + an ephemeral
context each. The only cross-agent link is the parent→child kinship
notification (a tree, not a shared bus). So an agent has no reflex, and no
means, to check whether a bug / feature / action it is about to raise has
already been handled elsewhere. Two failure modes, both observed on a real
fleet:

- **Output:** an agent's report lists a broken job as an action to take — it was
  fixed days earlier by another agent.
- **Input:** an agent asked to change a PR says "since it isn't merged, I'll
  work on the branch" — it was merged in the meantime, so it acts on a false
  premise.

The record of "already resolved" lives in artifacts the agent doesn't consult:
merged PRs / commits (for code), and — crucially — **nothing at all** for the
non-code work (infra, marketing campaigns, site activity), where there is no
git, no diff, no merge event.

## Why not the naive answers

- **A daily digest pushed into every agent** fails three ways: cost scales with
  N agents and is re-sent every turn (bloat); it fires at the wrong time (a
  morning digest doesn't stop a 4pm stale assertion); and — the deepest reason —
  **information present in context ≠ information used at the decision point.**
  An LLM does not reliably cross-reference a line buried in a days-old digest
  against a fresh assertion. Observed: a fleet that already had a periodic
  digest re-surfaced a resolved item anyway.
- **Claude Code memory (CLAUDE.md / auto-memory)** has the right DNA (files +
  index + recall) but the wrong economics: it is *push* (loaded into every
  session, re-sent each turn), small, and curated — fine for "what every agent
  must always know," wrong for a growing, queryable "what's resolved."

## Design principles (converged through dogfooding discussion)

1. **Verify status against its SOURCE OF TRUTH, at the moment of asserting or
   acting.** The reflex is source-agnostic: `git`/`gh` where an authoritative
   source exists (a PR is just an entity backed by `gh` — **no PR-specific
   feature**), the ledger otherwise, and a **hedge** when neither answers.
2. **Pull, not push.** The cost is paid only by the agent that needs it, only
   when it needs it, and future agents get it for free.
3. **The ledger is a STATE TABLE, not an append-only log.** One current status
   per live *entity*, keyed by topic. A write **supersedes** the entity's row —
   it does not append. Size is bounded by the number of live topics (dozens to
   hundreds), not by activity or time. This is the answer to "won't it become
   huge?".
4. **Write is as narrow as read**, and happens at the **same moment**: only
   resolutions / decisions / state-changes / launched actions — never chatter.
   Because you check before you write, you see the existing row and update it
   (free dedup).
5. **Graceful degradation.** Every row carries freshness + source. A check
   against a stale/thin row makes the agent *hedge*, never assert with false
   confidence. So an imperfect ledger is never worse than none.

## The reflex (the behavioral glue)

Appended to the pilot prompt, so it reaches every piloted session:

> Before you **assert** or **act on** the STATUS of something that could have
> changed since you last knew (a bug being open, a PR being unmerged, a task
> being undone, a campaign being live): **verify it first** — `git`/`gh` for
> code and PRs, `ledger check <topic>` otherwise. If it's resolved, don't
> re-raise or re-act. If the record is thin or stale, **say so and ask** rather
> than assert. When you resolve / decide / change something notable,
> `ledger record` it.

Calibration is the real skill: a **status-dependent** item (an action whose
truth can change) gets verified-or-hedged; a **durable lesson/constraint**
(e.g. "don't buy the reverse-intent keyword") is not a status and is used
freely. Getting this distinction right is what separates useful from waffly.

## MVP — phase 1 (deliberately tiny)

The smallest thing that tests the core hypothesis: *does a report-time check
against a state ledger stop agents re-surfacing resolved things?* Dogfooded on
shadok's own development first, then the whole fleet.

- **Store:** `~/.shadok-ai/ledger.json` (per launch instance, like
  channels/crons/secrets — NOT the repo). A state table of records:
  `{ entity, status, note, source, updatedAt }`. Upsert by `entity`
  (supersede, never append). Pure read/write core, unit-tested.
- **Skill `shadok-ledger`** (seeded into `~/.claude/skills` at boot, twin of
  `seedSecretsSkill` / `seedSchedulerSkill`): a thin script with
  `check <query>` (fuzzy-match entities → status + freshness),
  `record <entity> <status> [note]` (upsert), and `list` (the whole table — a
  place to consult it). No server changes required.
- **Reflex:** the pilot-prompt paragraph above (`context/pilot-prompt.md`).
- **Toggle — OFF by default.** A config flag `ledgerEnabled` (default `false`,
  like `autoUpdate`/`permissionMode`). The **reflex paragraph is appended to the
  pilot prompt only when enabled** — a behavioural change that reaches every
  agent on the instance must be opt-in. The skill itself may be seeded
  regardless (a tool with no instruction is inert). Flip on → reload agents.

**Activation & companions.** The pilot prompt is applied at spawn
(`--append-system-prompt`), so a live agent only picks up the reflex after a
**respawn** (resume — it keeps its history). Two companion pieces make this
usable, shipped as their own small PRs:
- a **self-reload skill** (globally seeded), so an agent — or a lead — can
  reload itself to pick up a new prompt/skill;
- fixing a pre-existing gap found while scoping this: **`shadok-ai-agents` is
  not globally seeded** (unlike secrets/scheduler), so agents working outside
  the shadok repo don't have `pilotctl` — a `seedAgentsSkill()` twin.

**Explicitly OUT of the MVP** (phase 2, added only on evidence): the scoped
freshness *pin* (recent resolutions per domain, for the conversational case),
the *janitor* cron (dedup / archive-closed / flag-contradiction), auto-feeding
the ledger from git, per-domain partitioning, and a **GUI panel** to browse the
table (the CLI `list` covers consultation until then).

## What we observe (dogfood success criteria)

1. Do agents actually **run the check** at the right moments?
2. Does it **stop a concrete re-surface** (the marketing/PR cases)?
3. Does the table **stay sane over ~a week**, or drift into noise?

If all three hold → invest in phase 2. If the reflex doesn't even fire → we
learned it cheaply, before building the store-cathedral.

## Anti-rot (why it won't become "n'importe quoi")

- **State table + supersede** (principle 3) bounds size structurally.
- **Hot vs cold:** the queried set is open + recently-resolved; closed-and-old
  is archived out of the hot set (phase 2's janitor).
- **Narrow write** (principle 4) keeps signal high.
- **Graceful degradation** (principle 5) means imperfection is survivable.
- Honest scope: entity-resolution ("same thing?") and "notable enough?" stay
  fuzzy — tolerated *because* the hedge catches what the ledger misses.

## Phasing

- **Phase 1 (this spec):** store + skill + reflex. Dogfood, measure.
- **Phase 2 (on evidence):** freshness pin, janitor cron, git→ledger auto-feed,
  domain partitions.
