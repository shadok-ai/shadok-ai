# Skill Factory — co-write a skill across one or more groups, then run it in an agent or a cron

Status: **Draft for review** — revised 2026-10-31. Points settled are marked
**[DECIDED]**, calls the author made that a builder could not settle alone
**[CALL]**, points left open **[OPEN]** (each with a recommendation). Nothing here
is built.

> **What changed since the 2026-10-29 draft (read this if you saw it).**
> 1. **Vocabulary realigned on the multi-tenant spec** as it stands after #362–#364
>    (`2026-10-29-multi-tenant-scoped-isolation-design.md`): there are no more
>    `owner` / `group` / `instance` *scopes* and no "team" — there is **one
>    concept, the group**, with three natures (private / restricted / public), and
>    `Main` is the public commons. Everything below is written in those words.
> 2. **A skill is now shared between ONE OR MORE groups**, with two separate
>    rights — *edit* (co-write the draft) and *use* (run it) — instead of a single
>    "share" verb. That is the request this revision answers: work on a skill
>    together, across groups, without breaking the walls.
> 3. **"Use it in an agent / a cron" is now designed** (it was missing). A skill
>    is attached to a **profile**, an **agent**, or a **cron**, and reaches the
>    process through `claude --plugin-dir` at spawn — per process, never by
>    writing into `~/.claude/skills`. This also settles the old "per-profile
>    skills" open question.
> 4. **The Secrets tab is removed from this spec.** The multi-tenant spec now owns
>    the secrets panel, group by group (#362). This spec only *consumes* secrets
>    (a skill names them; the group supplies them). The rotation-staleness idea
>    from the old draft is listed under "Handed to other specs".

## The whole thing in one page

**A skill is a thing with one owner group, a list of groups that may co-write
it, and a list of groups that may use it.** Private by default; every share is an
explicit act. That is the multi-tenant spec's one rule ("you only see and touch
your own groups + the public") and its one gesture ("to cross a wall, make one
deliberate outbound move") applied to skills.

- **Write it together** — a draft is a git history held by the server. Every
  editor (a person in the browser, or a `Shadok-Skillsmith` agent in any editor
  group) works on its own clone and **pushes**; the server is the `origin`, and it
  checks the pusher's group on every push. It is the multi-tenant spec's "code
  circulates by origin, never by the disk", with shadok as the origin.
- **Freeze it** — a **release** (`name@3`) is an immutable tag, cut by a person,
  after a deterministic scan that refuses any vault value in the files.
- **Run it** — a release is **attached** to a profile, an agent or a cron. At
  spawn, the server hands the agent the releases it is attached to, through
  `--plugin-dir`, **only if the agent's group holds the use right**. A cron can
  additionally run a skill's script as its zero-token `check`.

**The secrets rule is unchanged and is what makes cross-group sharing safe:** a
skill carries secret **names**, never values. Whoever *uses* it supplies the
values from its own group (own → shared-in → `Main` → absent). Sharing a skill
shares prose and code; the vault never crosses a wall.

## Intent and why

Skills are the reusable know-how of a hybrid company — "how we qualify a lead",
"how we cut a release", "how we pull the weekly KPI export". Today:

- shadok only knows the skills it **seeds itself** (`seed*Skill`, copied over
  `~/.claude/skills/` at every boot). A skill a person writes is a loose folder on
  one machine: no version, no history, no review, no owner.
- every agent on the machine loads **every** skill in `~/.claude/skills`, so there
  is no way to give the deploy skill to `Shadok-Release` only, or the HR skill to
  the HR group only.
- under the multi-tenant design, each isolated group has its own HOME. A skill
  written in SALES's HOME is unreachable from MARKETING — which is correct for
  *files*, and wrong for a skill both teams want to build together.

The factory is where a skill is **co-written** (by people and agents from one or
more groups), **frozen** into releases, and **wired** into the agents and crons
that run it — with the same rights model as everything else.

## Vocabulary

| Term | Meaning |
|---|---|
| **Skill** | A Claude Code skill directory (`SKILL.md` + optional scripts/files) plus a shadok manifest. |
| **Manifest** | `shadok-skill.json` beside `SKILL.md`: `name`, `description`, `requires.secrets[]`, `requires.tools[]` (optional, informative). Server-managed fields (`id`, `owner`, `releases`) live in the factory registry, not in the files — a contributor cannot rewrite them by editing. |
| **Draft** | The skill's mutable git history (`main` branch of its factory repo). |
| **Release** | An immutable tag `v<N>` on the draft, with its tree hash. The only thing ever run. |
| **Owner group** | The ONE group that owns the skill. Decides its share lists. |
| **Editor groups** | Groups whose members (and agents) may push to the draft and cut releases. Always includes the owner. |
| **User groups** | Groups whose agents may run its releases. Editors are implicitly users. |
| **Attachment** | "This profile / agent / cron runs `name@N`." |
| **Binding** | Whether each `requires.secrets` name resolves in the *using* group. |

"Group" is always the multi-tenant spec's group (private / restricted / public),
never the old cosmetic tab group — that spec promotes one into the other.

## Ownership and rights

**[DECIDED] One owner group, two share lists — the secrets model, extended by one
column.** The multi-tenant spec gave a secret one owner and a "shared read with"
list, and rejected copies. A skill gets the same shape, with *read* split in two
because a skill, unlike a secret, is something people **write together**:

```
skill: { id, name, owner: <group>, editors: [<group>…], users: [<group>…], createdBy, createdAt }
```

- **Shared by reference, never by copy.** There is one draft history and one set
  of releases, held by the server. Each editor group works on a clone; each user
  group runs a read-only copy of a release. Nothing forks silently.
- **Private by default.** A new skill is owned by the creator's chosen group (their
  private group by default) and shared with nobody. Adding an editor or a user
  group is the outbound gesture — the twin of `--public` on a ledger line or a
  file dropped into `~/shared/`.
