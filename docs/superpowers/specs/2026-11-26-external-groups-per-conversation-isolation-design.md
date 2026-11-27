# External groups: the conversation is the isolation unit

Design, drafted 2026-11-26 from a cockpit conversation with the operator, and
checked against the code as it was written (`5542f3f`). Approved 2026-11-26.
Status: **steps 1 and 2 implemented** — the box on the API (plan
[`plans/2026-11-26-guest-conversation-box.md`](../plans/2026-11-26-guest-conversation-box.md))
and the admission ceiling (plan
[`plans/2026-11-27-guest-admission-ceiling.md`](../plans/2026-11-27-guest-admission-ceiling.md));
steps 3 to 5 not built. Points the operator
settled in that conversation are marked **[OPERATOR]**; a call made here that a
builder could not settle alone is **[CALL]**; points deliberately left open are
**[OPEN]**.

## Intent

Open DMs put a **stranger** at the other end of an agent — Telegram first
([design](2026-11-11-telegram-open-dm-design.md)), then WhatsApp
([design](2026-11-23-whatsapp-open-dm-design.md)), where anyone who has the
number gets an agent of their own. Both doors land every guest in **one**
restricted group, which is shadok's isolation unit: one Unix user, one home,
one secret slice, shared by every stranger who ever wrote in.

A working directory per person (`tg-<id>` / `wa-<id>`, mode 0700) was added to
stop one guest's notes being loaded by the next one's agent. It is explicitly
**not a wall**, and the code says so where the decision lives
(`guestWorkDirName`, `src/tg-guests.ts`):

> Same Unix user, same home, so an agent that goes looking can still read its
> neighbour's folder. It stops the ACCIDENT, not a determined agent. **A real
> wall would be one group per person, hence one provisioned Unix user per
> stranger who writes to the bot.**

This design is that wall. It is the first place where shadok's isolation unit
moves from the **group** to the **conversation** — and the one place where that
move is cheap, because guests are not colleagues: there is no collaboration
between them to preserve, and the anti-goal is precisely that they cannot reach
each other.

It also gives a guest something it cannot have today: **a secret slice of its
own**, so an agent can keep a credential the person handed it without that
credential being readable by the next stranger.

Why here and not in general: a per-agent wall between *colleagues* costs a
`useradd` on every spawn, breaks file hand-off inside a team, and collides with
worktree recovery (a reclaimed checkout owned by a torn-down uid). A guest
agent spawns **with no worktree**, never hands a file to another guest, and its
conversation is a long-lived, naturally-keyed object (the phone number / LID).
All three costs disappear; one new cost appears, and it is the subject of
decision 3.

## The whole model in one page

**One new nature.** `Group.nature` gains `external`, beside `private`,
`restricted` and `public`. Internally it is a restricted group — a roster of
people, member-only visibility, no admin override — with one difference:

> **In an external group, every question a restricted group answers with
> "the group" is answered with "the conversation".**

The Unix user, the HOME, the secret slice, the media directory, and what an
agent may see over the API: all per conversation.

**The wall is between guests, not between a guest and the operators.** A member
of an external group sees and drives **every** conversation in it, exactly as
today — that is the product: the operator reads those conversations in the
cockpit and takes the hand. What changes is that **no guest can reach another**.

