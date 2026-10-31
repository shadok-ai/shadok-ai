# Skill Factory — co-write a skill across one or more groups, then run it in an agent or a cron

Status: **Draft for review** — revised 2026-10-31, then challenged and measured
the same day. Points settled are marked **[DECIDED]**, calls the author
made that a builder could not settle alone **[CALL]**, points left open
**[OPEN]** (each with a recommendation). Nothing here is built.

> **What changed since the 2026-10-29 draft (read this if you saw it).**
> 1. **Vocabulary realigned on the multi-tenant spec** as it stands after #362–#364
>    (`2026-10-29-multi-tenant-scoped-isolation-design.md`): no more `owner` /
>    `group` / `instance` *scopes*, no "team" — **one concept, the group**, with
>    three natures (private / restricted / public), and `Main` as the public
>    commons.
> 2. **A skill is shared between ONE OR MORE groups**, with two separate rights —
>    *edit* (co-write) and *use* (run).
> 3. **"Use it in an agent / a cron" is designed**: a release reaches an agent
>    through `claude --plugin-dir` at spawn, per process, never by writing into
>    `~/.claude/skills`. A cron uses what its target agent carries.
> 4. **The Secrets tab is removed** — the multi-tenant spec owns the per-group
>    secrets panel (#362). This spec only consumes secrets.
>
> **What the challenge pass changed (same day).** An adversarial review found a
> cross-group supply chain (code written by one group running with another
> group's secrets, with no human of the running group in the loop) and a
> cross-wall oracle in the scan. Fixes folded in: **a release runs in a group only
> once a person of that group accepted its exact tree hash**; no auto-follow; the
> Skillsmith runs draft code with **no secrets**; the vault scan runs **at push**,
> against what the pusher could have pasted; profile attachments, `Cron.skills`
> and skill-script cron checks are **cut from v1**; nothing respawns implicitly;
> the fate of a skill whose owner group is destroyed is now specified. See
> "Challenge log" at the end for what was accepted, adjusted or refused.

## The whole thing in one page

**A skill has one owner group, a list of groups that may co-write it (editors),
and a list of groups that may run it (users).** Private by default; every share is
an explicit act. That is the multi-tenant spec's one rule ("you only see and
touch your own groups + the public") and its one gesture ("to cross a wall, make
one deliberate outbound move") applied to skills.

- **Write it together** — a draft is a git history held by the server. Editors (a
  person, or a `Shadok-Skillsmith` agent in an editor group) work on clones and
  **push**; the server is the `origin`, checks the pusher on every push, scans
  each push for vault values, and accepts fast-forwards only.
- **Freeze it** — a **release** (`name@3`) is an immutable tag cut by a person.
- **Run it** — a person of the **using** group accepts a release (its exact tree
  hash) and attaches it to an agent of their group. At spawn the agent receives it
  through `--plugin-dir`. A cron simply drives an agent that carries it.

**Two rules make cross-group sharing safe:**

1. **Names travel, values don't.** A skill carries secret *names*; the group
   that runs it supplies the values (own → shared-in → `Main` → absent).
2. **Code crosses a wall only through a human of the receiving side.** A release
   written by MARKETING runs in SALES only after a SALES person has seen it and
   accepted that exact tree. Nothing updates on its own.

## Intent and why

Skills are the reusable know-how of a hybrid company — "how we qualify a lead",
"how we cut a release", "how we pull the weekly KPI export". Today:

- shadok only knows the skills it **seeds itself** (`seed*Skill`, copied over
  `~/.claude/skills/` at every boot). A skill a person writes is a loose folder on
  one machine: no version, no history, no review, no owner.
- every agent on the machine loads **every** skill in `~/.claude/skills`, so the
  deploy skill cannot be given to one agent only.
- under the multi-tenant design, each isolated group has its own HOME. A skill in
  SALES's HOME is unreachable from MARKETING — right for *files*, wrong for a
  skill both teams want to build together.

## Vocabulary

| Term | Meaning |
|---|---|
| **Skill** | A Claude Code skill directory (`SKILL.md` + optional scripts/files) plus a manifest. |
| **Manifest** | `shadok-skill.json` beside `SKILL.md`: `name`, `description`, `requires.secrets[]`. Server-managed fields (`id`, `owner`, lists, releases) live in the factory registry, never in the files — a contributor cannot rewrite them by editing. |
| **Draft** | The skill's mutable git history (`main` of its factory repo). |
| **Release** | An immutable tag `v<N>` with its tree hash. The only thing ever run. |
| **Owner group** | The ONE group that owns the skill and decides its lists. |
| **Editors** | Groups whose people (and Skillsmith agents) may push and release. Always includes the owner. |
| **Users** | Groups that may run its releases. Editors are implicitly users. |
| **Acceptance** | "Group G accepts `name@N` (tree `abc…`)", recorded with the person who clicked. |
| **Attachment** | "This agent runs `name@N`." |

## Ownership and rights

**[DECIDED] One owner group, two lists — the secrets model with *read* split in
two**, because a skill, unlike a secret, is something people write together:

```
skill: { id, name, owner: <group>, editors: [<group>…], users: [<group>…], createdBy, createdAt }
```

- **By reference, never by copy.** One draft history, one set of releases, held
  by the server. Nothing forks silently.
- **Private by default.** A new skill is owned by a group the creator picks (their
  private group by default) and shared with nobody. Adding an editor or a user is
  the outbound gesture — the twin of `--public` on a ledger line.
- **A `Main`-owned skill is public**: everyone may see it; using it in a group
  still needs that group's acceptance (rule 2). **[CALL]** Any person may push to
  a `Main` draft; only an `admin` releases it or changes its lists — the line the
  multi-tenant spec draws for `Main` secrets.
- **A private group may own a skill and share it out.** The group can never be
  shared; its *skill* can, and the share is the explicit act.
- **Seeing a skill = being in its owner, editor or user groups** (or it being
  `Main`'s). Another group's skills cannot be enumerated.
- **[DECIDED] Two lists, not one.** The challenge proposed editors = users for v1.
  Refused: "SALES runs TECH's skill without being able to change it" is the
  common case, and it costs one column.

### Who may do what

| Action | Who | Where |
|---|---|---|
| Create a skill | any person; owner = one of *their* groups | browser |
| See it (card, files, history) | owner / editor / user groups; everyone for `Main` | browser, agent |
| Push to the draft | a person in an **editor** group; an agent whose own group is an editor **and** whose channel profile is `Shadok-Skillsmith` (read from the channel, invariant 1) | browser, `factory.mjs push` |
| Cut a release | a **person** in an editor group (admin for `Main`) | browser only |
| Change the lists | **owner** group members; an admin for a restricted owner (administrative reach); admin only for `Main` | browser only |
| Accept a release for group G | a **person in G** (admin cannot accept for a group they are not in — acceptance is operational, not administrative) | browser only |
| Attach an accepted release to an agent | a person who may drive that agent | browser only |
| Delete a skill | owner group members; refused while attached, unless forced (lists who loses it) | browser only |
| Transfer ownership | owner members, to a group they also belong to; an admin, when the owner group is being destroyed (below) | browser only |

- **Agents write, people publish and accept.** A Skillsmith pushes commits; cutting
  a release, sharing, accepting and attaching are human clicks (the reason `PUT
  /profiles` is browser-only, invariant 26). Restricting pushes to the Skillsmith
  profile keeps "every agent of the group" — on single-tenant `Main`, every agent
  on the machine — from writing into shared code.
- **Admin reach stays administrative.** An admin manages lists of restricted-owned
  skills, never sees a private group's skill unless shared, and never accepts code
  on behalf of a group they are not in.

## Writing a skill together

### Storage: the server is the origin

**[DECIDED] Each skill is a bare git repository held by the server**:
`~/.shadok-ai/factory/<instance-key>/<skill-id>.git`, owned by the server's user,
outside every group HOME. A directory writable by several OS users is either
`~/shared/` (visible to everyone) or a hole in the wall, so the meeting point is a
remote — the multi-tenant spec's answer for code, with shadok as the remote.

- **A person** edits in the browser: a read of the tree, history and per-commit
  diff, plus a plain text editor per file whose save is one commit authored by
  their account. **[CALL]** Kept in v1 against the challenge's "read-only browser"
  proposal: the request is that *people* work on a skill together, and a person
  who is not a developer has no clone.
- **An agent** works in a clone **inside its own group's HOME**
  (`~/.shadok-factory/<skill>/`), through the seeded `shadok-factory` skill:
  - `factory.mjs pull <skill>` — the server streams a `git bundle` of `main`;
  - `factory.mjs push <skill>` — new commits go up as a bundle to
    `POST /factory/skills/:id/push`, authenticated by `SHADOK_SESSION_KEY`. The
    server derives the agent's group and profile from the key and the channel
    (never from the request) and **fast-forwards only**.
  - A non-fast-forward is refused: "someone pushed since — `pull` and replay your
    change". No merge machinery, no conflict markers (invariant 9's lesson).
- **Every push is size-capped at the HTTP layer** and stamped by the server with
  who pushed — `alice (SALES)` or `agent:Shadok-Skillsmith/1a2b3c4d (MARKETING)` —
  whatever the commit says. Each push, release, list change, acceptance and
  attachment writes one audit row (the `secret-audit.ts` pattern: append-only
  JSONL, names only).

### The scan runs at push, against what the pusher could have pasted

**[DECIDED] The vault check runs on every push and every browser save — before
the commit enters the shared history.** A bundle carries the whole history, so a
value committed and removed later would otherwise reach every editor group
forever; a check at release is too late.

1. **Vault match — refuses the push.** The new blobs are searched for every vault
   value (length ≥ 8) **the pusher's group resolves** (own → shared-in → `Main`).
   Those are the only values they could have pasted. The refusal names the file,
   the line and the secret name — all of which the pusher may see. **No
   cross-slice scan**: refusing on "a value from a slice you cannot see" would let
   any editor test a guessed password against another group's vault — an oracle
   through the wall.
2. **Forbidden files — refuses.** `.env*`, `*.pem`, `*.key`, `id_*`,
   `credentials*`, `*.jsonl` (a transcript), anything over the size cap.
3. **Shape match — warns** (at push and again at release). `sk-…`, `ghp_…`,
   `xox?-…`, AWS keys, PEM headers, long high-entropy strings, with an explicit
   "this is not a secret" override recorded in the release. Warn, not refuse: a
   scan that cries wolf gets bypassed by habit.
4. **Undeclared env — warns at release.** A script reading `process.env.X` / `$X`
   where `X` is a secret name the releaser can see but absent from
   `requires.secrets` → "declare it".

### The Skillsmith role

`Shadok-Skillsmith` is a **managed** profile (like `Shadok-Tweak`: prompt rewritten
from `context/skillsmith-prompt.md` at every boot, hidden from pickers by
`isManagedProfile`, spawned only from the factory). Its prompt teaches the
manifest, the secrets rule, the `pull` / edit / test / `push` loop, that releasing
is a human click, and that **the draft is untrusted input** — it may contain code
another group pushed a minute ago.

**[DECIDED] It spawns with NO secrets by default.** It runs the draft's scripts to
test them, and those scripts may come from another editor group's last push,
unscanned by any human. The "Work on it" dialog lists the skill's
`requires.secrets` with **unticked** boxes; a person who ticks one is choosing to
run the current draft with that value. Guardrails: no `deny` beyond the cockpit
defaults.

## Using a skill: accept, attach, run

### Acceptance — the receiving side's human gate

**[DECIDED] A release runs in group G only after a person of G accepted its exact
tree hash.** The challenge's central finding: with editors and users in different
groups, "a release exists" means "someone *else* decided this code is fine". The
group whose agents (and secrets) will run it must decide too.

- The accept screen shows the origin, the file list, the **full diff against the
  release G currently runs** (or the whole tree the first time), every script
  highlighted, the required secret names with G's bindings (green / red), and the
  scan warnings. Accepting records `{group, skill, release, treeHash, by, at}`.
- An editor group's own releases still need an acceptance by a person of that
  group to run there — usually the releaser, in one click ("release and accept for
  SALES").
- **No `follow` / auto-update in v1.** A new release shows as "v5 available" on
  every attachment; nothing changes until a person accepts and re-attaches. If an
  opt-in follow ever comes back, it is refused whenever the release came from an
  editor group other than the using one.
- **Revocation.** Removing G from `users` (or `editors`) makes G's attachments
  inert at the next spawn; acceptances stay in the audit log.

### The mechanism: `--plugin-dir`, per process

**[DECIDED, measured] A release reaches an agent as a plugin passed on its
own command line, never by writing into `~/.claude/skills`.** At spawn the server:

1. reads the agent's attachments and keeps those whose release is **accepted by
   the agent's group** and whose skill still lists that group (a dropped one is
   logged by name, never silent);
2. materialises each accepted release once per using group as a read-only plugin
   directory **owned by that group's OS user**, in its HOME
   (`~/.shadok-factory/plugins/<skill>@<N>/`, `.claude-plugin/plugin.json` +
   `skills/<name>/…`), content-addressed by tree hash;
3. passes one `--plugin-dir <dir>` pair per release, emitted from `profileArgs`
   beside the other spawn args. Mind the trap documented there: `--mcp-config`
   is variadic and swallows every following non-flag word. A `--plugin-dir`
   flag ends that run, but no bare value may ever sit right after
   `--mcp-config`'s JSON. The arg-order test should cover it.

**Measured 2026-10-31** (throwaway interactive `claude` in tmux, scratch
directory, probe plugin `kpi-probe` carrying skill `pd-probe`), on Claude Code
**2.1.197** and **2.1.309**:

- With `--plugin-dir`, `/skills` lists `kpi-probe:pd-probe · plugin · locked by
  plugin`. Without the flag (control), it is absent. So the per-process set works
  as far as *loading* goes, on an old and a current release.
- Plugin skills are **namespaced `<plugin>:<skill>`**, and shown "locked by
  plugin" (cannot be toggled off from the TUI). One plugin per release, named
  after the skill, gives `kpi-export:kpi-export`; **[OPEN]** a shorter plugin name
  per group (`factory:kpi-export`) would put several releases in one plugin dir.
  Recommend one plugin per release — provenance is one dir per tree hash.

**Turn-level, measured the same day on 2.1.309, signed in (Team plan).** Same
probe. Its `SKILL.md` answers "the zebra quartz report" by running
`bash ${CLAUDE_PLUGIN_ROOT}/skills/pd-probe/scripts/report.sh`, which prints an
env var the launcher set (standing in for a vault secret) and
`$CLAUDE_PLUGIN_ROOT`, then writes the same line to a marker file:

| Run | Result |
|---|---|
| Fresh session, `--plugin-dir plug` | **Triggers on its description** (`Skill(kpi-probe:pd-probe)` → "Successfully loaded skill"); the script runs; it **sees the agent's env** (`secret=s3cr3t-from-env`) |
| `--resume`, same `--plugin-dir` | Still available; runs again |
| `--resume`, **no** `--plugin-dir` | `Error: Unknown skill: kpi-probe:pd-probe` — the skill is **gone** for the new process, although the transcript still shows earlier calls to it |
| `--resume`, `--plugin-dir plug2` (same plugin name, changed script, another dir) | The **new** release runs (`ZQ-V2`) |

What this settles:

- **The main path holds.** Per-agent skills, revocation and update all reduce to
  "which `--plugin-dir` pairs did this spawn get", and the reload-to-apply flow
  (respawn with `--resume`) is enough to apply an attach, an update or a
  revocation. No fallback needed.
- **`${CLAUDE_PLUGIN_ROOT}` is substituted in `SKILL.md`, not exported to
  scripts** (`root=unset` in every run). Factory skills must locate their own
  files from the path the SKILL.md hands them, or from `$(dirname "$0")`. The
  Skillsmith prompt says so, and the release scan **warns** on a script that
  reads `$CLAUDE_PLUGIN_ROOT`.
- **Secrets reach skill scripts exactly as they reach any Bash call** — through
  the agent's env. The "names travel, values don't" rule needs no new mechanism.
- **A resumed agent may notice the move.** On the plug → plug2 resume, the model
  commented that the skill "now loads from a different location" before running
  it. That is harmless, even welcome, and it argues for stable paths
  (`<skill>@<N>/`, content-addressed) over a random directory per spawn.

Not measured: a plugin dir owned by a different OS user than the one reading it
(phase 3, multi-tenant). Plain reading should be enough, since the agent runs as
the owner.

**Fallback, kept in case a later release breaks this**: install into the using
group's `~/.claude/skills` under a `factory-` prefix with a `.shadok-managed.json`
marker. This loses per-agent precision but keeps group isolation.

**Stated plainly:** in the commons (`Main` and every public group share one OS
user), a materialised plugin dir is readable by every public agent — per-agent
precision is a command-line argument, not a file permission. That is the "public
is no wall" rule, not a leak. Private and restricted groups keep the real wall.

### Attaching to an agent

**[DECIDED] v1 attaches to agents only.** `Channel.skills: [{skill, release}]`,
`SERVER_OWNED`, assert-only like `model` (a resume that omits it never erases it,
invariants 1 / 24). Phase 2 writes it only through `POST /factory/attach`, from
the Skills panel. A WS `set-skills` in the agent's own menu (twin of
`set-model`) is a later convenience.

- The attachment set is part of the **spawn fingerprint** (`prepromptParts` /
  `stalenessReasons`, invariant 40), so a new attachment, a newly accepted release
  or a revoked right lights the existing reload indicator — "started without
  `kpi-export@5`".
- **Nothing respawns implicitly.** Attaching from the factory panel, accepting a
  release, or a revocation only marks the agent stale (a future `set-skills` from
  the agent's own menu may respawn like `set-model`, since the person is on that
  agent and asked);
  the reload is the person's click. Killing a working agent because someone saved
  something elsewhere is exactly what the reload indicator exists to avoid.

**Profile attachments — cut from v1 [DECIDED].** Profiles are global and readable
by every member, so a restricted group's skill attached to `dev` would show its
*name* to every group (an anti-goal), and a role edit would change running code in
every group at once. If they come back, `GET /profiles` must filter `skills` per
caller and acceptance still applies per group.

### In a cron

**[DECIDED] A cron uses what its target agent carries.** A cron drives one agent
(`Cron.sessionId`), and skills are per process, so a skill pinned "for a cron"
would really change the agent for all its turns — and two crons pinning v4 and v5
of the same skill have no sane resolution. So:

- the cron editor's **"Use skill ▾"** lists the target agent's attachments and
  prefills the prompt with `Use the <plugin>:<skill> skill to …`;
- to give a cron a new skill, attach it to the agent (reload on click);
- the common setup is one agent per recurring job, which keeps "what the cron
  runs" equal to "what that agent carries".

**Skill scripts as a cron's zero-token `check` — cut from v1 [DECIDED].** A
`check` runs server-side, without the model or any guardrail, every slot, as the
using group's user — and `runCronCheck` today injects the profile's whole secret
list. A script from another group's release running there is the sharpest form of
the supply chain above. If it comes back: only accepted releases, only the
release's `requires.secrets` in its env, and refused while the release came from
another group unless that group's acceptance is fresh for that tree.

## Secrets: names travel, values don't

**[DECIDED] A skill carries secret NAMES, never VALUES; the using group supplies
the values** with the multi-tenant precedence (own → shared-in → `Main` → absent).

- Values reach a skill only through the agent's env, injected at spawn by the
  existing path. The factory adds no `get`.
- `requires.secrets` is **informative**: it drives the binding chips (green =
  resolves in this group, red = "missing in this group → Set it", which opens
  that group's secrets panel pre-filled) and the scan. *Injection* stays the
  profile's / group's business, edited on the secrets side as #362 decided — the
  factory does not offer to add names to a profile.

## When the owner group disappears

A private group is destroyed in cascade with its account; a restricted group can
be emptied of members.

- **[DECIDED]** The account-deletion warning lists the private group's skills that
  were **shared out** (editors or users beyond the owner).
- A never-shared skill dies with its group (it was never anyone else's).
- A shared-out skill is **transferred** at deletion time to a group the deleting
  admin picks among its editor groups (or `Main`), so it keeps an owner who can
  manage its lists. Already-accepted releases keep running where they were
  accepted — they were deliberately shared and deliberately accepted.
- A restricted owner group emptied of members: an admin may transfer ownership
  the same way (membership and ownership are administrative acts).

## What stays out

- **shadok's own seeded skills** (`shadok-ai-agents`, `shadok-secrets`,
  `shadok-factory`…) are not factory skills: rewritten at every boot, listed
  read-only (the `Shadok-Tweak` lesson).
- **Unmanaged skills in `~/.claude/skills`** are never touched. "Adopt into the
  factory" (later phase) would import one as a new draft.
- **Cross-org sharing** (another shadok instance, via peers): a peer becomes one
  more *user* entry, read-only, releases only, with acceptance on the receiving
  instance. Later phase.

## Degradation: a single-tenant instance

With only `Main`: no lists to show, every skill is `Main`'s, any person pushes,
an admin releases, and acceptance is the same click as attaching (one group). The
Skillsmith-only push rule and the push-time scan still apply. Phases 1–2 ship
before the multi-tenant work and become multi-group by filling in the lists.

## Endpoints (sketch)

- `GET /factory/skills` — the caller's lists (filtered by group).
- `POST /factory/skills`, `DELETE /factory/skills/:id`.
- `GET /factory/skills/:id/tree`, `…/file?path=`, `…/log`, `…/diff?from=&to=`.
- `PUT /factory/skills/:id/file` — browser save = one commit (scanned).
- `GET /factory/skills/:id/bundle`, `POST /factory/skills/:id/push` — session key,
  Skillsmith only, fast-forward only, size-capped, scanned.
- `POST /factory/skills/:id/release` — browser only.
- `PUT /factory/skills/:id/share` — `{editors, users}`, browser only.
- `POST /factory/skills/:id/accept` — `{group, release}`, browser only, a person
  in that group.
- `POST /factory/attach` — `{sessionId, skill, release | null}`, browser only;
  marks the agent stale (built). WS `set-skills` — later.
- `POST /factory/skills/:id/workspace` — prepares the Skillsmith's clone (built).

Every route derives the caller's groups server-side (account cookie, or the
agent's session key → its channel → its group and profile). None trusts a group
named in the body.

## Phasing

1. ~~**Measure `--plugin-dir`**~~ — **done 2026-10-31** (see "The mechanism"):
   the main path holds on 2.1.309. Re-run the probe whenever a Claude Code
   upgrade touches plugins.
2. **Local factory, single-tenant** — **built 2026-10-31**: bare repos, push-time
   scan, browser editor, Skillsmith + `shadok-factory` skill, releases,
   acceptance, agent attachments, fingerprint wiring, audit rows. Verified end
   to end on a side-by-side build. A Skillsmith wrote and pushed a skill, a
   person released, accepted and attached it, and the agent it was attached to
   triggered it after a reload.
3. **Groups** — owner / editors / users, the per-group panel and 🧩 in the groups
   bar, revocation, owner-destruction transfer. With (or after) the multi-tenant
   work.
4. **Later** — profile attachments (filtered), skill-script cron checks (scoped
   secrets), adopt-from-`~/.claude/skills`, cross-org peers.

Each phase ships with its README / architecture / CLAUDE.md updates.

## Goals / non-goals / anti-goals

**Goals** — people and agents from one or more groups co-write a skill with
history and attribution; releases are frozen; a release runs only in agents of
groups that were granted it **and accepted it**; a cron runs it through its agent;
secrets never cross a wall.

**Non-goals (v1)** — a marketplace; real-time co-editing; merging concurrent
edits; profile-level attachments; skill scripts as cron checks; auto-update.

**Anti-goals** (a design that does these has failed even if it works):
- A secret value in a commit, a bundle, a release, a log line or an error.
- Code from one group running with another group's secrets without a person of
  the running group having seen and accepted that exact tree.
- A skill reaching an agent whose group was never granted it — or one group
  learning, through the factory, the name or the value of another group's secret
  or skill.
- Writing into `~/.claude/skills` on the main path; overwriting a skill shadok
  does not own on any path.
- An agent restarted because of something done elsewhere, or left on old code
  with nothing saying so.

## Handed to other specs

- **Secret rotation staleness** (old draft): fingerprint each secret at spawn and
  surface "started with the previous value of X" in the reload indicator. Belongs
  to the multi-tenant spec's per-group secrets panel.

## Open decisions (summary)

- Plugin naming: one plugin per release (recommended) vs one plugin per group.
- `Main` skills: any person pushes, admin releases — confirm the [CALL].
- Browser text editor in v1 — confirm the [CALL] (the challenge proposed
  read-only).

## Challenge log (2026-10-31)

An adversarial review (separate model, read the spec cold against the
multi-tenant spec, CLAUDE.md and the code) returned ten findings. Disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | Cross-group supply chain through `{skill:…}` cron checks and `follow` | **Accepted** — acceptance per group pinned to a tree hash; no `follow`; skill-script checks cut from v1 |
| 2 | Skillsmith runs another group's unscanned draft code with its own secrets | **Accepted** — no secrets by default, explicit opt-in per name; prompt says the draft is untrusted |
| 3 | Cross-slice scan is an oracle; release-time scan is too late for history | **Accepted** — scan at push, against the pusher's resolvable slices only |
| 4 | Profile attachments leak skill names (profiles are global); attach-adds-secret reopens #362 | **Accepted** — profile attachments cut from v1; no secret-adding checkbox |
| 5 | `Cron.skills` has no coherent semantics | **Accepted** — a cron uses its agent's attachments |
| 6 | Implicit respawn on attach | **Accepted** — mark stale, reload on click; only the agent's own menu respawns |
| 7 | Owner group destroyed | **Accepted** — warning, transfer, accepted releases keep running |
| 8 | Any agent of an editor group may push | **Accepted** — Skillsmith profile only |
| 9 | Commons plugin dirs readable by all public agents | **Accepted as a stated property** of "public is no wall" |
| 10 | Audit, size cap, arg order, binary version | **Accepted** — audit rows, HTTP cap, the `--mcp-config` variadic trap called out, loading measured on 2.1.309 too |
| — | Smaller v1: editors = users, read-only browser | **Refused** — two lists kept (use-without-edit is the common case); browser editor kept as a [CALL] so non-developers can co-write |
