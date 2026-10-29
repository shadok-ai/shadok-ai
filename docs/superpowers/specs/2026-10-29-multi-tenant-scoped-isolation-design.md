# Multi-tenant cockpit: isolated groups, per-group OS users, scoped secrets

Status: **Draft for review** — revised 2026-10-29 (evening). Written from an
ongoing brainstorming conversation. Points settled in that conversation are
marked **[DECIDED]**; a call the author made that a builder could not settle
alone is marked **[CALL]**; points deliberately left open are **[OPEN]**.
Nothing here is built yet; this document is the thing to approve before a plan.

> **What changed since the morning draft.** The model was reorganised around a
> single concept — the **group** — instead of an abstract `owner`/`group`/
> `instance` scope trichotomy. A group is now both the **unit of isolation** and
> the **unit of visibility**, and the old three "scopes" become three
> **visibility natures** of a group (private / restricted / public). The
> suspected #1 viability blocker — Claude authentication across many HOMEs — was
> **resolved by measurement** (see "Claude authentication"). The old draft's
> `owner`/`group`/`instance` wording is superseded by the mapping in "Core
> model".

## Intent and why

Turn shadok from a single shared cockpit into the cockpit of a **hybrid company**
— humans and agents running a company or a project together. Concretely, the
driver is two use cases the current model cannot express:

- **Agents private to one person**, visible to them alone.
- **Agents shared within a team** (COMEX / RH / TECH / SALES / MARKETING),
  visible only to the people in that team.

The mental model the user reached for is **Slack channels**: you see your own
things and the things of the groups you belong to, and nothing else. Agents must
still be able to **collaborate across those boundaries** — a dev agent in one
team hands work to a release agent in another — without that collaboration
punching a hole in the isolation.

This is explicitly **not** a Fortune-500 product. The target is a company of **up
to ~50 people**. That scale shapes every trade-off below.

## Threat model (read this before judging any mechanism)

The design defends against the **realistic** threats for a trusted-insider
company:

- **Accidental exposure** — an agent helpfully surfacing one team's data to a
  member of another (the most likely real incident).
- **Honest-but-curious access** — someone could look at another team's agents or
  secrets because the system lets them, without being an attacker.

It explicitly does **not** try to defend against:

- A **determined insider with a shell on the host**, or **host root**. If someone
  has that, it is game over regardless, and it belongs to a different trust
  domain (machine access, HR, contracts) — not something the cockpit can or
  should solve. Chasing it would force containerization and hardening the scale
  does not warrant.

Design rule that follows: close the **realistic** holes (cross-team reads via a
shared OS user, unfiltered agent/secret visibility) with real OS-level
boundaries, and stop there.

## Core model: the group is the unit

An agent is described by **two independent things**:

1. **Profile = the ROLE** — what the agent may *do*: its system prompt, its
   permission guardrails (`deny`/`allow`), its model, and the **names** of the
   secrets it needs. A profile is reusable across groups: COMEX has a `dev`,
   SALES has a `dev`, it is the *same* role. (This is today's `src/profiles.ts`,
   unchanged in spirit.)

2. **Group = WHERE it lives** — the isolation island it runs in and the ACL that
   governs who sees it. **An agent belongs to exactly one group** for its whole
   life.

**[DECIDED] A group is ALWAYS an isolation island**, whatever its visibility:
its own **OS user**, its own **secret slice**, its own **HOME**. Isolation is a
property of the group, never of the profile — isolating by profile would wrongly
pool every team's `dev` together.

**[DECIDED] Visibility is an independent setting on the group**, one of three
**natures**:

| Nature | Who sees it | Membership | Notes |
|--------|-------------|------------|-------|
| **Private** | its owner **only** | exactly one person, **fixed forever** | one per user; auto-created at onboarding; invisible even to an admin; never shareable; visually marked |
| **Restricted** | the people on its member list | many; **any member can invite** | the team case |
| **Public** | everyone in the cockpit | none (no list) | `Main` is a public group |