- **A skill owned by `Main` is public**: every group may see and use it. Who may
  *edit* a `Main` skill follows `Main`'s rule for shared assets — **[CALL]** any
  person may push to a `Main` draft, only an `admin` may release or change its
  share lists (the same line the multi-tenant spec draws for `Main` secrets: a
  house asset is an admin act to *publish*, not to *contribute to*).
- **A private group may own a skill and share it out.** The group itself can never
  be shared (no invitation into a private group, ever), but its *skill* can — the
  share is the explicit act, exactly as dropping a file into `~/shared/` from a
  private group is. Nobody else sees a private-owned skill until its owner adds
  them.
- **Seeing a skill = being in its owner, editor or user groups** (or it being
  `Main`'s). You cannot enumerate another group's skills — same as its agents.

### Who may do what

| Action | Who | Where |
|---|---|---|
| Create a skill | any person, owner = one of *their* groups | browser |
| See it (card, files, history) | members of owner / editor / user groups; everyone for `Main` | browser, agent |
| Push to the draft | members of an **editor** group; an agent whose **own** group is an editor | browser editor, `factory.mjs push` |
| Run the scan (dry-run) | anyone who may push | browser, agent |
| Cut a release | a **person** in an editor group (admin for a `Main` skill) | browser only |
| Change the editor / user lists | members of the **owner** group; an admin for a restricted owner (as for secrets); admin only for `Main` | browser only |
| Attach a release to an agent / cron | a person who may drive that agent (own groups + public), **and** the agent's group must be a user group | browser only |
| Attach to a profile | whoever may edit profiles (browser `PUT /profiles`, invariant 26) — the attachment is still filtered per group at spawn | browser only |
| Delete a skill | owner group members; refused while attached anywhere, unless forced (say who would lose it) | browser only |
| Transfer ownership | owner group members, to a group they also belong to | browser only |

Two lines carry the weight:

- **An agent may write, never publish.** A Skillsmith agent can push commits and
  run the scan; cutting a release, sharing and attaching are human clicks. A
  release is code every user-group agent will load — the same reason `PUT
  /profiles` is browser-only (invariant 26). Soft isolation, as always.
- **An admin's reach stays administrative.** As in the multi-tenant spec, an admin
  manages share lists of restricted-owned skills but does not see a restricted
  group's agents, and never a private group's skill unless shared. The factory
  adds no super-view.

## Writing a skill together

### Storage: the server is the origin

**[DECIDED] Each skill is a bare git repository held by the server**:
`~/.shadok-ai/factory/<instance-key>/<skill-id>.git`, owned by the server's user,
outside every group HOME. Under OS walls no group can open another group's files,
and a shared directory would erase the wall — so the meeting point is a remote,
exactly the multi-tenant spec's answer for code. History, diff, blame and
attribution come for free; a release is an annotated tag.

Contributors never touch that path. They reach it through the server:

- **A person** edits in the browser (below); each save is a commit authored by
  their account.
- **An agent** works in a clone **inside its own group's HOME**
  (`~/.shadok-factory/<skill>/`), made and refreshed by the `shadok-factory`
  skill:
  - `factory.mjs pull <skill>` — the server streams a `git bundle` of `main`;
  - `factory.mjs push <skill>` — the agent's new commits go up as a bundle to
    `POST /factory/skills/:id/push`, authenticated by `SHADOK_SESSION_KEY`. The
    server derives the agent's group from the key (never from the request),
    checks it is an editor group, and **fast-forwards only**.
  - A push that is not a fast-forward is refused with "someone pushed since —
    `pull` and replay your change": two editors never overwrite each other, and
    the history stays linear and readable. No merge machinery, no conflict
    markers in a skill file (invariant 9's lesson).
- Commits are **stamped by the server** with who pushed — `alice (SALES)` or
  `agent:Shadok-Skillsmith/1a2b3c4d (MARKETING)` — whatever the commit's own
  author field says. The history must answer "who wrote this line", and a client
  cannot be trusted to say.

**Why not a shared directory the editor groups all mount?** It is cheaper to build
and it is the one thing the multi-tenant spec forbids: a directory writable by
several OS users is either `~/shared/` (visible to *everyone*) or a new hole in
the wall. The server-as-origin costs a bundle round-trip and keeps every wall
intact.

### The Skills panel

One header entry, **Skills**, opens a full-panel overlay. On a single-tenant
instance it is one list; once groups exist, it is organised by group like the
secrets panel, with a 🧩 per group in the groups bar as the quick path.

Lists: **Mine to edit** (I am in an editor group), **Available to use** (a user
group I am in, or `Main`), **Attached** (where each release runs).

A skill card shows: description, owner group, editor / user chips, latest release
and how far `main` is ahead of it, the **bindings** for the group being viewed
(one chip per required secret: green = resolves here, red = "missing in this
group → Set it", which opens that group's secrets panel pre-filled), and where it
is attached.

Card actions:

- **Open** — the file tree, a Markdown/text editor per file (save = commit), the
  history with per-commit diff and author, and the scan results of `main`.
- **Work on it with an agent** — spawns an agent on the managed
  `Shadok-Skillsmith` profile **in one of the person's editor groups** (they pick
  which, if several), with the skill pulled into its clone. This is the factory
  part: a skill is improved the way everything in shadok is — by an agent, in
  chat, with a diff panel. Several agents from several editor groups can work on
  the same skill at once; the fast-forward rule serialises them.
- **Release** — runs the scan, shows the diff since the last release, asks for a
  one-line note, tags `v<N+1>`.
- **Share** — the editor and user lists, with the owner group fixed.
- **Attach** — to a profile, an agent, or a cron (below).

### The Skillsmith role

`Shadok-Skillsmith` is a **managed** profile (like `Shadok-Tweak`: its prompt is
rewritten from `context/skillsmith-prompt.md` at every boot, so it is hidden from
pickers by `isManagedProfile` and spawned only from the factory). Its prompt
teaches the manifest, the secrets rule ("names only; read values from the env;
declare every one you read"), the `pull` / edit / **test** / `scan` / `push`
loop, and that releasing is the human's click. Guardrails: no `deny` beyond the
cockpit defaults — it must run the skill's scripts to test them.

## Using a skill: agent, profile, cron

### The mechanism: `--plugin-dir`, per process

**[DECIDED, to be measured] A release reaches an agent as a plugin passed on its
own command line, never by writing into `~/.claude/skills`.** Claude Code
(2.1.197 here) has `--plugin-dir <path>` — "Load a plugin from a directory or
.zip", repeatable. A plugin can carry skills (`skills/<name>/SKILL.md` under a
`.claude-plugin/plugin.json`). So at spawn the server:

1. resolves the agent's **effective attachments** (profile ∪ agent ∪ crons that
   target it — below), and keeps only those whose skill lists the agent's group
   as a user group (or is `Main`'s). A dropped attachment is logged by name, never
   silent;
2. materialises each release once per using group as a read-only plugin directory
   **owned by that group's OS user**, in its HOME
   (`~/.shadok-factory/plugins/<skill>@<N>/`), from the tag's tree — content
   addressed by the tree hash, so two agents of the group share it;
3. passes one `--plugin-dir` per release.

What this buys, at once:

- **Per-profile and per-agent skills** — the old draft's main open question —
  with no allow-list the CLI does not have: an agent simply never receives a
  plugin it is not attached to.
- **No collision with skills the user owns.** `~/.claude/skills` is untouched;
  nothing to adopt, nothing to overwrite (the additive posture of
  `claude-home.ts`).
- **Group isolation by construction**: the plugin directory lives in the using
  group's HOME, owned by its user; the agent runs what is there and nothing else.

Two things to state plainly:

- **Plugin skills are namespaced** (`<plugin>:<skill>` — visible in this very
  session's skill list, e.g. `vercel:deploy`). The plugin is named after the skill
  so the agent sees `lead-qualify:lead-qualify`; **[OPEN]** a short shared plugin
  name per group (`factory:lead-qualify`) reads better but puts several releases
  in one plugin directory. Recommend one plugin per release for v1 — simpler
  provenance, one directory per tree hash.
- **This must be measured on a live interactive agent before it is built on** —
  that a `--plugin-dir` skill is listed, triggers on its description, and runs its
  scripts; and that it survives `--resume`. Not under `claude -p` (invariant 29's
  trap, again). The flag existing is not the flag behaving.

**Fallback if the measurement fails** — install into the using group's
`~/.claude/skills` under a factory prefix (`factory-<name>`) with a
`.shadok-managed.json` marker. That loses per-agent precision (every agent of
the group sees every installed skill) but keeps group isolation, because each
isolated group has its own HOME. The panel would then say "installed in group X"
rather than "attached to agent Y".

### Attaching

**[DECIDED] Attachments name a release, never `main`.** Code an agent loads must
have been frozen and scanned. An attachment is `{ skill, release }` with an
optional **follow** flag (default **off**):

- off → pinned; a newer release shows as "update available: v4 → v5" with its
  diff, applied by a click;
- on → the next spawn of that agent takes the latest release. Opt-in only,
  because a new release is a supply-chain event.

Three places, one resolution:

| Attached to | Stored on | Effect |
|---|---|---|
| **A profile** | `Profile.skills: [{skill, release, follow?}]` | every agent of that role, *in groups that may use it*. A profile is global (multi-tenant spec), so the attachment is too — and the group filter at spawn is what keeps it from reaching a group that was never granted the skill. Exactly how a profile names a secret and the group decides whether it resolves. |
| **An agent** | the channel (`skills`, `SERVER_OWNED`, assert-only like `model` — a resume that omits it never erases it, invariant 1 / 24) | that agent only, on top of its profile's. Applied with a respawn (`--plugin-dir` is a spawn arg, same as `set-model`). |
| **A cron** | `Cron.skills` | the cron's **target agent** carries it (merged into that agent's effective set) — see below. |

Effective set = profile ∪ agent ∪ its crons', de-duplicated by skill (the agent's
own pin wins over the profile's, a cron's pin over the agent's for its own
skill). The set is part of the **spawn fingerprint** (`prepromptParts` /
`stalenessReasons`, invariant 40), so an attachment, an update or a revoked use
right lights the existing reload indicator — "started without `lead-qualify@5`" —
and nothing silently runs stale code.

### In a cron

A cron drives one agent (`Cron.sessionId`), and skills are spawn-time. So
"use a skill in a cron" is two things, both useful:

1. **The skill does the work, in the agent's turn.** `Cron.skills` puts the
   release in the target agent's effective set (respawn on attach, as above) and
   the cron editor offers "**Use skill ▾**", which prefills the prompt with
   `Use the <skill> skill to …`. The common case: a weekly report the skill
   knows how to build.
2. **The skill's script is the guard.** The cron's deterministic `check` (run
   server-side, **without the LLM**, invariant 16) may reference a script of an
   attached release: `check: "{skill:kpi-export}/scripts/check.sh"`. The server
   expands the placeholder to the materialised plugin path **of the agent's
   group**, runs it as that group's user with that agent's resolved secrets, and
   refuses the cron (out loud, at save) if the release is not attached or the
   group lost its use right. A monitoring skill thus ships its own zero-token
   "anything new?" probe, written and reviewed once, reused by every group that
   uses it.

A cron's skills follow the cron: deleting the cron detaches them from the agent
(at its next spawn), unless the agent or its profile also carries them.

### When a right is revoked

Removing a group from `users` (or `editors`) takes effect **at the next spawn**:
the attachment is dropped from the effective set, the agent's reload indicator
says why, and the panel lists the attachments that just became inert. A running
agent keeps what it was started with — a live process's skills cannot be pulled
from under it, the same limit as a live process's env — and the panel says so
rather than pretending. The plugin directories of a release no group uses any
more are pruned.

## Secrets: names travel, values don't

**[DECIDED] A skill carries secret NAMES, never VALUES. The using group supplies
the values**, with the multi-tenant precedence: own group → shared-in → `Main` →
absent. A SALES agent running `lead-qualify` gets SALES's `HUBSPOT_TOKEN`; a
MARKETING agent, MARKETING's — or a red chip "missing in MARKETING" until someone
sets it there.

- **Values reach a skill only through the agent's env**, injected at spawn by the
  existing path. The factory adds no `get`, and a skill can never read the vault.
- **`requires.secrets` is informative, not an injection list.** It drives the
  binding chips and the scan. *Injection* stays the profile's / group's business:
  attaching a skill does not hand its secrets to a role that does not already
  name them. **[OPEN]** whether attaching should *offer* to add the missing names
  to the profile's secret list — recommend yes, as an explicit checkbox in the
  attach dialog, never implicit.

### The publish scan (deterministic, no model call)

Run on every release, available as a dry-run on any push:

1. **Vault match — refuses.** Every file is searched for every vault value of
   length ≥ 8, **in every group's slice** — the server is the only reader, and a
   co-written skill may have had an editor from a group the releaser cannot see.
   A hit refuses the release and names the file and line. It names the **secret**
   only if the releaser may see that secret; otherwise it says "a value from a
   vault slice you cannot see" — naming it would leak its existence across a wall.
2. **Forbidden files — refuses.** `.env*`, `*.pem`, `*.key`, `id_*`,
   `credentials*`, `*.jsonl` (a transcript), anything over a size cap.
3. **Shape match — warns.** Common token formats (`sk-…`, `ghp_…`, `xox?-…`, AWS
   keys, PEM headers, long high-entropy strings), with an explicit "this is not a
   secret" override recorded in the release. Warn, not refuse: placeholders look
   like tokens, and a scan that cries wolf gets bypassed by habit.
4. **Undeclared env — warns.** A script reading `process.env.X` / `$X` where `X`
   names a secret in any slice but is absent from `requires.secrets` → "declare
   it", because an undeclared dependency shows bound in one group and breaks in
   the next.

## What stays out

- **shadok's own seeded skills** (`shadok-ai-agents`, `shadok-secrets`, the new
  `shadok-factory`…) are not factory skills: rewritten at every boot, listed
  read-only, never editable (the `Shadok-Tweak` lesson).
