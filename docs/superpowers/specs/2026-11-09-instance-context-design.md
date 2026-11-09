# Instance context: one meta pre-prompt per instance

**Status:** design, shape approved by the operator in chat (2026-11-09);
awaiting doc sign-off, then a plan.

## Intent and the why

Every agent gets a role from its profile (`--append-system-prompt`: Boss, dev,
QA…). A role says *how* to work. Nothing tells an agent *what this instance is
for* or *who it serves*. The operator runs several instances, and each one has a
reason to exist that every agent on it should know from the first minute:

- correctsms and similar: side projects run with a few friends, to try to get
  businesses off the ground;
- this instance: the cockpit that drives shadok's own development and business;
- BioSense: the project with Michael.

Today every agent rediscovers that, or never does. The **instance context** is a
short text, owned by the instance, that every agent receives at spawn whatever
its profile, **in addition to** its role.

## The decisions (operator's)

1. **One context per instance.** Not per group, not per profile: an instance is
   always about one subject that concerns everyone on it. On an instance where
   people build unrelated things, the context simply says so ("each user builds
   what they want").
2. **Written at first run by the lead agent.** On a brand-new instance, once Claude
   is connected and `general` is born (the Connect Claude card, spec
   `2026-11-09-onboarding-connect-claude-design.md`), `general` asks the person a
   few questions about what the instance is for, then **writes the context
   itself**.
3. **Editable in the interface.** The human can read and change it at any time
   from the cockpit.

## The shape (operator approved the playback)

- **Short:** a handful of lines — the purpose, the people involved, the
  **language**, the tone or constraints that matter.
- **Language (operator, 2026-11-09):** the context states the instance's working
  language. `general` **deduces** it from the language the person answers in, and
  asks only when it cannot tell (e.g. a one-word answer). Where the conversation
  language and the language of deliverables differ — this instance chats in French
  but writes code, commits and docs in English — the context says both, so a
  freshly spawned agent does not have to guess either. Not documentation, not a project wiki.
- **Spawn-time, like the role:** an agent sees the context it was spawned with. A
  change reaches running agents at their next reload, exactly as a profile prompt
  edit does today (the UI says so).
- **After the first run, the human owns it.** `general` writes it exactly once:
  when it is empty, during first-run onboarding. Later, any agent that learns
  something that changes it may *suggest* an update in the chat; it never writes
  it. *(Call made in chat, not contradicted by the operator: an agent quietly
  rewriting the whole instance's purpose is the failure to avoid.)*

## Where it lives and how it reaches agents

- **Storage:** per launch directory in `~/.shadok-ai/config.json`, beside
  `cockpitTitle` / `cockpitTheme` (`instanceContextForCwd` /
  `setInstanceContextForCwd`), so two cockpits on one machine keep separate
  contexts. Plain text, length-capped (builder: ~2,000 characters is plenty; refuse
  above, never silently truncate).
- **Injection:** appended in `makePilot` as its own labelled section ("## This
  instance" or similar), as one more `--append-system-prompt` right after the
  profile's (which stays first, as the code intends), before the env note / pilot
  prompt / ledger reflex. *(Call, after the builder check: "before the role"
  would mean reordering `profileArgs`; the order of appended sections matters
  little and the role's position is load-bearing elsewhere. Verify once, live,
  that Claude Code keeps every `--append-system-prompt` value.)* Empty context →
  nothing added, not an empty heading.
- **No mass "stale" flag** *(call)*: the context is left out of the spawn-snapshot
  staleness comparison, so one Save does not mark the whole fleet out of date and
  trigger "Reload N agents". The editor offers restart-all explicitly instead.
- **Pre-prompt panel:** `src/preprompt.ts` `prepromptParts` gains an
  "instance context" section with its source, captured at spawn like the others,
  so "what did this agent actually get" stays answerable.
- **Multi-tenant:** the same text for every group and every OS user — it rides the
  same `--append-system-prompt` path as the role, so dropped agents get it with no
  file permission question.

## Writing it

- **Human, from the UI:** an "Instance context" editor (textarea + Save),
  browser-origin only, plus an admin role check when accounts are enabled (with no
  password, `browserOrigin` alone, exactly as `PUT /profiles`) *(call)* — it is the twin of `PUT /profiles` (a text every agent
  receives), so the same rule applies (invariant 26: an agent must not be able to
  write what every agent is told). Place: next to the cockpit title / theme
  settings, or in the version menu — builder's choice, one entry point.
  The editor says "Running agents see the change at their next reload" and offers
  the existing restart-all.
- **The lead agent, once:** a new agent-reachable route (e.g.
  `PUT /instance-context/first`), authenticated by `x-shadok-session-key`, that
  succeeds **only** when (a) the caller is the instance's home channel per
  `isHomeChannel` (so a Telegram-born General qualifies; a group's lead never
  does — the context is instance-wide) and (b) the stored context is empty. A
  human clearing the field re-arms it on purpose; no separate "written once" latch,
  and no persisted "asked" flag *(calls)*. Anything else → refused with a
  plain reason. Delivered to the agent as a small script in an existing seeded
  skill or a new one (builder's choice), with the copy rule "write it once, then
  suggest — never rewrite".
- **Telegram:** out of scope (no command for it in this pass).

## First run: the greeting changes

`src/greeting.ts` builds the lead's first message as a brief. Today it is
deliberately "an offer, not a form". With an empty context it becomes:

1. introduce yourself in a line;
2. ask **two or three** short questions about what this instance is for and who
   will use it (one message, not an interrogation); the language is deduced from
   the answer, asked only when unclear;
3. when the person answers, write the context (the once-only route), show it back
   in the chat in a few lines, and say where it can be edited;
4. then make the usual single offer.

If the person ignores the questions, nothing breaks: the context stays empty and
the cockpit works as today. The questions are asked once — not re-asked at every
boot.

**Existing instances** (already past first run, context empty): no automatic
interview. The editor shows an empty field with a one-line explanation, and a
button "Ask general to draft it" that sends the lead a hidden prompt to run the
same short interview (the once-only route still applies because the context is
empty). *(Call: an auto-interview landing on dozens of running instances after an
update would be noise.)*

## Goals / non-goals / anti-goals

- **Goals:** every agent on an instance knows its purpose from spawn; the context
  is born during onboarding with no setup work; a human can always read and edit
  it.
- **Non-goals:** per-group or per-profile contexts; a knowledge base or memory
  system (the ledger stays the place for status); Telegram editing; pushing
  changes into running agents without a reload.
- **Anti-goals:** an agent able to rewrite the instance's purpose after the first
  run; a long context that burns tokens in every agent; a first-run greeting that
  turns into a questionnaire the person must finish before anything works.

## Left to the builder

- Exact section heading and placement inside the appended system prompt, and the
  greeting copy (English, per conventions; the agent answers in the user's
  language as always).
- Where the editor sits in the UI (one entry point), and its mobile layout
  (invariant 28: 16px field on touch).
- Skill vs. script packaging for the once-only write; the refusal wording.
- Tests: pure pieces (the once-only verdict, the prompt assembly with/without
  context, the greeting brief with an empty vs. filled context), a source scan that
  the write route is browser-only for humans and session-key-scoped for the lead.
- Docs in the same PR: README (the feature), `docs/architecture.md` (prompt
  assembly), CLAUDE.md map/invariant if the write rule earns one.
