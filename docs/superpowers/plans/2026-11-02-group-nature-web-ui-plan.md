# Group-nature Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the multi-tenant group-nature model in the web cockpit — create Public/Private groups, manage a Private group's members, and give every account a sealed Personal space — so the isolation engine that already ships (PR #373) is usable from the UI.

**Architecture:** The isolation engine (ACLs, OS users, routes) exists server-side; this is mostly a **client** layer plus three small server changes (member-management authority, a names-only roster, bootstrap-admin Personal provisioning). The client relabels the internal `Nature` enum for the operator (`private`→"Personal", `restricted`→"Private"), never showing the word "restricted", and marks walled groups with a padlock 🔒. One group abstraction with **per-nature capability flags** (not a fork).

**Tech Stack:** TypeScript/ESM/Node 20 server; framework-less hand-written `public/index.html` client (no build step). Tests: `node:test` + `node:assert/strict` via tsx; pure cores unit-tested; `server.ts`/`index.html` locked by **source-scan** tests (the `test/ws-url.test.ts` / `test/commons-group-fold.test.ts` pattern).

**Spec:** `docs/superpowers/specs/2026-11-02-group-nature-web-ui-design.md` (built on `docs/superpowers/specs/2026-10-29-multi-tenant-scoped-isolation-design.md`).

## Global Constraints

