# Skill Factory — build, version and share skills across teams and orgs, with secrets that never travel

Status: **Draft for review** — 2026-10-29. Points settled are marked
**[DECIDED]**, points left open **[OPEN]** (each with a recommendation). Nothing
here is built. It leans on two neighbours and must stay consistent with them:
`2026-10-29-multi-tenant-scoped-isolation-design.md` (scopes `owner` / `group` /
`instance`, scoped vault) and `2026-09-26-cross-instance-agent-collaboration-design.md`
(peers — the cross-instance principal, `src/peers.ts`).

## Intent and why

Two needs, one space:

1. **Skills are the reusable know-how of a hybrid company** — and today shadok
   only knows about the skills it seeds itself (`seed*Skill`, copied over
   `~/.claude/skills/` at every boot). A skill a team writes lives as loose files
   on one machine: no version, no history, no way to hand it to another team or
   to a partner organisation, and no way to know which credentials it needs.
2. **Secrets are invisible once stored.** The vault (`src/secrets.ts`) is a flat
   `{ NAME: value }` map. The panel lists names; it does not say who created a
   secret, when it was last changed, which profiles and skills depend on it, or
   which running agents still carry an OLD value after a rotation. An overwrite
   "replaces a live credential and leaves no trace" (the code's own comment).

The **Skill Factory** is one place in the cockpit where you see, work on and
share both — because they are coupled: a skill *needs* secrets, a secret is
*used* by skills. Sharing the first without ever leaking the second is the whole
design problem.

## The one rule everything else follows

**[DECIDED] A skill carries secret NAMES, never secret VALUES. The scope that
installs it supplies the values.**

This is the multi-tenant spec's rule ("profile names it, scope supplies the
value") applied to skills. A skill declares `requires.secrets: ["STRIPE_KEY"]`;
installed in team SALES it runs with SALES's `STRIPE_KEY`, installed at a partner
org it runs with *their* `STRIPE_KEY` — or shows "unbound" until they set one. So
sharing a skill is sharing **code and prose**, and the vault never crosses a
boundary, by construction rather than by care.

Everything below is either making that rule enforceable (the publish scan), making
it visible (the bindings view), or making the code side safe to accept (import
review).

## Vocabulary

| Term | Meaning |
|---|---|
| **Skill** | A Claude Code skill directory (`SKILL.md` + optional scripts/files) plus a shadok manifest. |
| **Manifest** | `shadok-skill.json` beside `SKILL.md`: `name`, `version`, `description`, `requires.secrets[]`, `origin`, `contentHash`. |
| **Draft** | A skill being worked on in the factory. Mutable. |
| **Release** | An immutable, numbered snapshot of a draft (`name@3`). The only thing that is installed or shared. |
| **Install** | A release copied into a Claude Code skills directory, with a marker so shadok knows it owns it. |
| **Share** | An explicit grant of a skill's releases to a scope: a team, the instance, or a peer org. |
| **Binding** | Whether each `requires.secrets` name resolves to a value in the installing scope. |

"Cross org" = **another shadok instance**, reached as a **peer**. "Group" here
means the multi-tenant spec's access **team**, never the cosmetic tab group (that
spec's terminology warning applies).

## The space

**[DECIDED] One header entry, "Factory", opens a full-panel overlay with two
tabs: Skills and Secrets.** It replaces the current Secrets popin (whose content
becomes the Secrets tab), so there is one place, not two.

### Secrets tab — "see them, see how they evolve, change them"

One row per secret **visible to the caller** (scope filtering from the
multi-tenant spec; on a single-tenant instance, everything):

| Column | Source |
|---|---|
| Name | vault |
| Scope | `owner` / `group:<team>` / `instance` |
| Created by / when | `secret-origin.json` (extended to humans: today a missing origin means "a human") |
| Last changed | event log |
| Fingerprint | `hmac(signingSecret, value)`, 8 hex — shows "it changed" without showing the value |
| Used by | profiles (`secretUsers`, already exists) + skills whose manifest requires it |
| Running stale | agents whose spawn-time fingerprint ≠ current (see below) |

Row actions: **Rotate** (enter a new value — the explicit-overwrite path that
`secretWriteVerdict` already requires), **Delete** (refused while a profile or an
installed skill still requires it, unless forced — say who would break), **History**
(timeline below), **Reload stale agents** (reuses `POST /restart-all
{sessions}`).

Values are **write-only in the UI** [DECIDED]: you can set one, never read one
back. Same posture as the `shadok-secrets` skill, which has no `get`. Anyone who
needs to see a value has it elsewhere already.

**History = an event log of metadata, never values.** `~/.shadok-ai/secret-events/<instance-key>.json`,
append-only, capped like `security-events.ts` (500 rows / 90 days):

```
{ at, name, scope, kind: "created"|"rotated"|"deleted"|"attached"|"detached"|"required-by-skill"|"injected",
  by: "<account>" | "agent:<profile>/<session8>" | "peer:<name>", fp?: "<8hex>", detail? }
```

`injected` is written at spawn (one row per agent per secret name) — it is what
answers "who actually had this credential?", the question asked after a leak.
**[OPEN]** volume: 60 agents × 5 secrets × restarts is a lot of rows. Recommend:
collapse `injected` into a per-secret "last injected into" summary plus the raw
rows for 7 days.

**Stale-after-rotation.** An agent's env is frozen at spawn (invariant 33's lesson),
so a rotation does nothing to running agents — and today nothing says so. At spawn
we record `{ name → fp }` on the channel, next to `spawnFp` (agent-staleness spec,
invariant 40: durable, written only for a process we spawned). After a rotation,
the Secrets row and the agent's existing reload indicator both say *"started with
the previous value of STRIPE_KEY"*. This plugs straight into `stalenessReasons`;
the fingerprint is what lets it be a *content* comparison, never a guess.