**What a guest's agent can reach, exhaustively:** its own session and channel,
its own HOME and conversation directory, its own vault slice, its own media.
**What it cannot:** another conversation — anything of it —, the group's roster,
the group's other agents, the group's ledger, Main's secrets, and the profile's
secrets (an external door's profile carries none, by rule).

**What this design does NOT seal, and must never be read as sealing:** the
Claude credential. See "Stated limits".

## Decisions

### 1. [DECIDED] A nature chosen at creation, never a conversion

`external` is picked when the group is created and cannot be toggled on an
existing group. A conversion would have to re-home every live conversation
under a new Unix user mid-flight, and a guest whose agent already resumed keeps
its old working directory by construction (the registry decides a resume's cwd
— invariant 1), so a converted group would be a wall with holes in it, which is
worse than no wall (invariant 47).

Existing doors keep pointing at restricted groups and keep today's behaviour
until an admin creates an external group and re-points the door. **Nothing
migrates by itself**, and the old conversations stay where they are.

**Mono-tenant refuses.** An external group cannot exist without the privileged
deployment, and the refusal is the existing one (`capabilityRefusal` /
`migratedIsolationRefusal`), with the honest reason — never a cosmetic label.
This matches the WhatsApp door, which already declines to serve a mono-tenant
instance.

The UI label is **"External"**, and the panel must say in one line what it is:
*each conversation is sealed from the others; members see them all.*

### 2. [DECIDED] One Unix user per conversation, and a registry

`osUserFor` currently maps a group to `sk-<groupId>`. For an external group the
user is derived from the **pair** (group, conversation id), because a username
is capped at 32 characters (`sk-` + 28) and neither a UUID group id nor a phone
number fits beside the other. So the name is a **hash**, and a hash means the
mapping is no longer reversible — which forbids deriving it and hoping:

- a root-owned **registry** (`~/.shadok-ai/external-users.json`) binds
  `user → { group, conversation, createdAt }`;
- provisioning **refuses** when the name exists bound to a *different*
  conversation, rather than letting two strangers share a Unix account. A
  collision is a silent cross-guest leak, so it fails closed and loudly;
- the same conversation always derives the same name, so a returning guest
  comes back to its own user;
- there is **never a fallback** to the group's user or to the commons. The
  "guest-group" failure rule already exists for exactly this shape: a
  resolution that does not produce the intended isolation refuses to answer at
  all.

Provisioning is the existing path (`provisionPlan` / `provisionGroupUser`):
`useradd --create-home --home-dir`, then `chmod 700` on the HOME — both fatal
on failure, because a HOME that is not private is a broken wall. It runs when
the door **admits** the conversation (first message), not at the agent's spawn,
so a spawn never waits on a privileged command.

### 3. [DECIDED] A cap and a rate — and they come before the wall

Both doors are deliberately uncapped today: "no cap on the number of guests, no
queue, no per-person block". That is tenable while a guest costs a
**directory**. The day a guest costs a `useradd`, an uncapped door is a
**provisioning DoS reachable by anyone who knows the number** — and it writes
to `/etc/passwd`, not to a scratch dir.

So an external door gets, as a pure verdict (`externalAdmitVerdict`):

- a cap on **live conversations** per external group;
- a cap on **new conversations per hour**;
- a refusal that is a polite guest notice through the one guest-wording door
  (`guestNotice`) — and **never** a fallback to a shared user.

This is the first thing to build, before any of the rest: it is the cost the
wall creates.

*Status: **implemented**, and deliberately wider than this decision asked: the
ceiling applies to EVERY guest door from now on, not only to an external one —
settled with the operator so the guard is live and verifiable today instead of
waiting dormant for step 3, and because a stranger already costs a `claude`
process and a pane. It is counted per GROUP rather than per door (two doors onto
one group share the cost of a conversation), the live count is read from the
channel registry rather than remembered, and a RETURNING conversation is exempt.
Invariant 83.*

### 4. [DECIDED] The box on the API — the keystone, and a hole that exists today

An agent's membership of a group is **group identity**: `viewerInGroup` returns
true when `viewer.agentGroup === g.id`, and `canSeeSession` delegates to
`canSeeGroup`. Every guest of a door is in the same group, so **one guest's
agent is entitled to a sibling guest's session** by the group rule. The
narrowing that exists (`restrictedBoxOf`, which boxes a restricted peer to what
it spawned) has no guest equivalent — there is no guest notion on the agent
principal at all.

A guest agent carries its session key in its environment, so this needs no
filesystem access: it is reachable from a prompt, and a prompt is what a
stranger controls. **The box is therefore more urgent than the Unix user**, and
it is independent of it — it does not need multi-tenant, a provisioned account
or a migration.

An agent of an external group is boxed to its own conversation on every route
that today answers "same group, so yes": the session list, the channel list,
resume and recover, diff, media, the secret routes, and spawning (a guest agent
cannot spawn at all, which is the narrowest and the right default).

*Status: **confirmed end to end** while building step 1 — against an unpatched
build, a guest's agent listed every channel of the instance, saw the connected
account shared with the door's group, and obtained its provider token from
`POST /github/token`. Fixed by step 1; recorded in the shared ledger as `ecce`.*

### 5. [DECIDED] An external door's profile carries no secrets

Every guest agent on a door runs the same profile, so a secret on that profile
is a secret handed to every stranger, and one injected guest's blast radius
becomes "whatever that profile can do". Enabling an external door on a profile
with a non-empty secret list is **refused**, in the same place the other door
refusals live (`guestEnableRefusal` and its external twin), with the reason
stated.

The Factory's rule is the same shape and already right: a release's secrets are
resolved from the agent's **own** isolation group, never bare from Main, "or an
isolated group's agent would receive Main's values". An external agent's
resolution chain is therefore **its own slice and nothing else** — no
shared-in, no commons, no Main.

### 6. [OPERATOR] A guest's own secret slice

A guest's agent can store a credential of its own — the point being that the
person should not have to hand it over again on their next message.

- **Where.** In the central vault, as its own slice. `Vault` is already keyed by
  owner (`{ [groupId]: GroupVault }`); an external conversation becomes an
  owner id of its own. The vault stays root-owned and outside every agent's
  reach — a value is never stored where an agent could read it in bulk, and
  never returned by a read route.
- **Who writes.** The guest's own agent, through the existing machine boundary
  (`PUT /secrets` and the `shadok-secrets` skill, `--stdin`, no `get`), boxed by
  decision 4 to its own slice. Reserved names (`MT_CLAUDE_OAUTH_TOKEN`) are
  refused as they are everywhere.
- **Who reads.** Only that conversation's own agents, as injected env at spawn.
  No other guest, ever.
- **[OPERATOR] Who can audit.** The group's **members see the NAMES**, never the
  values — the vault's existing rule — and can rotate and delete. The sealed
  alternative was rejected on purpose: a slice nobody can see or empty is the
  `lastMemberRefusal` trap applied to a stranger's data, and the operator is
  accountable for what their instance holds.
- **[OPERATOR] How long it lives.** The slice **dies with the agent**: deleting
  a guest's agent wipes it. A returning guest supplies the credential again.
  Minimum retention, no orphaned stranger credentials on disk.
- **Quotas.** A stranger can now write to the operator's disk through a route,
  which was never true before: a cap on the number of entries per conversation
  and on value size, enforced server-side, with the refusal surfaced to the
  agent rather than swallowed.
- **The guest is told.** What they hand over is stored on this instance and goes
  away with the conversation — through `guestNotice`, the single guest-wording
  door, not improvised per bridge.

### 7. [CALL] The user and the directory outlive the agent; only the slice dies

The operator asked for "teardown when the agent is deleted". Taken literally
that breaks something already decided: `guestWorkDirName` keeps a person's
folder **across** their agent's deletion on purpose — deleting an agent ends a
session and "is not meant to erase someone". A `userdel` under a surviving
folder would leave files owned by a dead uid and hand them to whoever gets that
uid next, which is the one trap that makes per-agent isolation dangerous.

So the pieces split by lifetime:

- the **Unix user and the HOME** belong to the **conversation** and survive the
  agent's deletion (the person comes back to their own folder, under their own
  user);