This supersedes the morning draft's `owner`/`group`/`instance` **scopes**, which
map onto the natures 1:1: `owner` → **private**, `group` → **restricted**,
`instance` → **public**. The gain is that there is now **one concept** (the
group) carrying both the isolation island and the ACL, instead of three abstract
scopes.

### The private group (the personal space)

- **[DECIDED]** A private group is a person's **permanent personal space**:
  exactly **one per user**, holding that person's **private agents**. It is a
  hard lock — **no invitation is ever possible**, it stays a group of one, and it
  is **invisible even to an admin, forever**. (This firms up the morning draft's
  "[DECIDED, revisit]" — it is no longer up for revisiting.)
- **[DECIDED]** It is **auto-provisioned**: onboarding a person creates their
  private group and therefore their personal **OS user** on the spot. The user
  does not "create" it.
- **[DECIDED]** It must be **visually recognisable** in the UI (a lock / a
  "personal" marker), so a person can tell their private island apart from shared
  groups at a glance.

### Main (the default public group)

- **[DECIDED]** **`Main`** (the former "Ungrouped", renamed by PR #325) is itself
  a **public, isolated group**. It is where the `general`/lead agent lives and
  where anyone without a more specific group lands by default.

### Creating, moving, membership

- **[DECIDED]** **Anyone can create a group** (restricted or public). Because
  creating a group **provisions a new isolated OS user**, this is a **privileged
  server operation performed on the user's behalf** — the server is the only
  actor that touches OS users; no user ever gets shell or sudo. A guardrail is
  needed so a single person cannot spin up unbounded OS users on a click
  (**[OPEN]** cap / quota / approval — see Open decisions).
- **[DECIDED]** **Membership is many-to-many** — a person can be in several
  groups (e.g. COMEX *and* TECH). Their visibility is the **union** of their
  private group ∪ every restricted group they belong to ∪ every public group.
- **[DECIDED]** In a **restricted** group, **any member may invite** other people
  (flat, Slack-like — not reserved to an admin or the creator). **[OPEN]** Whether
  a member may also **remove** others, and how a person **leaves** a group.
- **[DECIDED]** A **"user"** is an **existing web account** (`src/accounts.ts`),
  not a new identity to invent.
- **[DECIDED] Moving an agent from one group to another is removed.** Today it is
  cosmetic (a tab changes column); under isolation it would mean changing an
  agent's OS user / HOME / secrets mid-life — incoherent. An agent **is born into
  its group and stays there**. "The same thing elsewhere" = spawn a fresh agent in
  the other group.

### Terminology: we enrich the existing group, we do not add a "team"

The morning draft proposed introducing a separate word ("team"/"space") to avoid
overloading shadok's existing **cosmetic tab group** (`channel.group`, `/groups`
— client-owned, visible to everyone, no members, no rights). The conversation
settled the other way: there is **one concept, the group**, and the existing
tab-group is **promoted** into it — a first-class, **server-owned** object that
now carries **membership, a visibility nature, and an OS identity**. This is a
real change to `src/channels.ts`'s group model (today purely cosmetic) and to
`/groups`.

## Claude authentication across HOMEs (the resolved blocker)

The morning draft flagged, as the #1 risk that could sink the whole design, that
`claude` authenticates from a single place (one `claude auth login`) while this
model gives each group its own HOME with its own `~/.claude`. **Measured on the
live instance, the blocker dissolves:**

- The Claude credential is a **single plain file**,
  `~/.claude/.credentials.json` (~560 bytes, mode `600`).
- **It is already shared today.** The running instance has **~30 `claude`
  processes under ONE OS user**, all reading that **one** credential file. The
  "shared credential across many agents" model is not new — it is exactly how
  shadok runs now.

So the design is just to **generalise what already works**: put the credential in
a location **readable (and writable) by every group's OS user** — e.g. one
server-owned file that each HOME's `~/.claude/.credentials.json` symlinks to.