**[OPEN] Rollback.** Keeping the previous value lets you undo a bad rotation, but
doubles what a vault read exposes. Recommend: keep **one** previous value, for
**24 h**, then purge; Rollback button visible only inside that window.

### Skills tab — "work on them"

Four lists, one card per skill: **Drafts** (mine / my teams'), **Installed**,
**Shared with me** (from teams or peer orgs, not yet installed or with an update
pending), **Shared by me**.

Each card shows the description, current release, scope, and the **bindings**: one
chip per required secret — green (bound in this scope), red (missing → "Set it"
opens the Secrets tab pre-filled with the name). A skill with a red chip still
installs; it just says what it needs instead of failing mysteriously in a tool
call.

Card actions:
- **Work on it** — spawns (or resumes) an agent on the managed `Shadok-Skillsmith`
  profile, in the draft's directory (below). This is the "factory" part: a skill
  is improved the way everything in shadok is — by an agent, in the chat, with a
  diff panel. The role prompt teaches the manifest, the secrets rule, and to test
  the skill before proposing a release.
- **Release** — snapshot the draft (runs the publish scan first, see Safety).
- **Install / Update / Uninstall** in a scope.
- **Share** — pick teams and/or peers; revocable.
- **History** — releases with their diff (`git log` / `git diff` of the draft repo).

## Storage

**[DECIDED] Each skill's draft is a git repository**: `~/.shadok-ai/factory/<instance-key>/skills/<name>/`.
History, diff and blame come for free, the Skillsmith agent works in it like any
worktree (the diff panel already works on git), and a release is just an
annotated tag `v<N>` whose tree is hashed into `contentHash`. No new versioning
system to invent.

Installed releases: copied (not symlinked — a draft edit must never change what
agents run) into the skills directory with a marker `.shadok-managed.json
{ name, version, contentHash, scope, from }`.

**Never touch an unmanaged skill** [DECIDED]. A directory in `~/.claude/skills`
without the marker belongs to the user; install refuses a name collision with it
rather than overwriting, and offers "adopt into the factory" (import as a draft)
instead. Same additive posture as `claude-home.ts`.

Shadok's own seeded skills (`shadok-ai-agents`, `shadok-secrets`…) are **not**
factory skills: they are rewritten at every boot and listed read-only, so a user
does not edit something the next boot erases (the `Shadok-Tweak` lesson).

## Scopes and where a skill is visible to agents

Claude Code loads **every** skill in `~/.claude/skills` (user-level) plus the
project's `.claude/skills`. That fixes what scoping can mean:

- **Single-tenant (today)**: install = machine-wide. Every agent sees it.
- **Multi-tenant**: each scope has its own OS user and HOME, hence its own
  `~/.claude/skills`. Installing in team SALES = copying into SALES's HOME. Scope
  isolation of skills is therefore **free** once the multi-tenant spec lands —
  same OS wall as the vault.

**[OPEN] Per-profile skills** (only `Shadok-Release` sees the deploy skill). Claude
Code offers no per-process skill allow-list that we know of. Options: (a) don't —
scope is the unit; (b) install into the agent's worktree `.claude/skills` at spawn
(but that pollutes the repo's working tree and its diff); (c) a `deny` on the
`Skill(<name>)` permission if the CLI honours it — **must be measured on a live
interactive agent, not `claude -p`** (the invariant-29 trap). Recommend (a) for v1,
then measure (c).

## Sharing

### Within an instance (teams)

A share is a row `{ skill, toScope, grantedBy, at }`. The grantee sees the skill in
"Shared with me" and installs a **release** of their choice. Updates are
**offered, never pushed** [DECIDED]: a skill is code that runs with the agent's
permissions, so a new release is a supply-chain event — the grantee sees the diff
and clicks Update. (Opt-in auto-update per install is a possible later knob.)

### Across orgs (peers)

**[DECIDED] Transport = the existing peer link.** Peers already authenticate
(`x-shadok-peer`, salted, revocable, `src/peers.ts`), so no new credential. New
read-only routes on the *publishing* instance:

- `GET /factory/catalogue` — the skills shared with this peer: name, description,
  releases, `requires.secrets` names, `contentHash`.
- `GET /factory/skills/:name/:version` — the release bundle (tar of the tagged
  tree + manifest).

Both answer **only** for skills explicitly shared with that peer name (not "all
member peers") — sharing out of the org is always a deliberate, per-peer act.
Revoking the share or the peer stops future pulls; an already-installed copy stays
(it is the receiver's code now), which the UI states plainly.

The **receiving** instance pulls, verifies `contentHash`, stores the release as a
read-only **vendored** draft (`origin: peer:<name>`) and runs the import review
below. It can **fork** it into its own draft to modify — a fork drops the update
link, said in the UI.

**[OPEN] A git remote as an alternative medium** (a shared `skills` repo on
GitHub, PRs as review). Better for orgs that are not shadok instances and gives
review tooling for free, but brings a GitHub credential into the loop. Recommend:
peers in v1 (zero new credentials), git remote as a follow-up "export to repo".

## Safety — the secrets rule, enforced

The rule is easy to state and easy to break by accident: an agent writing a skill
will happily paste the token it just used into an example. So releasing runs a
**publish scan** [DECIDED], deterministic, no model call:

1. **Vault match — refuses.** Every file is searched for every vault value visible
   to the publisher (length ≥ 8). A hit refuses the release and names the *file*
   and the *secret NAME* — never the value. This is the strongest check there is:
   it matches the actual credentials, not a guess at their shape, and costs
   nothing at this scale (dozens of secrets × a few files).
2. **Forbidden files — refuses.** `.env*`, `*.pem`, `*.key`, `id_*`,
   `credentials*`, `*.jsonl` (a transcript), anything over a size cap.
3. **Shape match — warns.** Common token formats (`sk-…`, `ghp_…`, `xox?-…`,
   AWS keys, PEM headers, long high-entropy strings) → a warning with an explicit
   "this is not a secret" override, recorded in the release. Warn, not refuse:
   example placeholders look like tokens, and a scan that cries wolf gets
   bypassed by habit.
4. **Undeclared env — warns.** A script reading `process.env.X` / `$X` where `X`
   is in the vault but absent from `requires.secrets` → "declare it", because an
   undeclared dependency shows as bound here and silently breaks at the receiver.

The scan runs again on **import**, with the receiver's vault — so a skill that
somehow carries one of *their* values is caught too.

**Import review** (any skill entering a scope from elsewhere — team or peer):
a single screen with origin, file list, full diff vs the installed release, every
script highlighted, required secrets with this scope's bindings, and the scan
results. Install is a **human click, browser-only** [DECIDED] — the same gate as
`PUT /profiles` (invariant 26): an agent may draft and propose, it may not
install code that every sibling will load. (Soft isolation, as always: an agent
with a shell can still write into `~/.claude/skills` itself; this removes the
documented path, it is not a sandbox.)

**What a skill can never do**: read the vault. Values reach a skill only through
the env of an agent whose profile binds the name, at spawn — the existing path.
The factory adds no `get`.

## Who may do what

| Action | Who |
|---|---|
| Create / edit a draft | a person, or the Skillsmith agent they launched, in a scope they belong to |
| Release | a person (browser), after the scan |
| Install / update / uninstall in a scope | a member of that scope (admin for `instance`), browser-only |
| Share to a team | a member of the skill's scope |
| Share to a peer org | **admin only** — data leaving the org |
| See secrets of a scope | members of that scope; names + metadata only |
| Rotate / delete a secret | members of that scope (admin for `instance`); agents keep today's create-only `PUT /secrets` |
| Pull a catalogue | a peer, only what was shared with its name |

## Endpoints (sketch)

- `GET /factory/skills` — the four lists for the caller.
- `POST /factory/skills` (create draft / adopt an unmanaged skill / fork),
  `POST /factory/skills/:name/release`, `POST /factory/skills/:name/install`,
  `DELETE …/install`, `POST /factory/skills/:name/share`, `DELETE …/share`.
- `POST /factory/skills/:name/scan` — dry-run of the publish scan (the Skillsmith
  agent calls it before proposing a release).
- `GET /factory/catalogue`, `GET /factory/skills/:name/:version` — peer routes.
- `POST /factory/pull` — receiver fetches from a peer.
- `GET /secrets` gains metadata (scope, origin, fp, users, stale agents);
  `GET /secrets/history?name=`; `POST /secrets/rollback` (if kept).

All writes browser-only except draft edits and `scan`, which the Skillsmith agent
reaches with its `SHADOK_SESSION_KEY`.

## Phasing

1. **Secrets space** — the tab, metadata, fingerprint, event log, stale-after-rotation
   wired into the reload indicator. Useful alone, no dependency, and it fixes the
   "rotation does nothing and says nothing" gap that exists today.
2. **Local factory** — drafts as git repos, releases, install with marker, publish
   scan, Skillsmith profile, bindings chips. Single-tenant, machine-wide installs.
3. **Team sharing** — needs the multi-tenant spec (teams, per-scope HOMEs).
4. **Cross-org** — peer catalogue + pull + import review.

Each phase ships with its README / architecture / CLAUDE.md updates, per the
conventions.

## Goals / non-goals / anti-goals

**Goals** — one place to see and change secrets with their history; skills
versioned, reviewable, improvable by an agent; skills shareable across teams and
orgs; secrets never leaving their scope.

**Non-goals (v1)** — a public marketplace; per-profile skill visibility (until
measured); sharing secrets themselves across orgs (if a partner needs a key, they
get their own); encrypting the vault at rest (separate concern).

**Anti-goals** (a design that does these has failed even if it works):
- A secret value in a released skill, a bundle, an event row, a log line or an
  error message.
- An update that changes code an agent loads without a human seeing the diff.
- Overwriting a skill shadok does not own.
- A rotation that leaves agents on the old value with nothing saying so.

## Open decisions (summary)

- `injected` event volume — summary + 7-day raw rows?
- Previous-value rollback — one value, 24 h?
- Per-profile skill visibility — scope-only in v1, then measure `Skill(<name>)` deny?
- Git remote as a second sharing medium — follow-up?
- Name of the managed profile: `Shadok-Skillsmith`?
- Does a `group`-scoped secret satisfy a binding for an `owner` agent of a member
  (precedence owner → team → instance, as in the multi-tenant spec)?
