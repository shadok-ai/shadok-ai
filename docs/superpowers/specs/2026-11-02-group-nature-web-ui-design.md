# Group-nature web UI — design

Status: **draft for approval** · 2026-11-02 · follow-up to
`docs/superpowers/specs/2026-10-29-multi-tenant-scoped-isolation-design.md`
(the approved multi-tenant isolation design, which this does not re-decide).

## Why this exists

The multi-tenant **isolation engine** shipped (PR #373, on the `mt-isolated-groups`
branch): server-side ACLs, per-group OS users, sealed private groups,
auto-provision at onboarding, cascade teardown — all built and tested. But the
**web client never exposes the group-nature model**. It never reads `group.nature`,
never calls `POST /groups`, has no way to create a walled group, no membership UI,
and no marker for a personal space. The groups in the rail are still the old
**cosmetic public tab-groups**. So a person using the cockpit cannot see or use
the very concepts the engine enforces — which is how testing surfaced "I don't see
the concept of a personal group" (mt373, 2026-11-02).

This design covers **only the web UI** for the group-nature model, plus the small
server gaps that UI needs. The semantics (what each nature means, who may see/drive
what) are already decided in the isolation design and are not reopened here.

## Intent

Make the three group natures **visible, legible, and operable** from the web
cockpit, with a vocabulary a non-technical operator reads correctly at a glance:

> **tout le monde → quelques-uns → moi** · everyone → a few → me

## The model, as surfaced in the UI

Three levels, named for the person (the internal `Nature` enum is unchanged; the UI
relabels two of them):

| UI label | Internal `nature` | Who sees it | Wall | Created how |
|---|---|---|---|---|
| **Public** | `public` | everyone | none (label only) | user, at "＋ new group" |
| **Private** | `restricted` | only added members | yes (per-group OS user) | user, at "＋ new group" |
| **Personal** | `private` | only the owner | yes (sealed, no invite ever) | **auto**, one per account |

Key relabel, and the reason: the sealed one-person space the engine calls
`private` is surfaced as **Personal** (🔒), and the members-based walled group the
engine calls `restricted` is surfaced as **Private**. This turns a confusing pair
("private vs restricted") into a clean gradation the operator already used
unprompted: Public (all) · Private (a few you add) · Personal (just you). The UI
**never shows the words `restricted`**; the stored `nature` keeps its enum values.

### Personal (🔒) — the personal space