- **Unmanaged skills in `~/.claude/skills`** are never touched. "Adopt into the
  factory" imports one as a new draft owned by a group the person picks; the
  original folder stays where it is.
- **Cross-org sharing** (another shadok instance, via peers) keeps the old draft's
  design — peer catalogue, pull, `contentHash` check, import review, admin-only
  per-peer share — as a later phase. A peer is simply one more kind of *user*
  entry (`peer:<name>`), read-only, releases only, and never an editor in v1.

## Degradation: a single-tenant instance

With only `Main`, there are no walls and no share lists to show: every skill is
`Main`'s, every person may push, an admin releases, and attaching works on
profiles, agents and crons exactly as above. Group pickers and share lists appear
only once a second group exists — the same rule as the secrets panel. This means
**phases 1–2 ship before the multi-tenant work**, and become multi-group by
filling in the lists, not by a redesign.

## Endpoints (sketch)

- `GET /factory/skills` — the lists for the caller (filtered by group).
- `POST /factory/skills` — create / adopt; `DELETE /factory/skills/:id`.
- `GET /factory/skills/:id/tree`, `…/file?path=`, `…/log`, `…/diff?from=&to=`.
- `PUT /factory/skills/:id/file` — browser editor save = one commit.
- `GET /factory/skills/:id/bundle`, `POST /factory/skills/:id/push` — the agent
  clone's pull / push (session key; fast-forward only).
