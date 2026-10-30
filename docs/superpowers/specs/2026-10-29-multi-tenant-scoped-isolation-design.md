# Multi-tenant cockpit: isolated groups, per-group OS users, scoped secrets

Status: **Draft for review** — revised 2026-10-30 (secrets UX folded in; the
secrets section now covers share-by-reference, the per-group panel and the
profile-link move). Written from an ongoing brainstorming conversation. Points
settled in that conversation are
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
- **[DECIDED]** **Only `Main` has a lead agent. Every other group starts empty** —
  including the private group auto-provisioned at onboarding. Creating a group
  provisions its OS user and HOME but **spawns no agent**; the user launches the
  first one on demand. Concretely, today's "no channel at all → spawn the lead"
  rule (`firstAgentPlan`, `src/first-agent.ts`) becomes scoped to `Main`, not
  applied per group.

### Creating, moving, membership

- **[DECIDED]** **Anyone can create a group** (restricted or public), **free and
  unlimited in v1**. Because creating a group **provisions a new isolated OS
  user**, this is a **privileged server operation performed on the user's
  behalf** — the server is the only actor that touches OS users; no user ever gets
  shell or sudo. The operation itself is cheap: `useradd` + HOME is sub-second;
  the perceptible cost is one-time HOME seeding (Claude config/skills, the
  `~/shared/` mount, an optional first `clone`) — seconds, not minutes. A
  guardrail (cap / quota / approval) is **deliberately deferred**: the reason to
  add one later is not latency but the accumulating privileged surface and
  leftover orphan OS users / HOMEs, which v1 accepts.
- **[DECIDED]** **Membership is many-to-many** — a person can be in several
  groups (e.g. COMEX *and* TECH). Their visibility is the **union** of their
  private group ∪ every restricted group they belong to ∪ every public group.
- **[DECIDED]** In a **restricted** group, **any member may invite** other people
  (flat, Slack-like — not reserved to an admin or the creator).
- **[DECIDED]** **Leaving and removal are asymmetric with invitation.** A member
  may **leave** a restricted group on their own (self-leave). **Removing** someone
  else is reserved to a user whose **account role is `admin`** (`src/accounts.ts`,
  `admin` vs `member`; there may be several) — **not** any member, unlike invite.
  This concerns **restricted** groups only: a private group has a single member
  and no invites, and `Main` (public) has no list.
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

### Where it runs (the host model)

- **[DECIDED] The server provisions OS users in-place — in its own runtime
  environment — with no nested per-group containers.** We do **not** add a second
  containerization layer: creating a group is a `useradd` in the environment the
  server already runs in.
- **The blast-radius boundary comes for free from the standard deployment.** A
  shadok instance installed on a VPS **already runs inside one Docker container**
  (the official image). So "bare host" here means the server's own environment —
  which, in the default VPS install, *is* that container — and the outer Docker
  bounds the blast radius without any extra design. On a bare-metal install (no
  Docker) the environment is the host itself, and the operator accepts that.
- **[builder] Persistence across `docker recreate`.** OS users (`/etc/passwd`,
  `/etc/shadow`) and their HOMEs are created **inside** that container and are
  **lost on a recreate** unless pinned to the mounted volume — the same trap as
  `~/.claude.json` and the SSH identity (invariants 19, 23). The builder must
  either place the user DB + HOMEs on the `shadok-data` volume or rebuild them at
  boot. Flagged, not designed here.

### Cost, stated honestly