- **One per account, auto-provisioned**, never created by hand. It already is for
  invited members (at invite-redeem). **New:** the bootstrap admin / operator gets
  one too, so a one-person instance still has a Personal space. (The owner sees
  their own Personal group — the "invisible even to an admin" rule only hides
  *other people's* private groups.)
- **Display name is `Personal`**, not the account name. You only ever see your own,
  so a generic label is clearer than your own name shown back to you. The stored
  `name` stays the account name (used by the admin teardown warning "X's personal
  space", `DELETE /users`); only the rail/label display is `Personal`.
- **Marker: a fixed 🔒 icon**, not user-changeable (other groups carry a chosen
  icon). This is the "identify it at a glance" the operator asked for.
- It sits **among the other groups** in the rail (not a separate landing view) —
  the operator was explicit: "un groupe parmi les autres".
- It is **not offered in the create flow** (it always already exists).

### Private (team) — a walled shared space

- Created by a user; **the creator is its first member** (today's
  `createGroupFlow` behaviour). At creation the form **offers to add other users**.
- **Members can be added/removed afterwards** from the group's settings panel.
- Needs a marker distinct from Public and Personal (see Open questions).

### Public — a label in the commons

- Today's cosmetic tab-group: everyone sees it, no wall, a user-chosen icon. The
  create flow still produces these; `Main` (the commons) stays the special public
  home where the lead `general` lives (and is rendered as the "Main" view — see the
  commons-fold fix, commit 77760ae).

## The UI surfaces to build

### 1. Create-group flow

"＋ new group" no longer makes a cosmetic public group on the spot. It opens a small
form:

- **Name** (text).
- **Type**: **Public** / **Private** (two choices; Personal never appears here).
- If **Private** is chosen: an **add-members** control (pick from the instance's
  accounts) — optional, can be left empty and filled later.
- A capability note when Private is picked on a non-capable instance: the honest
  refusal already exists server-side (`capabilityRefusal`) — the UI should disable
  Private (or explain) rather than offer a wall it cannot build.

### 2. Group settings / members panel

Opened from the group in the rail — the same affordance pattern as the existing 🔑
(which already opens a group's secrets). Shows:

- the group **name** (rename) and **type** (Public/Private/Personal, read-only — a
  nature change is not a v1 operation);
- for **Private**: the **member list** with **add / remove**;
- for **Personal**: a sealed state — "only you", no members to add (🔒);
- for **Public**: no membership (it is a label).

This is the "endroit pour voir qui est dans le groupe" the operator asked for.

### 3. Rail markers (nature at a glance)

**[DECIDED] The padlock 🔒 marks a *walled* group — both Personal and Private.**
Public has no padlock. So the visual language is simply: **🔒 = has a wall**
(members-only or you-only), **no lock = open to everyone**.

- **Personal** → 🔒 as its (fixed) icon, name `Personal`.
- **Private** → its user-chosen icon **with a 🔒 badge/overlay** (so a team can
  still carry its own icon while reading as walled). Exact rendering is the
  builder's to mock.
- **Public** → user-chosen icon, no lock, as today.

Personal and Private both show a padlock on purpose; they are told apart by the
**name** (`Personal` vs the team's own name) and by the members panel — not by the
lock. "Everyone → a few → me" is name + membership, "walled or not" is the lock.

## Server gaps this UI needs

Mostly wiring; the engine exists.

1. **Client → `POST /groups`** to create Public/Private (the endpoint +
   `createGroupFlow` already exist and are browser-gated; the client simply never
   calls them).
2. **Membership management by ANY member of the group** (not only an admin, not
   only the creator). Today two things disagree and neither matches the operator's
   intent: `mergeGroupsPut` (`PUT /groups`) refuses any members change unless the
   caller is a role-`admin`, while `membershipVerdict` (src/groups.ts, currently
   **unwired to any route**) encodes "any member may invite, only an admin may
   remove". The operator decided (2026-11-02): **any member of a Private group may
   add AND remove members** — a flat-trust team. So:
   - member-management auth becomes **`canAdministerGroup`** (a member of the group,
     or an admin) — per-group, replacing the blanket `isAdmin` check in
     `mergeGroupsPut` for a members change on a `restricted` group;
   - `membershipVerdict` is updated so **`remove` is no longer admin-only** (it
     becomes member-or-admin, matching `invite`), and it is **wired** into the
     membership route it was written for;
   - a **Personal** (`private`) group stays sealed — no membership change ever, by
     anyone (its `canAdministerGroup` is already `false`).
   This **loosens** the isolation design's earlier "remove = admin only" decision
   and must be reflected in that spec's ACL section and re-reviewed. *(Confirmed
   with the operator — see "Decisions taken after the builder-check".)*

3. **A names-only account roster any signed-in account can read.** The create-Private
   form and the members panel need an account picker, but `GET /users` is admin-only
   and exposes roles/hashes shape. Since any member manages membership, a non-admin
   routinely needs the roster. **Decision:** add a **names-only** roster (just
   account names, no roles, no hashes, no session data) readable by **any signed-in
   account** on a capable instance — the minimum the picker needs. The existing
   admin-only `GET /users` is unchanged for the full record. *(This exposes the set
   of account names to every member; accepted, since membership is theirs to manage.)*
4. **Add initial members at creation** — either extend `createGroupFlow` to accept
   a members list, or create-then-`PUT`-members from the client. (Builder's call;
   one round trip either way.)
5. **Bootstrap-admin Personal provisioning.** The passwordless/password bootstrap
   admin has **no `accounts.json` row** (`currentAccount` returns
   `{name: BOOTSTRAP_ADMIN}`), so neither existing hook fires for it (invite-redeem
   is per named account; the migration loop reads `loadAccounts()`). **Decision:**
   provision the operator's Personal group **in the capable boot reconciler**
   (idempotent, keyed on `owner = BOOTSTRAP_ADMIN`), reusing
   `ensurePrivateGroupProvisioned` with that name, so it is created once and healed
   on recreate like any other. Named admin-role accounts already get theirs via
   invite-redeem — only the literal `BOOTSTRAP_ADMIN` is the special case.
6. **Display relabel in the client** — map `nature` `private`→"Personal" (own) and
   `restricted`→"Private", and show the 🔒 for Personal. Pure client display; the
   stored enum and names are untouched.

## Client gestures under isolation (the cosmetic-group carry)

Today a rail group is a **client-minted cosmetic** thing (numeric `++groupSeq` id,
PUT-synced) supporting three gestures. Under isolation `channel.group` is
SERVER_OWNED and set at spawn from the caller's identity, and a walled group's
lifecycle is a **privileged** provision/teardown — so those gestures must be scoped
per nature, or they silently desync (worse: visually "move" a private agent into
the everyone-visible commons). **Decisions:**

- **Rename** — allowed for **Public** and **Private** (the team's name is cosmetic);
  **Personal** is fixed `Personal` (not renamable).
- **Drag an agent between groups** — **disabled on a capable instance**: the group
  is decided at spawn and `channel.group` is SERVER_OWNED, so a drag could only lie.
  (Mono-tenant, where groups are purely cosmetic and nothing is walled, keeps
  today's drag.)
- **The × "Ungroup (tabs kept)" dissolve** — for a **Public** cosmetic group it
  stays today's "move tabs to the commons". For a **Private/Personal** walled group
  that gesture is **wrong** (it would move walled agents into the commons): the ×
  is replaced by **"Delete group"** → the privileged teardown (`DELETE /groups`,
  which destroys the OS user, HOME and agents), behind the existing confirmation.
  Personal is **not** user-deletable (it is torn down only with its account).

These follow from the isolation design's already-decided rules; they are the main
driver of client scope (one group abstraction with **per-nature capability flags**,
not a fork).

## Goals / non-goals

**Goals**
- Create Public and Private groups from the web UI.
- See and manage a Private group's members (any member of it), from a group panel.
- A visible, sealed, well-named **Personal** space for every account incl. the
  operator.
- A legible nature marker in the rail (Public / Private / Personal).

**Non-goals (deferred, consistent with the isolation design)**
- Telegram surface for any of this (web-first, as decided).
- Changing a group's **nature** after creation (create the right type).
- Disk quotas, per-file guardrails in the shared pot.
- Any break-glass / admin super-view into a Personal space (forbidden by design).

## Anti-goals (a failure even if it "works")

- Showing the word **restricted** anywhere in the **group-nature** UI (the relabel
  is the whole point — the operator thinks Public/Private/Personal). NB: the
  unrelated **peer-invite scope** selector (`#peerScope`, "restricted (own agents)"
  vs "member") legitimately uses "restricted" for a different concept and is **out
  of scope** — the scan-test enforcing this anti-goal is scoped to the group-nature
  surfaces, not a blanket file search.
- A second thing that reads as "Main"/commons (the commons-fold fix must hold).
- Letting a client PUT reassign a channel's group or a group's nature (both are
  SERVER_OWNED / admin-or-owner gated — the UI must not invent a bypass).
- Faking a wall on a non-capable instance (honest refusal, never a fake Private).

## Decisions taken after the builder-check (2026-11-02)

- **Marker:** padlock 🔒 for both Personal and Private; Public has none (see Rail
  markers). *(operator)*
- **Member management:** any member of a Private group may add AND remove members
  (`canAdministerGroup`); this loosens the isolation spec's "remove = admin only".
  *(operator — the one decision that reopens an approved rule)*
- **Roster:** a names-only roster readable by any signed-in account feeds the picker
  (server gap #3). *(builder call)*
- **Gestures:** rename (Public/Private), no agent drag between groups on a capable
  instance, × becomes "Delete group"/teardown for walled groups. *(derived from the
  isolation decisions)*
- **Admin Personal:** provisioned in the capable boot reconciler, keyed on
  `BOOTSTRAP_ADMIN`. *(builder call)*
- **Scan-test scope:** the "never show `restricted`" test covers the group-nature
  surfaces only, not the unrelated `#peerScope`. *(builder call)*

## What's left to the builder

- The exact create-form layout and the members-panel layout (mocks first).
- The exact rendering of the 🔒 on a Private group (badge/overlay on its chosen icon).
- Whether initial members ride on `POST /groups` or a follow-up `PUT`.
- Client display plumbing for the relabel + the 🔒, reusing the commons-fold and
  the 🔑-panel patterns already in `public/index.html`.
- Tests: the client scan-tests pattern (`index.html` has no build step) for the
  relabel, the marker, and the "never show `restricted`" anti-goal; server tests
  for the member-management authority change.