- `POST /factory/skills/:id/scan` — dry-run.
- `POST /factory/skills/:id/release` — browser only.
- `PUT /factory/skills/:id/share` — `{editors, users}`, browser only.
- Attachments ride the existing writes: `PUT /profiles` (`skills`), a new WS
  `set-skills` (twin of `set-model`, respawns), and the cron `PUT` (`skills`).

Every route derives the caller's groups server-side (account cookie, or the
agent's session key → its group). None trusts a group named in the body.

## Phasing

1. **Measure `--plugin-dir`** on a live interactive agent (listed, triggers,
   scripts run, survives `--resume`). Decides between the main path and the
   fallback; one afternoon, and nothing else should be built before it.
2. **Local factory, single-tenant** — bare repos, browser editor, Skillsmith +
   `shadok-factory` skill (pull / push / scan), releases with the scan, attach to
   profile / agent / cron (incl. `{skill:…}` checks), fingerprint wiring.
3. **Groups** — owner / editors / users, the per-group panel and 🧩, scan across
   slices, revocation. Lands with (or after) the multi-tenant work.
4. **Cross-org** — peers as user entries, catalogue / pull / import review.

Each phase ships with its README / architecture / CLAUDE.md updates.

## Goals / non-goals / anti-goals

**Goals** — people and agents from one or more groups co-write a skill with full
history and attribution; releases are frozen and scanned; a release runs in
exactly the profiles, agents and crons it is attached to, in groups granted its
use; secrets never cross a wall.