- **[DECIDED]** This does **not** breach isolation. The subscription is **global
  by nature** — it is the company's one Claude account, **not a per-group
  secret**. Isolation protects each group's **vault secrets** and **work files**;
  the subscription auth is legitimately shared. The user explicitly **accepted**
  that any group's agent can therefore read the subscription token — unavoidable
  with a single subscription, and within the trusted-insider model.
- **Residual constraint (inherited, not new):** `claude` **refreshes** the OAuth
  token and **writes it back** to that file, so it must be **writable** by each
  group's OS user, and concurrent refreshes are the known **refresh-token race**
  (shadok already mitigates it by restarting agents **one at a time** — see the
  `restart-all` note in CLAUDE.md). **[OPEN]** whether to keep the one-at-a-time
  discipline as-is or add a small **auth broker** that owns the refresh and hands
  read-only copies out. The `CLAUDE_CODE_OAUTH_TOKEN` env var is **not** a
  substitute — it only feeds the `/usage` endpoint, not the TUI's own auth.

## Execution isolation (the light form — no containers)

- **[DECIDED]** Per-group **OS user**, **no containers**. The global toolchain
  (node, git, `claude`, tmux) is installed **once** for the machine and shared by
  every user; there is no per-tenant image and no duplicated 223 MB `claude`
  binary.
- The shadok server becomes a **privileged orchestrator**: it runs as root (or
  with the needed sudo rights) and **drops to the target OS user** when it spawns
  each agent. It also manages the **lifecycle** of OS users and HOMEs — create the
  user + HOME when a person (private group) or a shared group is created.
- Each group gets its own **HOME**, holding `~/.claude` (skills seeded per HOME at
  boot), config, transcripts, that group's **vault slice**, and a symlink to the
  shared Claude credential (above). The `claude` native binary stays **global**
  and is never duplicated per HOME.
- This **closes the current vault-read leak for free**: today every agent shares
  the server's OS user, so it can `cat ~/.shadok-ai/secrets.json` and read the
  whole vault (the `600` mode does nothing between same-user processes). Under
  per-group users, the vault file is unreadable from a different OS user; the
  server injects only the due secrets as env.

### Cost, stated honestly