- the **vault slice** belongs to the **agent** and dies with it, per decision 6;
- tearing the user down is its **own explicit gesture** — deleting the
  *conversation* — which removes the user, the HOME and the registry row, in
  that order, and never recycles the name for a different conversation.

**[OPEN]** A retention sweep for conversations nobody has touched in a long
time: worth having, and the age is the operator's call, not a builder's.

### 8. [DECIDED] Media per conversation

Media is scoped per group today (`src/media-scope.ts`,
`/var/lib/shadok-ai/media/<key>/g-<group>`), and an image a stranger sends is
exactly the kind of thing another stranger must not read. The media directory
follows the same move as everything else: per conversation, owned by that
conversation's user.

### 9. [DECIDED] No ledger for an external agent

The shared ledger is scoped by group (`ledgerGroupsFor`). An external agent is
in **no** ledger scope: it neither receives the group's rows nor writes any. A
ledger push reaching someone not entitled to it is already an anti-goal of the
multi-tenant design, and here the "someone" is a stranger.

## Stated limits (read these as part of the design, not as caveats)

- **The Claude credential is not sealed, and this design does not seal it.**
  Every dropped agent must reach the shared, writable Claude credential, and
  carries the instance's long-lived token in its environment. So a guest agent
  holds the instance's Claude authority: it bounds **files and secrets**, not
  Claude quota and not Claude identity. The mitigation — a per-group token or a
  small auth broker — is the multi-tenant design's existing open decision and is
  **not** in scope here. An external group must not be presented to an operator
  as more than it is.