**Non-goals (v1)** — a public marketplace; real-time co-editing (two cursors in
one file); merge of concurrent edits (fast-forward + replay is enough at this
scale); sharing secrets themselves across groups through a skill.

**Anti-goals** (a design that does these has failed even if it works):
- A secret value in a release, a bundle, a commit, a log line or an error message.
- An agent loading code no human released, or a new release without a human
  seeing its diff (unless that human opted into `follow`).
- A skill reaching an agent whose group was never granted it — or one group
  learning, through the factory, the name of another group's secret or skill.
- Writing into `~/.claude/skills` on the main path, or overwriting a skill shadok
  does not own on any path.
- A revoked right or a new release that leaves an agent on old code with nothing
  saying so.

## Handed to other specs

- **Secret rotation staleness** (old draft): fingerprint each secret at spawn,
  surface "started with the previous value of X" in the reload indicator, keep one
  previous value for a rollback window. Belongs to the per-group secrets panel of
  the multi-tenant spec, not here.

## Open decisions (summary)

- Plugin naming: one plugin per release (recommended) vs one `factory` plugin per
  group.
- Attaching offers to add missing secret names to the profile — explicit checkbox
  (recommended)?
- `Main` skills: any person pushes, admin releases — confirm the [CALL].
- Should a cron's `{skill:…}` check be allowed on a release attached to the agent
  by its *profile* only, or require an explicit `Cron.skills` entry? Recommend
  explicit: a cron's guard should not change because someone edited a role.