- More OS users and HOMEs: roughly `#people + #shared-groups` (~55 for a
  50-person company — each person's private group plus the teams). Linux handles
  this easily, but the orchestrator must provision and tear them down.
- A private group therefore gets its own HOME → a modest **per-person** cost
  (seeded skills + config + transcripts + that person's worktrees). Never the
  binary.
- The "no container, shared binaries" benefit holds throughout — this is *more
  users*, not *more installs*.

## Files, folders and permissions (a chantier of its own)

**[OPEN — flagged by the user as the next big topic, to design once the group
model is locked.]** Once each group runs as its own OS user with its own HOME, a
file an agent writes is **owned by that group's OS user** and unreadable by
another group — which is the point, but it opens a whole area the user wants
treated as a dedicated section:

- **Where produced files land** (per-group HOME? a per-group work dir? the media
  dir?) and the **folder layout** under each HOME.
- **Permissions**: default ownership/mode of files agents create; what, if
  anything, is deliberately **shared** (the git repo's `.git` object store, the
  `MEDIA_DIR` for pasted/produced artifacts, a dependency cache).
- **Cleanup and lifecycle**: who removes a group's files when it is deleted;
  worktree pruning (invariant 5) under per-group ownership.
- **Quotas**: see Disk / footprint.

This section is intentionally left to be filled in next; the decisions above do
not depend on it, but it must be resolved before building.

## Visibility / access control (the Slack-channel layer)

- Each agent (channel) carries its **group**; the group carries its **nature**
  (private/restricted/public) and, when restricted, its **member list**.
- **Server-side filtering, everywhere a channel list leaves the server**:
  `GET /channels`, every WebSocket broadcast that names channels, and the Telegram
  listings. The caller sees only the groups their identity entitles them to.
  Today `GET /channels` ignores the caller entirely (`_req`) and returns
  everything — that is the core thing that changes.
- **Server-side action gating**: resume / prompt / drive / stop / set-parent /
  set-profile are all checked against the same ACL. **Never** trust the client;
  browser filtering is cosmetic only.
- **[DECIDED]** A **private** group is fully private: invisible **and**
  non-pilotable **even to an admin**, with **no break-glass**.
- **[OPEN]** Whether an admin sees **restricted** groups they are not a member of
  (private is settled: no). Default assumption: an admin is still just a member —
  they see a restricted group only if invited — but this is worth confirming.

## Collaboration across boundaries

Isolation must not break the collaboration shadok already relies on. It does not,
because shadok routes collaboration through two channels that are **not** the
shared filesystem:

- **pilotctl** goes through the central server over the WebSocket. Agents in
  different OS users / HOMEs (or even different machines) can still spawn, prompt,
  and drive each other. Unaffected by isolation. (And already denied the Claude
  Code cross-session `SendMessage`/`ListAgents` tools — see PR #317 — so the
  server is the one sanctioned path.)
- **git**: the meeting point is the **remote (origin)**, not a shared local
  directory. A dev agent **commits locally** and **pushes a feature branch**; a
  push/merge-privileged agent (e.g. a release role) reviews and brings it to
  `main`. **Branch protection on the remote** — not a fragile tool `deny` — is
  what enforces "only certain roles merge".

**Consequence to design around:** there is no shared-filesystem handoff of
**uncommitted** work across a group boundary. The pattern "a git-less lead edits
files, then asks a third party to reach into its worktree and push" **stops
working** under isolation (the third party cannot see the worktree). It must be
replaced by either (a) the lead delegating the coding to an agent that owns its
branch end-to-end, or (b) giving the authoring agent enough git to commit + push a
feature branch (never merge to `main`). This is a cleaner flow regardless.

## Secrets model evolution

The single flat per-instance vault (one file, global names, any profile may
reference any name) does not survive groups. It becomes **per-group**:

- **Each secret belongs to a group** (the group's slice).
- **Resolution — profile names it, the group supplies the value.** A profile
  references a secret *name* (e.g. `OPENAI_API_KEY`); at spawn, the agent's
  **group** supplies the value. The same role used by COMEX resolves
  `OPENAI_API_KEY` to COMEX's key; used by SALES, to SALES's key. **Names are
  unique per group, not globally.** **[OPEN]** Lookup precedence: the agent's own
  group first, then a **public/`Main`** fallback — confirm, and whether a profile
  may pin a group explicitly rather than rely on fallback.
- **Isolation**: the server is the **only reader**; it injects only the agent's
  group's secrets as env; the OS-user wall means an agent cannot read another
  group's vault file. Physically splitting the vault into per-group files is
  optional belt-and-braces — scoping can live as **server-side policy** over a
  single server-owned file, since the OS wall + env-injection already isolate.
- **Scoped management API**: `GET /secrets` lists only the names in the caller's
  group(s); creating/overwriting a group secret requires membership of that group;
  a private-group secret, only its owner. When an **agent** stores a secret it
  obtained (the `shadok-secrets` skill `set`, which has no `get`), the value lands
  in **that agent's group**, stamped **server-side** from its session (like
  `SHADOK_SESSION_KEY`), never from anything the client claims.
- **Migration**: today's flat vault becomes the **`Main`** (public) group's
  slice. People and teams add their own on top. No big-bang; a single-user
  instance with no extra groups behaves exactly as today.

## Disk / footprint

- The disk driver is the **worktree** (+ project dependencies), not the group
  distinction. `git worktree` shares the repo's `.git` object store (history is
  not duplicated); only the working tree + index cost. `node_modules` is where it
  balloons — mitigate with a **shared symlink / cache per repo** (as shadok
  already does for its own dev). Transcripts (`.jsonl`) are small per unit but
  accumulate.
- Per-group HOMEs are modest (skills + config + transcripts + their worktrees);
  never the binary.
- Watch item: **worktree proliferation** with many ephemeral personal agents.
  Amortized by shadok's existing empty-worktree pruning (invariant 5) and the
  shared dependency cache. **[OPEN]** Per-person disk **quota** — not present
  today, not required; add later only as a deliberate choice.

## Goals / non-goals / anti-goals

**Goals**
- Slack-like per-person and per-team visibility of agents (private / restricted /
  public groups).
- Real, OS-level confidentiality of secrets and files **between** groups.
- Cross-group collaboration preserved via pilotctl + git.
- No containers; shared toolchain; one shared Claude subscription.

**Non-goals (v1)**
- Defending against host root / a determined insider with a host shell.
- Containerization and Fortune-500 hardening.
- Per-person disk quotas.

**Anti-goals (a design that does any of these has failed, even if it "works")**
- Silently letting one group read another's secrets or files.
- Breaking pilotctl or git collaboration across groups.
- A private agent that an admin can quietly see or drive.
- Letting a user create unbounded OS users without any guardrail.

## Constraints

- No containers (toolchain shared once).
- The server must run **privileged** to setuid per spawn and to provision OS
  users / HOMEs on a user's behalf.
- One **shared, writable** Claude credential file across all group OS users;
  refresh stays serialised (one-at-a-time) to avoid the OAuth refresh race.
- **All** enforcement is server-side (visibility filtering, action gating, secret
  scoping); the client is never trusted — in the spirit of the existing
  server-owned / same-origin invariants.
- **Backward-compatible migration**: an existing single-user instance, with no
  extra groups defined, must keep behaving exactly as today (everything is the
  `Main` public group).

## Open decisions to revisit

- **Group-creation guardrail** — "anyone can create a group" needs a bound: a cap
  per person, a quota, or an approval step, so OS users cannot be spun up without
  limit. **Not yet decided.**
- **Membership removal / leaving** — invite is settled (any member); removal and
  self-leave are not.
- **Files, folders & permissions** — the dedicated chantier above, to design next.
- **Admin over restricted groups** — settled for private (no); confirm an admin is
  just a member elsewhere.
- **Secret resolution precedence** — own group → `Main` fallback; whether a
  profile may pin a group.
- **Claude auth refresh** — keep one-at-a-time, or add a small auth broker.
- **Deployment host model** — bare privileged host vs a single container holding
  ~55 users (vs today's one-container-per-instance).
- **Telegram multi-tenancy** — the bridge is single-owner today; a merged spec
  (PR #338, Telegram person ↔ web account link) now moves identity in this area —
  reconcile with it. Recommendation unchanged: **web-first in v1, Telegram
  deferred.**
- **Lead/home agent per group** — does each group get its own lead, or only
  `Main`?
- **Per-person disk quota** — deferred.

## Left to the builder

- The server orchestration of **setuid spawns**: how privilege is dropped
  (`runuser` / `su` / native setuid) and how tmux/pty sessions are launched under
  a different uid while the server keeps control of the pane; and how the loopback
  auth (`SHADOK_SESSION_KEY` / `SHADOK_AUTH`) survives the uid change
  (invariant 33).
- **On-demand OS-user provisioning**: create/destroy a group's OS user + HOME,
  seed `~/.claude` and the credential symlink, from the privileged server.
- **Schema changes**: the group gains membership + a visibility nature + an OS
  identity (today's cosmetic `channel.group` / `/groups` is promoted to a
  server-owned object); channels carry their group; secrets gain a group.
- **Enumerated ACL enforcement points**: `GET`/`PUT /channels`, `/groups`, every
  WS broadcast carrying channels, Telegram listings and command dispatch, each
  action handler (resume/prompt/stop/set-parent/set-profile), and `/secrets`
  (GET/PUT/DELETE).
- **Migration scripts**: flat vault → `Main` group slice; existing channels →
  `Main` (or a person's private group, if derivable); every existing account gets
  its auto-provisioned private group.