- **Everything written into the repo is English** (code, comments, identifiers, tests, commits, docs). Chat replies follow the user's language; not covered here.
- **The UI never shows the word `restricted`** on a group-nature surface. Internal `Nature` enum values (`private`/`restricted`/`public`) are unchanged in storage and server code; only the *display* relabels (`private`→"Personal", `restricted`→"Private"). The unrelated `#peerScope` peer-invite selector keeps its own "restricted" string and is out of scope.
- **Three UI levels:** Public (everyone, no wall) · Private (members you add, walled = internal `restricted`) · Personal (just you, 🔒, auto, sealed = internal `private`).
- **Padlock 🔒 marks a walled group** (Personal and Private); Public has none.
- **Personal:** one per account, auto-provisioned, display name `Personal` (stored name stays the account name), fixed 🔒 icon, never created or deleted by hand (torn down only with its account), never renamable.
- **`channel.group` is SERVER_OWNED** — the client must never reassign it (no agent drag between groups on a capable instance).
- **Honest refusal, never a fake wall:** on a non-capable (mono-tenant) instance, Private creation is disabled/refused via the existing `capabilityRefusal`; the deployment `mode` is already on `/version`/`versionState`.
- **Commit trailer** (every commit):
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` then `Claude-Session: https://claude.ai/code/session_01LR6XaKf4uwsopJC9u3rFEm`.
- Branch: `mt-group-ui` (stacked on `mt-isolated-groups` / PR #373). Do not merge; PR #373 stays on hold.

## Review Focus

- **A member removing another member (incl. the creator).** The loosened rule (any member of a Private group may remove any member) must actually be honoured AND bounded: a Personal (`private`) group stays sealed (no removal ever), and a non-member/non-admin is refused. Pinned in Task 1.
- **The roster leak surface.** The names-only roster must expose *only* names — never roles, hashes, session data — and must still require a signed-in account. Pinned in Task 2.
- **A private agent "moved" into the commons.** Disabling agent-drag and repurposing × must hold: no gesture may set/clear `channel.group` on a capable instance, or a walled agent appears in the everyone-visible Main. Pinned in Task 7.
- **"Private" disabled on a non-capable instance.** The create form must not offer a wall the host cannot build; a mono-tenant instance shows Public only. Pinned in Task 5.
- **The relabel never leaks "restricted" and never double-shows a walled group's own name.** The display map must be total over the three natures and the commons-fold must hold. Pinned in Task 4.

---

## Task 1: Member-management authority (server)

**Files:**
- Modify: `src/groups.ts` (`membershipVerdict`)
- Modify: `src/server.ts` (a dedicated membership route that wires `membershipVerdict`)
- Test: `test/groups.test.ts` (pure), `test/server-acl.test.ts` (source-scan wiring)

**Interfaces:**
- Consumes: `membershipVerdict(actor: Viewer|null, g: Group, action: "invite"|"leave"|"remove", target: string)`, `canSeeGroup`, `memberOf` (src/groups.ts).
- Produces: route `POST /groups/members` body `{ group: string; add?: string; remove?: string }` → 200 `{ok:true, group}` / 403 / 400; authority decided by `membershipVerdict`.

- [ ] **Step 1: Write failing tests** in `test/groups.test.ts`:
  - `membershipVerdict({name:"ada",role:"member"}, restrictedWithAda, "remove", "leo")` → `{ok:true}` (a member may now remove another).
  - `membershipVerdict({name:"bob",role:"member"}, restrictedWithoutBob, "remove", "ada")` → `{ok:false}` (non-member refused).
  - `membershipVerdict(anyViewer, privateGroup, "remove"|"invite", t)` → `{ok:false}` (a `private`/Personal group is never membership-mutable).
  - `membershipVerdict({name:"ada",role:"member"}, restrictedWithAda, "invite", "leo")` → `{ok:true}` (unchanged).
- [ ] **Step 2: Run** `npx tsx --test test/groups.test.ts` → FAIL (remove still admin-only).
- [ ] **Step 3: Change `membershipVerdict`'s `remove` case** so it mirrors `invite`: allowed when `memberOf(g, actor.name) || actor.role === "admin"` (keep the `g.nature !== "restricted"` guard above, so `private`/`public` stay refused). Keep `leave` (self only) and `invite` as they are.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Add `POST /groups/members`** in `src/server.ts`: browser-only (`requestFromBrowser`) + instance-key gate (`channelWriteAllowed`), resolve `viewerFor(currentAccount(req))`, load the group by `body.group`, refuse with 404 if it does not resolve or `!canSeeGroup`, then apply `membershipVerdict` for the `add` (`invite`) and/or `remove` action; on `ok`, update the group's `members` and `saveGroups`; return the updated group. Values never fabricated; a dangling group id is refused (fail-closed, like the ACL leak gates).
- [ ] **Step 6: Add source-scan assertions** in `test/server-acl.test.ts`: the `POST /groups/members` handler exists, is `requestFromBrowser`-gated, and routes authority through `membershipVerdict` (not a bare `isAdmin`).
- [ ] **Step 7: Run** `npm test`; **Step 8: Commit.**

## Task 2: Names-only account roster (server)

**Files:**
- Modify: `src/server.ts` (new `GET /accounts`)
- Test: `test/server-acl.test.ts` (source-scan)

**Interfaces:**
- Consumes: `loadAccounts()` (src/accounts.ts), `currentAccount(req)`.
- Produces: `GET /accounts` → `string[]` of account names (plus `BOOTSTRAP_ADMIN` when `GUI_PASSWORD` is set), for any signed-in account; **names only**.

- [ ] **Step 1: Write failing source-scan test** in `test/server-acl.test.ts`: a `GET /accounts` handler exists; within its body it references `loadAccounts` and returns names; it must NOT send `hash`, `role`, `sessionsAfter`, or any field other than the name (assert the handler slice contains none of `hash`/`role`/`sessionsAfter`).
- [ ] **Step 2: Run** → FAIL (no route).
- [ ] **Step 3: Implement `GET /accounts`**: require a signed-in caller (`currentAccount(req)`); respond `res.json(loadAccounts().map(a => a.name))`, prepending `BOOTSTRAP_ADMIN` when `GUI_PASSWORD` is set and not already present. Nothing but names.
- [ ] **Step 4: Run** test → PASS; **Step 5: Commit.**

## Task 3: Bootstrap-admin Personal provisioning (server)

**Files:**
- Modify: `src/server.ts` (`ensureGroupsProvisioned` boot reconciler, or a sibling called in the same boot path)
- Test: `test/server-acl.test.ts` (source-scan), `test/groups.test.ts` if a pure helper is added

**Interfaces:**
- Consumes: `ensurePrivateGroupProvisioned(accountName)`, `BOOTSTRAP_ADMIN`, `DEPLOYMENT_MODE`.
- Produces: on a capable boot, a `private` group `owner = BOOTSTRAP_ADMIN` exists (idempotent).

- [ ] **Step 1: Write failing source-scan test**: the capable-boot provisioning path calls `ensurePrivateGroupProvisioned(BOOTSTRAP_ADMIN)` (so the operator gets a Personal group even with no `accounts.json` row).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: In `ensureGroupsProvisioned`** (runs every capable boot, mode-gated), after the existing reconcile, call `await ensurePrivateGroupProvisioned(BOOTSTRAP_ADMIN)`. Idempotent by `privateGroupFor` (reuses an existing one). No-op in mono-tenant.
- [ ] **Step 4: Run** `npm test` → PASS; **Step 5: Commit.**

## Task 4: Client nature plumbing + relabel + 🔒 marker

**Files:**
- Modify: `public/index.html` (`createGroup`, `syncChannels` group-ingest, boot restore, `renderRail`/`railItem`, the group-head rendering)
- Test: `test/group-nature-ui.test.ts` (new, source-scan)

**Interfaces:**
- Consumes: `GET /groups` rows now read for `nature` and `owner`; existing `foldCommons`, `COMMONS_GROUP_ID`.
- Produces: each client group object carries `nature`; a pure-ish display helper decides the shown label and whether a 🔒 shows.

- [ ] **Step 1: Write failing source-scan tests** in `test/group-nature-ui.test.ts`:
  - `index.html` defines a display map such that `nature==="private"`→`"Personal"`, `nature==="restricted"`→`"Private"`, `nature==="public"`→the group's own name; and the string `"restricted"` never appears as a **shown label** (assert no user-facing `"restricted"` literal in the group-nature rendering block).
  - a walled group (`private` or `restricted`) renders a 🔒; a `public` group does not.
  - `createGroup` threads a `nature` onto the group object (assert `opts.nature` / `_group.nature` is read).
- [ ] **Step 2: Run** `npx tsx --test test/group-nature-ui.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Thread `nature` (and `owner`) from `GET /groups` rows into `createGroup(opts)`'s group object and into the `syncChannels`/boot-restore ingest. Add a display helper (e.g. `groupLabel(g)` / `isWalled(g)`): Personal shows `Personal` + 🔒 (and is not renamable), Private shows its name + 🔒, Public shows its name + its chosen icon. Render the 🔒 in the group head and rail item. Keep the commons-fold: the commons `main` group is still folded into the "Main" view (never a rail group).
- [ ] **Step 4: Run** test → PASS.
- [ ] **Step 5: Headless check** (borrow Playwright per CLAUDE.md, free port, seeded groups of each nature): the rail shows Public (icon), Private (🔒 + name), Personal (🔒 "Personal"); no "restricted" text; capture console (no errors). Save the screenshot and read it back.
- [ ] **Step 6: Commit.**

## Task 5: Create-group form (name + Public/Private + members)

**Files:**
- Modify: `public/index.html` (the "＋ new group" handler → a small overlay form; calls `POST /groups`)
- Test: `test/group-nature-ui.test.ts` (source-scan)

**Interfaces:**
- Consumes: `POST /groups` (`createGroupFlow`: body `{name, nature}` → `{ok, group}`); `GET /accounts` (Task 2) for the member picker; `GET /version` `mode` for capability.
- Produces: a created group added to the rail from the response; for Private, initial members applied (via `POST /groups/members`, Task 1, after create).

- [ ] **Step 1: Write failing source-scan tests**: the create flow (a) offers a **type** choice whose options are exactly **Public** and **Private** (never "Personal", never "restricted"); (b) calls `POST /groups` with a `nature` of `"public"` or `"restricted"` (the internal value for "Private"); (c) when `mode !== "multi-tenant"`, the **Private** option is disabled/absent (capability gate); (d) a Private choice reveals an account picker sourced from `GET /accounts`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the overlay form (reuse the existing overlay/popin pattern, e.g. `#setupOverlay` conventions): Name + Type (Public/Private), Private→member picker (multi-select of `GET /accounts` names, optional). On submit: `POST /groups {name, nature}` (`"Private"`→`"restricted"`); on success add the returned group to the rail; then for each chosen member `POST /groups/members {group, add}`. Private disabled when not capable. Replaces the old instant client-minted cosmetic create for this entry point.
- [ ] **Step 4: Run** test → PASS.
- [ ] **Step 5: Headless check**: create a Public and a Private group end-to-end against a seeded capable instance; confirm the rail updates and the server persists the right `nature`. Screenshot + read back.
- [ ] **Step 6: Commit.**

## Task 6: Group members / settings panel

**Files:**
- Modify: `public/index.html` (a per-group settings panel opened from the group head, sibling of the 🔑 secrets entry)
- Test: `test/group-nature-ui.test.ts` (source-scan)

**Interfaces:**
- Consumes: `GET /groups` (the group's `members`/`nature`/`owner`), `GET /accounts`, `POST /groups/members` (add/remove), rename via existing `PUT /groups` cosmetic path.
- Produces: a panel listing the group's name, type, and (Private) members with add/remove.

- [ ] **Step 1: Write failing source-scan tests**: an entry on the group head opens a settings panel (pattern of `openSecretsPanel`); the panel shows the member list + add/remove **only** for a `restricted` (Private) group; for `private` (Personal) it shows a sealed "only you" state with no add control; for `public` it shows no membership.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `openGroupPanel(groupId)` (mirror `openSecretsPanel`): header = name (editable for Public/Private, fixed for Personal) + type label; body = for Private, the member list with remove buttons and an add control (from `GET /accounts`), wired to `POST /groups/members`; for Personal, 🔒 "Only you — this space is sealed"; for Public, "Anyone can see this — it is a label". Add a group-head affordance to open it.
- [ ] **Step 4: Run** test → PASS.
- [ ] **Step 5: Headless check**: open the panel on a Private group, add and remove a member, confirm persistence; open it on Personal (sealed) and Public. Screenshot + read back.
- [ ] **Step 6: Commit.**

## Task 7: Per-nature gesture scoping

**Files:**
- Modify: `public/index.html` (`dissolveGroup`/the × handler, the drag-between-groups handlers, rename)
- Test: `test/group-nature-ui.test.ts` (source-scan)

**Interfaces:**
- Consumes: `DELETE /groups` (teardown, exists), the capability `mode`, `isWalled`/`nature` from Task 4.
- Produces: gestures scoped by nature + capability.

- [ ] **Step 1: Write failing source-scan tests**:
  - on a **capable** instance, the agent drag-between-groups path is disabled (a drop does not emit a group reassignment / does not persist `group`);
  - a **walled** group's head control is **"Delete group"** → `DELETE /groups` (teardown), NOT the cosmetic "ungroup tabs to Main"; a **Public** group keeps the cosmetic dissolve;
  - **Personal** exposes neither delete nor rename.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Guard the drag-move handlers so they no-op for a group reassignment when `mode === "multi-tenant"` (mono-tenant keeps today's cosmetic drag). Branch the × control: Public → `dissolveGroup` (today's behaviour); Private/Personal → a "Delete group" action calling `DELETE /groups` behind the existing confirmation, except Personal which exposes no delete. Rename allowed for Public/Private, suppressed for Personal.
- [ ] **Step 4: Run** test → PASS.
- [ ] **Step 5: Headless check**: on a capable instance confirm an agent cannot be dragged between groups; delete a Private group (teardown) via the panel/×; confirm Personal offers neither. Screenshot + read back.
- [ ] **Step 6: Commit.**

---

## Notes for the executor

- Tasks 1–3 (server) are independent of each other; Tasks 4–7 (client) are sequential (same `public/index.html`) and depend on Task 4's nature plumbing. Task 5 depends on Tasks 1 and 2 (create + roster + initial members); Task 6 depends on Tasks 1, 2, 4; Task 7 depends on Task 4.
- `index.html` has no build step: lock each client invariant with a source-scan test (the `test/commons-group-fold.test.ts` / `test/ws-url.test.ts` pattern), and verify the real rendering in a headless browser (CLAUDE.md "Running YOUR build" — a **free port**).
- **Testing hazard — do NOT trigger the privileged migration on the shared host.** For every headless check, launch the local build with `SHADOK_GUI_PASSWORD='' SHADOK_HOST=127.0.0.1` so it stays **mono-tenant** and runs no `useradd`/`chown` (a multi-tenant boot on the host chowns the worktree and mints a `main` user — it happened once; clean up with `chown -R root:root <worktree>` + `userdel -r main` if it recurs). The capable-only paths are verified WITHOUT a real wall: **display/panel/gesture** checks seed per-nature group rows (a `private` group with `owner`/`members:["admin"]`, a `restricted` group) into the launch dir's `channels/<enc>-groups.json` and read them back — the client renders them the same regardless of `mode`. The **create-Private / delete-Private** server behaviour (the actual `useradd`/`userdel`) is covered by the existing `createGroupFlow`/`teardownGroupUser` flow tests and, if an end-to-end capable run is wanted, only inside an **isolated container** (vps1 docker, see memory `vps1-test-container-own-build`), never on the shared host.
- The isolation design's ACL section must note the loosened removal rule (Task 1); update `docs/superpowers/specs/2026-10-29-multi-tenant-scoped-isolation-design.md` and `CLAUDE.md` if an invariant shifts.
- README: add the Public/Private/Personal UI to the multi-tenant section (docs ship with the change).