- More OS users and HOMEs: roughly `#people + #shared-groups` (~55 for a
  50-person company — each person's private group plus the teams). Linux handles
  this easily, but the orchestrator must provision and tear them down.
- A private group therefore gets its own HOME → a modest **per-person** cost
  (seeded skills + config + transcripts + that person's worktrees). Never the
  binary.
- The "no container, shared binaries" benefit holds throughout — this is *more
  users*, not *more installs*.

## Files, folders and permissions

Once each group runs as its own OS user with its own HOME, a file an agent writes
is **owned by that group's OS user** and unreadable by another group — which is
the point. The design then has to answer how anything legitimately crosses that
wall. **[DECIDED]** There are exactly two doors, and nothing else traverses:

- **Code circulates by `origin`, never by the disk.** Each group holds its **own
  clone** of a given project inside its HOME. Two groups working the same project
  are two separate clones that meet **only at the remote**: a group commits
  locally and pushes a feature branch; the pont is `origin`, never a shared
  checkout on disk. This supersedes any notion of a `.git` object store shared
  *across* groups — the OS-user wall forbids it. (Within a *single* group, the
  group's own agents still share that group's clone via worktrees, as shadok does
  today — the sharing is just scoped to the group now.)
- **Everything that is not code circulates by one shared common pot.** A single
  `~/shared/` directory is mounted into **every** group's HOME, **readable and
  writable by all groups**. It is where produced artifacts, exports and pasted
  files go when they must leave a group. Dropping a file there is a deliberate
  "make this public" gesture: **anything placed in `~/shared/` is visible to
  everyone**, including from a private group. Two trade-offs are accepted as the
  price of simplicity: there is **no per-file guardrail** — any group can
  overwrite or delete another group's file in the pot — and a private group that
  drops a file into it has, by that act, made that file no longer private. The
  rest of the group's HOME stays fully walled.

**Permissions** follow from the OS-user model: a group's own files are owned by
its OS user (default private to the group); the shared pot is group-writable to
all. **Cleanup / lifecycle** (removing a group's HOME when the group is deleted,
and what becomes of its share of `~/shared/`) and **worktree pruning**
(invariant 5) under per-group ownership are left to the builder. **Disk space /
quotas are out of this spec's scope** — handled at the Docker/infrastructure
level, not inside the cockpit.

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
- **[DECIDED]** An **`admin`-role** user **sees and manages the member list of
  every restricted group**, even ones they do not belong to — this is what lets
  an admin remove members (above). A **member** (non-admin) still sees a
  restricted group only if invited. The private group is the one exception: it
  stays invisible and unmanageable **even to an admin** (no break-glass, per the
  line above). So admin reach is: all public ∪ all restricted — never any
  private.

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
reference any name) does not survive groups. It becomes **per-group**, and the
whole panel is reorganised around the group. The guiding worry the user named is
that per-group secrets "can quickly become a mess" — so the model below is
deliberately the *simplest* thing that still isolates: one owner per secret, no
new hierarchy, and sharing by reference rather than by copy.

### Ownership, and sharing by reference — not by copy

- **[DECIDED] Each secret has exactly ONE owner group** (the group whose slice it
  lives in). There is no new "level" hierarchy to learn: the three "kinds" of
  secret a person thinks in — *personal*, *per-team*, *general* — are just the
  three group **natures** already in the model (personal = **private** group,
  team = **restricted** group, general = **`Main`**). A secret is defined in a
  group, full stop.
- **[DECIDED] A secret may be SHARED, read-only, with other specific groups — by
  reference, not by copy.** When one key must serve two teams, the owner group
  adds the other groups to the secret's **"shared read with"** list. The value
  **lives once**, in the owner's slice; the shared-with groups get **read access
  to that same value**, never a copy. Rotating or revoking happens in **one
  place** and every consumer follows immediately. (The user and I weighed
  duplicating the value into each group — rejected: a copy is a second place the
  value sits, a second thing to rotate, and a silent drift when one copy changes.
  The copy is **not** a security win — the plaintext is equally present either
  way, and the server is the only reader in both designs — so the reference model
  is strictly simpler with no downside here.)
- **[DECIDED] Resolution precedence — profile names it, the group supplies the
  value**, now four steps:
  **own group → shared-in → `Main` → absent.**
  A profile references a secret *name* (e.g. `OPENAI_API_KEY`); at spawn the
  agent's **own group** is tried first, then any secret **shared into** its group
  by reference, then a **`Main`** "house" fallback, and if none match the name
  resolves to nothing (the env var is simply not set). The same role used by
  COMEX resolves `OPENAI_API_KEY` to COMEX's key; used by SALES, to SALES's.
  **Names are unique per group, not globally.**
- **[DECIDED] A profile may NOT pin another group's secrets.** Resolution is
  always the precedence chain above, never "reach into the group next door" —
  pinning would let a role step around the isolation wall. (My call on the pin;
  the `Main` fallback and the share-by-reference model are the user's.)

### Isolation

The server is the **only reader**; it injects only the secrets the agent's group
resolves (own + shared-in + `Main`) as env; the OS-user wall means an agent
cannot read another group's vault file directly. A **value is never returned to
any client** — `GET /secrets` is names-only today and stays so. Sharing is a
server-side grant (the owner group's slice gains a "readable by group X" flag);
because the value is never copied or sent back, there is no path by which a
shared-in group obtains the plaintext except the same env injection every agent
already gets. Physically splitting the vault into per-group files is optional
belt-and-braces — scoping can live as **server-side policy** over one
server-owned file, since the OS wall + env-injection already isolate.

### The secrets panel is managed group by group

- **[DECIDED]** The `#secretsOverlay` is **scoped to one group at a time**. For
  the selected group it shows **three sections**, by source:
  - **Its own secrets** — defined here, **editable** (add / overwrite / delete),
    each with a **"shared read with: …"** control to add or drop other groups.
  - **Shared with this group (read-only)** — secrets another group owns and has
    shared in. Listed by name, with the **owner group** shown (e.g.
    `HUBSPOT_TOKEN — owned by MARKETING`); this group cannot edit, rotate, or
    re-share them.
  - **Inherited from `Main` (read-only)** — the house fallback names, shown so a
    group sees what it gets for free and can shadow a name by defining its own.
- **[DECIDED] A 🔑 icon per group in the groups bar** opens that group's secrets
  panel directly — the quick path to "manage the secrets of *this* group" without
  going through a global panel and selecting.
- **[DECIDED] Write permission** follows group membership: a group's own secrets
  are writable by its **members**; a **private** group's, by its single owner
  only; **`Main`**'s, by an **`admin`** only (a house key is an admin act).
  An **`admin`** may manage any **restricted** group's secrets (consistent with
  admin reach over restricted member lists), but **never a private group's** (no
  break-glass, per the visibility section). **Only the owner group's members (or
  an admin, for a restricted/`Main` group) may change a secret's share list** — a
  shared-in group cannot re-share onward.
