# Handing a file to the user — design

**Status:** approved 2026-09-25. Replaces nothing; sits beside `SendUserFile`.

## The problem, as reported

> « j'en ai marre de galérer à récupérer des fichiers, et j'en ai marre qu'il
> utilise les artefacts »

Two failures, one root. An agent that produces a file for the user either
prints a **local path** — a string the reader cannot open, because they are in a
browser or on Telegram and not on this machine — or publishes an **artifact**,
which is a page on claude.ai rather than the file they asked for.

shadok already renders a download card and serves the bytes (`GET /download`,
`src/download.ts`), but that path is reachable **only** through the harness's
`SendUserFile` tool. Two things make that insufficient:

- **It is not on every agent.** A tmux agent keeps the Claude Code binary it was
  spawned with — that is what lets it survive auto-updates — and the whole fleet
  runs pre-upgrade binaries (measured 2026-09-19: 67 panes of 67 on a binary
  already deleted from disk). An agent older than the tool will never see it,
  however the request is phrased. Observed on the `artisans` instance, which
  answered *"cet outil n'existe pas dans ma session"* and then invented a
  `fichier: /workspace/…` convention of its own.
- **Nothing tells an agent it exists.** Not the pilot prompt, not any skill. An
  agent that HAS the tool can still print a path, because no one said the reader
  is elsewhere.

## Decisions

Both taken by the user, 2026-09-25:

1. Artifacts are **forbidden by guardrail**, not merely discouraged.
2. Files are handed over through a **skill plus an endpoint**, not a watched
   drop directory and not by reloading the fleet onto a newer binary.

## Design

### A shadok-owned delivery path

`context/files-skill/` is seeded to `~/.claude/skills/shadok-files/` at boot,
like secrets / scheduler / ledger. That seeding is `copyFileSync` on every boot,
so **it reaches agents that already exist, with no reload** — the property the
pilot prompt does not have, and the one that matters when the fleet is old.

    node ~/.claude/skills/shadok-files/send.mjs <path…> [--caption "…"]

The script POSTs `{paths, caption}` to `POST /files` with the
`x-shadok-session-key` header. The server verifies each path, records it, and
then reuses everything that already exists: the chat's download / inline-image
card, `GET /download`, and the Telegram upload.

No dependency on `SendUserFile` — that is the whole point. It works on any
Claude Code build, including the ones already running.

### Where the record lives

`~/.shadok-ai/files/<enc-launch-dir>.json`, keyed like channels, crons and the
ledger. Per instance, so one cockpit can never serve another's files.

A row is `{sessionId, path, name, size, at, caption}`. It is a **registry of
offers**, not a copy: the bytes stay where the agent wrote them.

### Security

`GET /download` today can never be walked into an arbitrary file because the
path must appear in that session's transcript as a `SendUserFile` delivery
(`sentFilePaths`). That property is preserved exactly, with the registry as a
SECOND source of the same kind:

> a path is servable only if **this session** offered it.

- **Authentication** on write is the per-session key (invariant 33): derived,
  carrying no issue time, bound to a live channel. Not `SHADOK_AUTH`, which
  expires after a week and cannot be refreshed inside a running process.
- **Authorisation** on read is `registry(session) ∪ transcript(session)`.
- **Scope** is the launch directory, like every other per-instance store.
- **Headers** are unchanged: `X-Content-Type-Options: nosniff` and a `sandbox`
  CSP, so an agent-authored HTML or SVG cannot run script in the cockpit's
  origin even when opened directly.
- **Refusals are explicit** and say which path failed and why — absent, not a
  regular file, unreadable, over the size cap. A silently dropped file is the
  failure this whole feature exists to remove.

A registered path is not re-checked at write time for what it points at beyond
`isFile` + size: an agent runs as the same OS user and can read those files
anyway (the soft-isolation limit stated in the profile-guardrail invariant).
What the registry adds is that the cockpit only ever serves what an agent
DELIBERATELY offered, and only to that agent's own channel.

### Forbidding artifacts

`"Artifact"` joins the shipped roles' `deny` lists, beside `"Write"` and
`"Edit"` — bare tool names are already a valid rule shape there.

**Unverified at design time, and it must not ship unverified.** A settings-level
probe was inconclusive: a deliberately bogus tool name produces no warning
either, so "no warning" proves nothing about whether the rule binds. Before
merge, a throwaway agent carrying the rule is asked to publish and must be
refused. If it is not, the deny is dropped and the prompt half stands alone,
said out loud rather than shipped as a guardrail that only looks like one.

### What the agent is told

One paragraph in `context/pilot-prompt.md`:

- the person reading you is in a browser or on Telegram, **not on this machine**;
- do not publish artifacts;
- when your result IS a file, hand it over with the skill;
- citing a path stays right when the path is the point (`src/foo.ts:12` in a
  review) — attach when the file is the deliverable;
- **if a capability is missing, say so; do not invent a replacement
  convention.** Added because an agent did exactly that today, and a made-up
  `fichier:` line looks like a feature without being one.

Locked by a test, the way `test/skill-auth-docs.test.ts` locks the auth prose: no
code change can make it go red, which is precisely why documentation of a path
that never fails loudly needs one.

The two reach agents differently, and the difference is the reason both exist:
the skill lands at the next **boot** with no reload; the pilot prompt is fixed at
spawn and reaches only new or reloaded agents.

## Out of scope

- No heuristic that guesses a deliverable. Explicit or nothing.
- `SendUserFile` keeps working where it exists. The skill is the universal path,
  not its replacement, and `/download` honours both.
- No change to how artifacts behave for a user who deliberately re-enables them
  on a profile.