- **No defence against host root** or a determined insider with a host shell.
- **No container per guest.** The blast radius remains the one the standard
  deployment gives (the official image's container).
- **No per-conversation disk quota.** Infrastructure's job, as today.
- **The operator sees everything.** By design — but it means an external group
  is not a privacy promise made to the guest beyond "the other guests cannot
  read you".

## Goals / non-goals / anti-goals

**Goals**
- Real, OS-level confidentiality **between the guests of one door**: files,
  working directory, media, secrets.
- A secret slice a guest's agent can write and only that conversation can read.
- Operators keep full reach over every conversation in the group.
- Additive: existing doors and existing conversations behave exactly as today
  until an admin opts in.
- The provisioning cost of a stranger is **capped**.

**Non-goals**
- Converting an existing restricted group into an external one.
- Sealing the Claude credential or the Claude quota.
- Per-agent isolation between colleagues in a non-external group (the general
  case: a user per *profile* is the cheaper shape if that is ever wanted).
- Guest-to-guest collaboration of any kind.

**Anti-goals (a design that does any of these has failed, even if it works)**
- A wall posed where the deployment cannot pose one — a cosmetic "external"
  label (invariant 47, and the multi-tenant rule "never simulate a wall we
  cannot pose").
- A filesystem wall under a group-wide API: one guest agent still seeing or
  driving another's session.
- Two conversations sharing a Unix user through a hash collision or a fallback.
- An uncapped door that lets a stranger make the instance create Unix accounts.
- A guest's stored secret readable by the next guest, or by the profile.
- A stranger's secret slice that no member of the group can audit or delete.
- Tearing down a Unix user under files that outlive it (uid recycling).

## Constraints

- All enforcement is **server-side**; the bridge and the client are never
  trusted. A socket that proves no secret and claims `guest: true` gains
  nothing — the existing rule.
- The privileged deployment only; mono-tenant refuses with the honest reason.
- No `useradd` on the spawn path: provisioning happens when the door admits the
  conversation.
- Every new rule arrives as a **pure, unit-tested verdict** beside the ones it
  extends (`src/tg-guests.ts`, `src/osusers.ts`, `src/secrets.ts`,
  `src/groups.ts`), so the whole wall is testable without a server and without a
  phone.
- Backward compatible: with no external group defined, nothing anywhere changes.

## Seams this touches

| Where | What changes |
|---|---|
| `src/groups.ts` | `Nature` gains `external`; `canSeeGroup` / `canAdministerGroup` keep the restricted rules for **people**; the agent branch of `viewerInGroup` narrows to the conversation. |
| `src/osusers.ts` | `osUserFor` / `provisionPlan` / `resolveSpawnIsolation` learn the conversation; the user registry and its collision refusal. |
| `src/secrets.ts` | The vault's owner id becomes the isolation unit; an external agent's resolution chain is its own slice **only**; per-slice quotas; `visibleSecrets` exposes an external slice's names to the group's members. |
| `src/tg-guests.ts` / `src/wa-guests.ts` | The admission verdict (cap + rate), the external door's profile refusal, the new guest notices. |
| `src/agent-principal.ts` + `src/server.ts` | The per-conversation box, applied route by route the way `restrictedBoxOf` is. |
| `src/media-scope.ts` | Per-conversation media directory and ownership. |
| `public/index.html` | The "External" nature in the group panel and the create form, and one line saying what it means. |
| `docs/` | `invariants.md` + the `CLAUDE.md` index for the new rules (the collision refusal and the lifetime split are the two worth locking), `architecture.md` for the reshaped isolation unit, `README.md` for the operator-visible nature. |

## Shape of the work

Each step is independently shippable and leaves the instance honest:

1. **The box** (decision 4). Closes a hole that exists today, needs nothing
   else, and is the step a reviewer should see first.
2. **The cap and the rate** (decision 3). The cost of the wall, before the wall.
3. **The nature + provisioning + the registry** (decisions 1, 2) — with the
   directory and media moves (8) and the ledger exclusion (9).
4. **The guest's secret slice** (decision 6), with its quotas and notices.
5. **The lifetime gestures** (decision 7): conversation deletion, and the
   retention sweep once the operator has set an age.

## Open decisions

- **[OPEN]** The retention age for an untouched conversation (decision 7).
- ~~**[OPEN]** The exact caps and rate (decision 3)~~ — **[OPERATOR]**,
  settled 2026-11-27: **200 live conversations and 30 new ones per hour** by
  default, and **yes**, an operator may raise or lower it per door (`limits` on
  the guest setup; the panel has no field for it yet and never resets what was
  set). A malformed value reads as unset, never as a shut door.
- **[OPEN]** Whether a member may **write into** a guest's slice (hand a
  credential to one conversation) or only rotate and delete what the agent put
  there.
- **[OPEN]** The Claude credential, inherited from the multi-tenant design: one
  shared token, or a per-group token with an auth broker. Out of scope here, but
  it is what bounds how much an external group can honestly claim.
