# shadok-ai — vision and roadmap

**Status:** direction, not a commitment. The vision, advantages, principles and
pillars below are the owner's decisions. The **sequencing is proposed, to be
confirmed by the owner**. Nothing here is a promise of a date, and nothing in
the Roadmap is built unless the "Now" section says it is.

## 1. Vision

A place where a small, non-technical team works with agents as team members.
They chat with them, delegate to them, follow their progress, and let them talk
to the outside world on the team's behalf.

Today shadok-ai is a cockpit: one person drives many real Claude Code sessions
in parallel, in a browser or from Telegram. In two to three years the person at
the controls is no longer a developer. The target user is a **founder or a small
non-technical team** running a multi-discipline agent team — dev, QA, product,
marketing, content, support — and judging it by what ships, not by how it is
wired. The agents are participants: you @mention them, hand them work, and hear
back when it is done, blocked, or needs a decision.

The test of the vision is whether a person who has never opened a terminal can
get a week of useful work out of such a team and never be surprised by anything
that left the building.

## 2. Why us — durable advantages

Three things are hard to copy and compound over time.

- **It runs on the subscription the user already pays for.** There is no API
  bill by default. A small team can start with what it has, and the cost of
  trying an agent team is the cost of a subscription it may already hold.
- **It drives real Claude Code.** The agents are the official CLI, not a
  reimplementation. Every upstream improvement — better models, new tools,
  better context handling — reaches shadok-ai without us writing it. The price
  is coupling to a TUI (see Risks); the return is that we never fall behind the
  agent itself.
- **Guardrails and shared memory make autonomy trustworthy.** Profiles (role
  plus permission guardrails), the secrets vault, the shared ledger and
  parent/child notifications are what let an agent act without someone
  watching. Raw agent power is cheap; agents a team can *trust to run
  unattended* are not, and this is where the project has already spent its
  effort.

A fourth, softer one: the product largely **builds itself**. Agents running in
shadok-ai write shadok-ai, which keeps the team honest about what it is like to
use.

## 3. Principles

These decide trade-offs when two roadmap items pull in different directions.

1. **Humans decide what goes out.** Merge, deploy, publish, send: an agent may
   prepare and propose; a person releases. Autonomy grows in explicit steps,
   per action and per agent, never by default.
2. **Silence by default.** An agent with nothing to say says nothing. Scheduled
   work is guarded by a check that runs without the model, and "nothing to
   report" costs no tokens and pings no one. A tool that cries wolf trains its
   users to ignore it.
3. **The product builds itself.** Features are specified, built by agents in
   isolated worktrees, and landed as reviewed changes. If a capability is too
   awkward for our own agents to use, it is not ready for a customer's.
4. **Assert only what was observed.** Read state from an exit code, a file or an
   API rather than the prose next to it; say "unknown" when we could not look.
   This applies to the code and to the UI copy: a dashboard must not claim a
   figure it did not measure.
5. **Say it in the user's words.** A non-technical user should never meet a
   branch, a diff or a worktree unless they asked to. The vocabulary is part of
   the product.

## 4. Roadmap

Three horizons, themes only, no dates. Order inside a horizon is not a ranking.

### Now — what exists

Stated as the README and CLAUDE.md state it, so this document does not drift
from the product:

- Many real Claude Code sessions in parallel, each in its own git worktree,
  driven from a browser chat or Telegram, with permission prompts and questions
  answered by a click.
- Agents that start other agents and are told when their own children finish,
  block or die.
- Profiles: shipped roles with permission guardrails, a model and the secrets
  they may receive; a secrets vault kept outside the repository.
- Scheduled prompts with a deterministic, model-free guard.
- Quota gauges for the 5h and 7d windows, with an optional pace guard.
- A shared ledger agents can check before asserting a status (opt-in per
  instance).
- Web accounts with roles and invitations, per instance; a lead agent and a
  first-run greeting; a diff panel; self-update with release channels.
- Known limits worth restating: guardrails are **soft** (same OS user, not a
  sandbox), and one instance serves one launch directory.

### Next — make it useful to a team that does not code