- **[DECIDED] Audit, per secret: `createdBy` / `createdAt` / `updatedAt`.** The
  panel shows who added a secret and when, and when it was last changed. Values
  are **never re-displayed** after entry (write-only field, as today).
- **[DECIDED] Degradation — an instance with no groups looks exactly like today.**
  With only the virtual `Main`, the panel is a **single flat list** with no group
  header and no "inherited" / "shared-with" sections. The group machinery appears
  only once a second group exists. This keeps the common (single-tenant) case
  unchanged.

### The secret ↔ profile link lives on the secrets side

Today the binding is edited from the **profile** side (`profSecretsList` in the
profile editor). Under groups that is the wrong home: a profile is group-agnostic
(the same `dev` runs in every team), while *which secrets exist* is a per-group
fact. So the link moves:

- **[DECIDED]** The **secrets panel** owns the binding. Each secret shows
  **"used by profiles: X, Y"**, and the **add-secret form** has an **"attach to
  profiles"** control. This is the one place the name↔profile link is edited.
- **[DECIDED]** The **profile editor becomes read-only on secrets.** It shows the
  **names** that will be injected (so a role's needs are still visible) with a
  note that **values resolve per group at spawn**, plus a **"→ Manage secrets"**
  link into the panel. It no longer edits the binding — which removes the
  "alambiqué" (convoluted) double-editing the user flagged, where secrets were
  managed from two places at once.

### Scoped management API

`GET /secrets` lists only the names the caller's group(s) resolve (own +
shared-in + `Main`), each tagged with its source and, for shared-in, its owner
group; creating/overwriting a secret requires membership of its **owner** group
(a private-group secret, only its owner; a `Main` secret, an admin); changing a
share list, the same. When an **agent** stores a secret it obtained (the
`shadok-secrets` skill `set`, which has no `get`), the value lands in **that
agent's group**, stamped **server-side** from its session (like
`SHADOK_SESSION_KEY`), never from anything the client claims — and `createdBy`
records the agent.

### Migration

Today's flat vault becomes the **`Main`** (public) group's slice; existing
profile↔secret bindings carry over unchanged (names are preserved). People and
teams add their own on top, and share by reference where a key must span teams.
No big-bang; a single-user instance with no extra groups behaves exactly as
today (the degradation rule above). The full migration of a running instance is
its own topic — see "Left to the builder" and the migration discussion still to
be folded in.

## Disk / footprint

- The disk driver is the **clone + worktree** (+ project dependencies). Since
  each group now holds its **own clone** of a project (Files section), a repo
  worked by N groups costs N `.git` object stores — the price of the OS-user wall.
  *Within* a group, `git worktree` still shares that group's `.git` (history not
  duplicated per worktree); only the working tree + index cost. `node_modules` is
  where it balloons — mitigate with a **shared symlink / cache per repo**, scoped
  to a group (as shadok does for its own dev). Transcripts (`.jsonl`) are small
  per unit but accumulate.
- Per-group HOMEs are modest (skills + config + transcripts + their clones);
  never the binary.
- Watch item: **worktree proliferation** with many ephemeral personal agents.
  Amortized by shadok's existing empty-worktree pruning (invariant 5) and the
  per-group dependency cache.
- **Disk space / quotas are out of scope** — managed at the Docker/infrastructure
  level, not inside the cockpit.

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

- **Claude auth refresh** — keep one-at-a-time, or add a small auth broker.
- **Telegram multi-tenancy** — the bridge is single-owner today; a merged spec
  (PR #338, Telegram person ↔ web account link) now moves identity in this area —
  reconcile with it. Recommendation unchanged: **web-first in v1, Telegram
  deferred.**

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
  server-owned object); channels carry their group; secrets gain an **owner
  group**, a **"shared read with" group list**, a **profile binding** (moved off
  the profile side), and **audit fields** (`createdBy` / `createdAt` /
  `updatedAt`).
- **Enumerated ACL enforcement points**: `GET`/`PUT /channels`, `/groups`, every
  WS broadcast carrying channels, Telegram listings and command dispatch, each
  action handler (resume/prompt/stop/set-parent/set-profile), and `/secrets`
  (GET/PUT/DELETE) — including the new **share-list** edit and the
  **profile-binding** edit, both gated on owner-group membership (or admin for a
  restricted/`Main` group).
- **The secrets UI**: a group-scoped `#secretsOverlay` with its three sections
  (own / shared-in / inherited-from-`Main`), the per-group 🔑 entry point in the
  groups bar, the write-only value field with audit display, and the single-flat-
  list degradation when only `Main` exists; plus the profile editor turned
  read-only on secrets with a "→ Manage secrets" link.
- **Migration scripts**: flat vault → `Main` group slice; existing channels →
  `Main` (or a person's private group, if derivable); every existing account gets
  its auto-provisioned private group.