The themes that turn a developer's cockpit into a team's workspace. Proposed
order is in "Sequencing" below.

- **Connectors.** One-click connection to external tools — Google Workspace,
  Microsoft 365, and social accounts such as Instagram, X and Facebook — that
  fills the vault and attaches the right profile, so the user never handles a
  token. Start with the stable, high-value ones. Social APIs are restrictive and
  change without notice; each connector is a maintenance commitment, which is
  why the first ones are chosen for stability, not for glamour.
- **Multiple compute accounts.** Several subscriptions and/or API keys, each
  assignable to an agent, a group, a role or a workflow, with a quota gauge per
  account. The **data model comes first** in this horizon: accounts as named
  objects an agent resolves at spawn. Automatic fallback and load spreading
  come later, once the model has proven itself. Agents facing the public run on
  a dedicated API key.
- **Cost tracking.** Aggregate token usage from the transcripts — input, cache
  creation, cache read and output counted **separately**, since they are priced
  differently — per agent, role, workflow, account and period, and convert to
  dollars with a **versioned per-model price table**. For a subscription the
  figure is an **API-equivalent value, not money actually spent**, and the UI
  must say so. Read-only view first; budgets and alerts after; rebilling is a
  Later concern.
- **Deliverables, step one: a workspace file browser.** Read-only by default,
  scoped to the agent's workspace, and never able to reach the vault. Early,
  cheap, and a prerequisite for everything below: a non-technical user cannot
  review what they cannot open.
- **Approval inbox.** A single place where a person validates what goes out.
  This is the core of **graduated autonomy**: per action type, a threshold
  where an agent acts alone, proposes and waits, or must ask. It is where
  principle 1 becomes a screen.
- **Non-technical language in the UI**, and **compatibility tests across Claude
  Code versions** (see Risks). Neither is a feature; both gate the rest.

### Later — a workspace, then a service

- **Artifacts as first-class objects.** Versioned (draft → approved →
  published), living in the team space and tied to the approval inbox. An
  artifact is **untrusted, agent-written HTML**, so it needs sandboxing and a
  strict content-security policy from its first version, not as a hardening
  pass.
- **Supervised workflows.** A declarative *trigger → steps → agents* definition
  reusing what exists: guarded schedules, parent/child notification, the
  ledger. Later still, a **supervisor agent per workflow**, so humans see only
  exceptions and threshold approvals.
- **Public agents.** A website widget fronting a bounded, read-only support
  agent (a knowledge base, no secrets), with a handoff to the team channel;
  email and WhatsApp after that. This is the **first time the input is not a
  trusted human**, so it needs hard isolation, rate limits, a per-agent quota
  budget and a dedicated API key. Whether the subscription's terms cover
  end-user traffic must be **verified before anything is promised**; until then
  assume they do not.
- **Team workspace — a Slack alternative.** Human-only channels, threads, push
  notifications, a mobile PWA first (the web and Telegram already exist), native
  desktop and mobile later. Agents are participants you @mention rather than a
  separate surface.
- **Company memory.** A shared knowledge base: brand voice, decisions, facts the
  whole team and every agent should hold. The ledger is the seed; it is a
  status table today, not a knowledge base, and the gap is real.
- **Starter team templates** per business ("launch a content agency",
  "customer support"): a set of roles, schedules and connectors that arrives
  configured.
- **Audit log** of who or what did what, readable by a non-technical owner.
- **Multi-tenant / hosted.** Isolated spaces, accounts and invitations, and a
  managed service around the AGPL core. This requires **hard per-agent
  isolation** — a separate OS user or a container per agent — because today's
  guardrails prevent misfires but are not a security boundary.
- **Per-role cost and quota visibility**, building on cost tracking and
  multiple accounts.

### Sequencing — proposed, to be confirmed by the owner

1. Connectors.
2. Multiple accounts, together with cost tracking (they share the account
   model and the per-agent attribution).
3. File browser, then artifacts.
4. Supervised workflows.
5. Public agents.
6. The Slack-alternative workspace.

The approval inbox is not in the list because it is entangled with 1, 3 and 4:
each of them produces something that must be approved. The likely shape is a
minimal inbox alongside connectors, growing with each later step. That is a
suggestion for the owner to settle, not a decision.

The order has a logic worth keeping even if the list changes. Connectors give
agents something worth doing; accounts and cost make running many of them
affordable and legible; deliverables and approvals make their output reviewable;
workflows let them run without a person starting each task; public agents and a
workspace widen who can talk to them, which is the point where trust is hardest.

## 5. Risks and mitigations

- **Dependence on Anthropic.** The subscription's terms, its quota, and Claude
  Code's behaviour are all outside our control, and the main advantage (no API
  bill) rests on the first of them.
  *Mitigation:* stay on the official CLI rather than imitating it; keep an API
  fallback as a real option, and treat it as **mandatory for public agents**,
  where end-user traffic should not ride a personal subscription anyway.
- **Fragility of TUI driving.** Detecting a working turn, a dialog or a stuck
  screen means reading a rendered terminal, and those heuristics can break when
  Claude Code changes its interface.
  *Mitigation:* the transcript stays the source of truth for content and the
  screen is used for control only; add **compatibility tests across Claude Code
  versions** so a break is found by us before it is found by a user.
- **Autonomy versus human control.** More autonomy is the product's promise and
  its largest liability: an agent that publishes the wrong thing under the
  team's name does damage that cannot be recalled.
  *Mitigation:* humans keep the outbound acts (principle 1); autonomy rises in
  steps, per action type, through the approval inbox thresholds; the audit log
  shows what happened afterwards.
- **Soft guardrails meeting hostile input.** Guardrails today stop mistakes, not
  attackers. That is acceptable while every input comes from the team and stops
  being acceptable the day an input comes from the public or a tenant.
  *Mitigation:* the hard isolation named above is a **precondition** for public
  agents and hosted spaces, not a follow-up to them.
- **Connector upkeep.** Third-party APIs, especially social ones, tighten and
  change. *Mitigation:* few connectors, chosen for stability, each with an owner
  and a visible health state; a broken connector says so rather than failing
  silently.
- **Breadth.** This document lists far more than a small team can build at once.
  *Mitigation:* the horizons are themes, each step must be useful on its own, and
  anything that is not should be cut rather than half-shipped.

## 6. Open questions

Listed, deliberately not answered here.

- **Business model of the hosted offer.** Who pays — the team, a reseller, the
  user's own subscription or key? Roughly what price? The answer shapes how
  multi-tenancy, cost tracking and rebilling are designed.
- **Is there a milestone date to anchor the horizons?** Without one, Now / Next /
  Later are an ordering, not a plan, and "Next" can stretch indefinitely.
- **Exact scope of the API fallback.** Only for public agents, or also when a
  subscription's quota is exhausted? Per agent, per account, or per workflow?
  Who sees the bill?
- Two smaller ones the above implies, flagged for the owner to keep or drop:
  where the approval inbox first appears in the sequence, and how much of the
  workspace (Slack-alternative) must be native before a mobile PWA stops being
  enough.

## 7. Non-goals

A proposed, honest list. Each is cheaper to say now than to reconstruct later.

- **Not a general-purpose agent framework or SDK.** The product is a cockpit and
  a team workspace around Claude Code, not a toolkit for building arbitrary
  agents on other models.
- **Not a replacement for Claude Code.** We drive it; we do not fork, wrap or
  reimplement its tool loop.
- **Not a developer-only IDE.** Developers remain welcome and the cockpit stays
  useful to them, but the roadmap is judged by whether a non-technical team
  benefits.
- **Not unsupervised publication.** No default that lets an agent post, send,
  merge or deploy without a person's decision.
- **Not a security sandbox for the current deployment.** Guardrails are soft
  until hard isolation exists; we will not market them as more.
- **Not an enterprise suite yet.** No SSO, compliance regimes or custom
  integrations as commitments; they may follow the hosted offer and are not part
  of this vision.
- **Not a promise about subscription use by third parties.** Nothing here
  assumes end-user or resale traffic may run on a personal subscription until
  the terms say so.
