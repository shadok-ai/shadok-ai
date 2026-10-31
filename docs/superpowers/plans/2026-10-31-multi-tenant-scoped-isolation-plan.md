# Multi-tenant cockpit: isolated groups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-tenant cockpit into a multi-tenant one where a **group** is the unit of both isolation (private/restricted groups get their own OS user + HOME + secret slice) and visibility (Slack-like: you see your own groups + the public commons), with automatic, additive migration of an existing instance and no containers.

**Architecture:** One new pure core (`src/groups.ts`) carries the group model and the whole ACL as testable functions (mirroring `src/kinship.ts`). The server becomes a **privileged orchestrator** that derives each caller's identity (`currentAccount`), filters every channel/secret/ledger surface through the ACL, and **drops to the target group's OS user** when it spawns an agent. A deterministic boot-time **capability probe** picks the deployment mode (multi-tenant only when privileged **and** accounts-enabled); everything degrades honestly to today's behaviour otherwise, and a non-capable install is never offered a wall it cannot pose. Migration is an idempotent, volume-marked boot step.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import extensions), Node 20, `node:test` + `node:assert/strict` run via `tsx`, Express HTTP + `ws` WebSocket, node-pty / tmux transports, Linux OS users (`useradd`/`setpriv`).

**Spec:** `docs/superpowers/specs/2026-10-29-multi-tenant-scoped-isolation-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

Every task's requirements implicitly include this section.

- **No containers.** Toolchain (node, git, `claude`, tmux) is installed once for the machine; the native `claude` binary is never duplicated per HOME.
- **The server runs privileged**; it drops to the target group's OS user per spawn (the **commons** user for a public-group agent). **No agent ever runs as root.**
- **Capable = privileged AND accounts-enabled** (`SHADOK_GUI_PASSWORD` set). Anything less stays **mono-tenant**, byte-for-byte as today, and **refuses isolation affordances with a clear reason — never a fake wall.**
- **All enforcement is server-side.** The client is never trusted; browser filtering is cosmetic. An agent's group is **derived from its `SHADOK_SESSION_KEY`**, never read from anything the client claims.
- **Secret VALUES are never returned to any client.** `GET /secrets` is names-only and stays so.
- **Private is sealed, no break-glass** — a private group is invisible and non-drivable even to an admin, forever.
- **Backward compatible:** a single-group instance behaves exactly as today; a non-privileged install stays mono-tenant.
- **Everything written into the repo is English** — identifiers, comments, test names, log and error strings.
- **Pure logic lives in its own module** (testable like `kinship.ts`/`ledger-core.mjs`); impure glue stays in `server.ts`. `.js` extensions on relative imports.
- Build: `npm run build` (`tsc`). Test: `npm test` (`node --import tsx --test test/*.ts context/*/test/*.test.mjs`).

## Review Focus

Input classes the spec implies but that no task's happy path exercises; each line's test is added to the owning task.

- **A non-capable instance where a client pokes the isolation API anyway** — must be refused with `isolation requires the privileged deployment`, never silently accepted as a cosmetic wall. *(Task 3, Task 8)*
- **A spawn/action request that names a group the caller does not belong to** — the server derives the group from the session and ignores the client's claim; cross-group spawn/see/drive is refused. *(Task 5, Task 10)*
- **A caller whose account was deleted, or a session key for a channel that was closed, hitting a gated route** — `currentAccount` resolves to `null`/no-membership and the ACL denies gracefully (no 500, no leak). *(Task 4, Task 10)*
- **Concurrent Claude-credential refresh across group OS users** — writes must not break other groups' reads; the in-place-vs-rename fact decides whether the broker is mandatory. *(Task 6, Task 7)*
- **Migration partial failure, or a `docker recreate` that drops OS users/HOMEs** — the boot step is idempotent, volume-marked, and fail-safe: a partial run must not break the instance. *(Task 14, Task 15)*

---

## Phase 1 — The group model and the ACL (pure core, no OS walls yet)

### Task 1: Group model + visibility/action ACL (pure core)

**Files:**
- Create: `src/groups.ts`
- Test: `test/groups.test.ts`

**Interfaces:**
- Consumes: `type Role` from `src/accounts.ts` (type-only import, erased at runtime — keeps `groups.ts` fs-free and pure like `kinship.ts`).
- Produces:
  - `export type Nature = "private" | "restricted" | "public";`
  - `export interface Group { id: string; name: string; nature: Nature; members: string[]; owner?: string; osUser?: string | null; createdAt: number; }`
  - `export const MAIN_GROUP_ID = "main";`
  - `export interface Viewer { name: string; role: Role }`
  - `export function memberOf(g: Group, name: string): boolean`
  - `export function canSeeGroup(g: Group, viewer: Viewer | null): boolean` — operational visibility: `public`, or the viewer is a member (private owner counts as member). This is also the see/drive rule.
  - `export function canAdministerGroup(g: Group, viewer: Viewer | null): boolean` — admin reach: `nature !== "private"` **and** (`viewer.role === "admin"` **or** `memberOf`). Public is administrable by admins only for secrets (the `Main` rule, Task 9); private is **never** administrable.
  - `export function visibleGroupIds(groups: readonly Group[], viewer: Viewer | null): Set<string>`
  - `export function membershipVerdict(actor: Viewer | null, g: Group, action: "invite" | "leave" | "remove", target: string): { ok: true } | { ok: false; error: string }` — invite: any member of a `restricted` group; leave: self only; remove: `admin` only; private/public: refused for all three.

- [ ] **Step 1: Write the failing tests** (`test/groups.test.ts`, `node:test` + `assert/strict`, top-level `test(...)`):

```ts
test("public group is visible and drivable by everyone, incl. a non-member", () => {
  const g: Group = { id:"x", name:"X", nature:"public", members:[], createdAt:0 };
  assert.equal(canSeeGroup(g, { name:"zoe", role:"member" }), true);
  assert.equal(canSeeGroup(g, null), true);
});
test("restricted group is visible only to its members", () => {
  const g: Group = { id:"comex", name:"COMEX", nature:"restricted", members:["ada"], createdAt:0 };
  assert.equal(canSeeGroup(g, { name:"ada", role:"member" }), true);
  assert.equal(canSeeGroup(g, { name:"zoe", role:"member" }), false);
  assert.equal(canSeeGroup(g, { name:"zoe", role:"admin" }), false); // admin cannot SEE a team it isn't in
});
test("private group is sealed even to an admin", () => {
  const g: Group = { id:"p", name:"Ada", nature:"private", members:["ada"], owner:"ada", createdAt:0 };
  assert.equal(canSeeGroup(g, { name:"root", role:"admin" }), false);
  assert.equal(canAdministerGroup(g, { name:"root", role:"admin" }), false);
});
test("admin administers a restricted group it is not in, but cannot see/drive it", () => {
  const g: Group = { id:"rh", name:"RH", nature:"restricted", members:["ada"], createdAt:0 };
  const admin = { name:"root", role:"admin" as const };
  assert.equal(canAdministerGroup(g, admin), true);
  assert.equal(canSeeGroup(g, admin), false);
});
test("membershipVerdict: any member invites, self leaves, only admin removes", () => {
  const g: Group = { id:"t", name:"T", nature:"restricted", members:["ada","leo"], createdAt:0 };
  assert.equal(membershipVerdict({name:"ada",role:"member"}, g, "invite", "zoe").ok, true);
  assert.equal(membershipVerdict({name:"ada",role:"member"}, g, "leave", "ada").ok, true);
  assert.equal(membershipVerdict({name:"ada",role:"member"}, g, "remove", "leo").ok, false);
  assert.equal(membershipVerdict({name:"root",role:"admin"}, g, "remove", "leo").ok, true);
  assert.equal(membershipVerdict({name:"ada",role:"member"}, {...g, nature:"private"}, "invite", "z").ok, false);
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/groups.test.ts` (or `node --import tsx --test test/groups.test.ts`). Expected: FAIL, module/exports not defined.
- [ ] **Step 3: Implement `src/groups.ts`** with the signatures in Interfaces. Pure functions only; no `fs`, no `os`, no imports with runtime side effects.
- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(groups): group model + visibility/admin/membership ACL (pure core)`.

### Task 2: Promote the group to a server-owned typed store

**Files:**
- Modify: `src/channels.ts` (the untyped `loadGroups(): any[]`/`saveGroups(list: any[])` at `src/channels.ts:287-293`; the `Channel.group` field at `src/channels.ts:21`; `SERVER_OWNED` at `src/channels.ts:62`)
- Test: `test/channels.test.ts` (extend)

**Interfaces:**
- Consumes: `Group`, `Nature`, `MAIN_GROUP_ID` from Task 1.
- Produces:
  - `loadGroups(): Group[]` / `saveGroups(list: Group[]): void` — typed; same per-launch-dir path (`~/.shadok-ai/channels/<enc>-groups.json`, `storeFile` at `src/channels.ts:119`).
  - `export function normalizeGroups(raw: unknown): Group[]` — coerces today's untyped tab-group rows (`{id:number,name,collapsed,order}`) into `Group` with `nature:"public"`, `members:[]`, `osUser:null`, a string `id` (stringified numeric id), preserving `name`; drops unparseable rows. (This is what migration leans on, Task 14.)
  - `export function ensureMainGroup(list: Group[]): Group[]` — guarantees a `{ id: MAIN_GROUP_ID, nature:"public" }` row exists (idempotent).
  - `Channel.group` becomes `string | null` (a group **id** reference), still **client-owned for ordering** but now resolvable to a server-owned `Group`. Keep it out of `SERVER_OWNED` (a channel's group *assignment at birth* is set server-side in Task 5 via explicit upsert, not via the client merge).

- [ ] **Step 1: Write failing tests** — `normalizeGroups` turns a legacy `[{id:3,name:"SALES"}]` into `[{id:"3",name:"SALES",nature:"public",members:[],osUser:null,...}]`; `ensureMainGroup([])` yields one `main` public group; `ensureMainGroup` is idempotent (calling twice adds nothing).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the typed store + `normalizeGroups` + `ensureMainGroup`; change `Channel.group` type to `string | null`. Update `GET /groups` (`src/server.ts:1385`) and `PUT /groups` (`src/server.ts:1386`) to pass through `Group[]` (the instance-key write guard at `src/server.ts:1387` is unchanged here; identity-scoping of `/groups` lands in Task 3/Task 4).
- [ ] **Step 4: Run, verify pass; `npm run build` clean** (the `Channel.group` type change must not break `mergeChannels`/`public/*.js`).
- [ ] **Step 5: Commit** — `feat(groups): server-owned typed Group store + legacy normalization`.

### Task 3: Deployment mode — the capability probe (pure + boot wiring)

**Files:**
- Create: `src/capability.ts`
- Test: `test/capability.test.ts`
- Modify: `src/server.ts` (boot sequence near `src/server.ts:3898`; `/version` handler)

**Interfaces:**
- Produces:
  - `export type DeploymentMode = "multi-tenant" | "mono-tenant";`
  - `export function accountsEnabled(guiPassword: string): boolean` — `guiPassword.trim() !== ""`.
  - `export function probeCanProvision(deps?: { getuid?: () => number | undefined; canSudo?: () => boolean; env?: NodeJS.ProcessEnv }): boolean` — mirrors `inContainer` (`src/ssh.ts:50`) injectable style: `SHADOK_FORCE_MULTITENANT==="1"`→true, `==="0"`→false; else `getuid?.() === 0`, else `canSudo()` (deterministic `sudo -n true` probe, injected in tests).
  - `export function deploymentMode(input: { canProvision: boolean; accountsEnabled: boolean }): DeploymentMode` — `"multi-tenant"` iff both true.
  - `export function isolationRefusal(mode: DeploymentMode): string | null` — `mono-tenant` → `"isolation requires the privileged deployment"`, else `null`.
- One module-level resolved `DEPLOYMENT_MODE` in `server.ts`, computed once at boot — the single source of truth.

- [ ] **Step 1: Write failing tests** — `deploymentMode` truth table (both→multi, either missing→mono); `probeCanProvision` honours the force env both ways, returns true as root, falls to `canSudo` otherwise; `accountsEnabled("")===false`; `isolationRefusal` wording for each mode.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `src/capability.ts`; in `server.ts` compute `const DEPLOYMENT_MODE = deploymentMode({ canProvision: probeCanProvision(), accountsEnabled: accountsEnabled(GUI_PASSWORD) })` at boot and surface it on `/version` (add a `mode` field) plus a startup log line.
- [ ] **Step 4: Run, verify pass; `npm run build` clean.**
- [ ] **Step 5: Commit** — `feat(capability): deterministic deployment-mode probe (privileged AND accounts)`.

### Task 4: Resolve a caller's visible groups server-side

**Files:**
- Modify: `src/server.ts` (`currentAccount` at `src/server.ts:761`; the WS `me` at `src/server.ts:3076`)
- Create: nothing (reuses Task 1 core)
- Test: `test/groups.test.ts` (extend — pure `visibleChannels`)

**Interfaces:**
- Consumes: `currentAccount(req) → { name, role } | null` (exists); `Group` store (Task 2); `canSeeGroup`/`visibleGroupIds` (Task 1).
- Produces (pure, in `src/groups.ts`):
  - `export function visibleChannels(channels: readonly Channel[], groups: readonly Group[], viewer: Viewer | null): Channel[]` — keeps a channel iff its `group` resolves to a group with `canSeeGroup`, **or** it has no group (legacy/commons → treated as `Main`/public).
  - `export function viewerFor(account: { name: string; role: Role } | null): Viewer | null` — identity shim (returns the account as a `Viewer`, `null` passthrough).
- Server helper `callerGroups(req): { viewer: Viewer | null; groups: Group[] }` reused by every gated route.

- [ ] **Step 1: Write failing tests** — `visibleChannels` keeps public + own-group channels, drops a restricted channel for a non-member, keeps a group-less channel for everyone (commons), drops nothing in mono-tenant (covered by passing `viewer` that an admin-everywhere caller resolves to — see Task 8 gate).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the pure helpers in `groups.ts` and the `callerGroups` server helper (no behaviour change to routes yet — routes adopt it in Tasks 8, 10).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(groups): visibleChannels + caller-group resolution helper`.

---

## Phase 2 — Real OS walls (privileged orchestrator)

### Task 5: Spawn into the caller's own group — derive the OS user, drop privilege

**Files:**
- Modify: `src/session.ts` (`PilotOptions` at `src/session.ts:32`; `PtyPilot.start()` spawn at `src/session.ts:105`)
- Modify: `src/tmux.ts` (`TmuxPilotOptions` at `src/tmux.ts:20`; `TmuxPilot.start()` new-session at `src/tmux.ts:112`)
- Modify: `src/server.ts` (`makePilot` at `src/server.ts:2135`; the `start` case group derivation at `src/server.ts:3122`, upserts at `src/server.ts:3254`/`3310`)
- Create: `src/osusers.ts` (pure planning helpers)
- Test: `test/osusers.test.ts`, `test/session-user.test.ts`

**Interfaces:**
- Produces (pure, `src/osusers.ts`):
  - `export function osUserFor(g: Group): string | null` — `null` for a public group (commons: the server's own non-root `main` user, created by migration, Task 15); `"sk-" + <sanitized id>` for private/restricted.
  - `export function dropArgv(user: string, bin: string, args: string[]): { cmd: string; argv: string[] }` — the privilege-drop wrapper: `{ cmd: "setpriv", argv: ["--reuid", user, "--regid", user, "--init-groups", "--", bin, ...args] }`. (Chosen because `setpriv` preserves the passed env, unlike a PAM `runuser`; alternatives noted for the builder below.)
- Threads a new optional `user?: string` through `PilotOptions`, `TmuxPilotOptions`, and `makePilot(id, cwd, args, profileName?, user?)`. When `user` is set:
  - `PtyPilot.start()` spawns `dropArgv(user, claudePath, args)` instead of `claudePath` directly (node-pty has no uid option).
  - `TmuxPilot.start()` prepends `setpriv --reuid … --regid … --init-groups --` **in front of** the existing `env …` prefix at `src/tmux.ts:112`.
- The `start` case resolves the agent's group from the **caller's identity** (`callerGroups(req)` / the WS `me`), never from the client payload, and passes `osUserFor(group)` to `makePilot`. The channel is upserted with its `group` id server-side (add `group` to the `start`-path `upsertChannel` at `src/server.ts:3310`).

- [ ] **Step 1: Write failing tests** — `osUserFor` returns `null` for public, `sk-…` for restricted/private; `dropArgv` builds the exact `setpriv` argv; a `PtyPilot`/`TmuxPilot` constructed with `user` produces a spawn command whose first token is `setpriv` (assert on a captured spawn via injected fake, matching the `waitFor`/fake-pilot pattern already used in `test/detect.test.ts`).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Guard the whole drop behind `DEPLOYMENT_MODE === "multi-tenant"`: in mono-tenant, `user` is always `null` and the spawn path is byte-for-byte today's. Keep `FORCED_CLAUDE_ENV` applied last (`src/session.ts:28`) and the `CLAUDE|CLAUDECODE|AI_AGENT` strip intact.
- [ ] **Step 4: Run, verify pass; `npm run build` clean.**
- [ ] **Step 5: Commit** — `feat(exec): drop to the group's OS user per spawn; spawn stays own-group`.

**Builder notes (left-to-builder, per spec):** `setpriv` requires the resolved uid/gid of the provisioned user; resolve it once at provision time (Task 6) and store it on the `Group` (`osUser` already carries the name — add a resolved `uid`/`gid` if `setpriv --reuid <name>` is unavailable on the base image). Alternatives: `runuser -u <user> -- …` (PAM, may reset env → needs `--preserve-environment` + explicit re-export) or native `process.setuid` in a pre-exec shim. The tmux **re-adopt** path (`src/tmux.ts:92`, `attached=true`) keeps the uid the pane was first spawned under — migration (Task 15) must respawn, not re-adopt, any pane created as root.

### Task 6: On-demand OS-user provisioning + teardown (privileged server)

**Files:**
- Modify: `src/osusers.ts` (add the impure provision/teardown, injectable exec)
- Modify: `src/server.ts` (call provision when a private/restricted group is created; teardown when deleted)
- Test: `test/osusers.test.ts` (extend — pure plan only)

**Interfaces:**
- Produces:
  - `export interface ProvisionPlan { user: string; home: string; useradd: string[]; seedHome: boolean; }`
  - `export function provisionPlan(g: Group, homeBase: string): ProvisionPlan | null` — `null` for public (nothing to provision); else the `useradd --create-home --home-dir <homeBase>/<user> <user>` argv + the HOME path.
  - `export async function provisionGroupUser(g: Group, deps: { run: (cmd: string, argv: string[]) => Promise<void>; seed: (home: string) => Promise<void>; homeBase: string }): Promise<{ osUser: string; home: string }>` — runs `useradd`, creates HOME, seeds `~/.claude` (skills + settings via the existing `claude-home` seeding, per HOME) and the **credential symlink** (Task 7), mounts `~/shared/` (Task 12). Idempotent (a user that already exists is reused).
  - `export async function teardownGroupUser(g: Group, deps): Promise<void>` — kills the group's running agents, `userdel --remove` (HOME + mail spool), best-effort; never throws into the caller.
- Group creation (`PUT /groups`, or a dedicated `POST /groups` create path) calls `provisionGroupUser` for a **restricted** group and refuses in mono-tenant with `isolationRefusal`. Public create provisions nothing.

- [ ] **Step 1: Write failing tests** — `provisionPlan` returns `null` for public; builds the exact `useradd --create-home --home-dir …` argv for a restricted group; the HOME path is `<homeBase>/<user>`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the pure plan + the impure runner (injected `run`/`seed` so tests stay fs/exec-free). Wire creation/teardown behind `DEPLOYMENT_MODE` multi-tenant.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(osusers): provision/teardown a group's OS user + HOME`.

### Task 7: Shared Claude credential across group HOMEs — verify, then wire

**Files:**
- Modify: `src/osusers.ts` (credential symlink in `provisionGroupUser`)
- Create (conditional): `src/auth-broker.ts` — **only if** the write-back verification below says rename.
- Test: `test/osusers.test.ts` (symlink plan)

**Interfaces:**
- Produces: `export function credentialWiring(home: string, sharedCredentialPath: string): { link: string; target: string }` — `{ link: <home>/.claude/.credentials.json, target: sharedCredentialPath }`.

- [ ] **Step 1 — PRE-FLIGHT INVESTIGATION (no code; the spec's `[builder — verify BEFORE planning the auth path]` gate).** On a running instance, determine whether `claude` refreshes the OAuth token **in place** or **writes-new-then-renames**. Method: watch the inode of `~/.claude/.credentials.json` across a refresh (`stat -c %i` before/after, or `inotifywait -m` on the file and its directory for `MOVED_TO`/`CREATE` vs `MODIFY`). Record the finding in the plan/ledger.
  - **If in-place:** the symlink scheme (one server-owned credential file, each HOME symlinks to it) is sufficient; the existing one-at-a-time refresh discipline holds; **skip the broker.**
  - **If rename:** a refresh produces a fresh `600` file owned by the refreshing group's user, breaking every other group's read → the **auth broker is mandatory from day one** (a single owner process holds the credential and hands read-only copies out; agents never refresh directly). Implement `src/auth-broker.ts` in this task.
- [ ] **Step 2: Write failing test** — `credentialWiring` returns the exact link/target pair; (broker branch, if taken) a pure test of the broker's "hand out a read-only copy, serialise refresh" state machine.
- [ ] **Step 3: Implement** `credentialWiring` and, in `provisionGroupUser`, create `<home>/.claude` and symlink `.credentials.json` to the shared file (readable+writable by each group user in the in-place branch; read-only + broker in the rename branch).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(auth): share one Claude credential across group HOMEs (<in-place symlink | broker>)`.

### Task 8: Enforce the capability gate on every isolation affordance

**Files:**
- Modify: `src/server.ts` (group-create path, private-group provision, `POST /users` invite→provision hook)
- Test: `test/server-isolation.test.ts` (new, HTTP-level with a booted app on a free port, following `test/*.ts` that spin the server — or a thin unit over the gate helper)

**Interfaces:**
- Produces: `requireCapable(res): boolean` — a server helper that, in mono-tenant, responds `400 { error: isolationRefusal(mode) }` and returns `false`; used by every route that would provision a wall.

- [ ] **Step 1: Write failing test** — in mono-tenant mode, creating a restricted group returns `400 isolation requires the privileged deployment` and provisions no OS user (Review Focus #1); in multi-tenant it proceeds.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `requireCapable` and apply it to the restricted-group create, the private-group provision, and the share-list/secret paths that assume a slice.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(capability): honest refusal of isolation in mono-tenant — never a fake wall`.

---

## Phase 3 — Secrets under groups

### Task 9: Per-group vault with share-by-reference (pure core)

**Files:**
- Modify: `src/secrets.ts` (the flat `Vault = Record<string,string>` at `src/secrets.ts:12`; `secretsFor` at `src/secrets.ts:98`)
- Test: `test/secrets.test.ts` (new/extend)

**Interfaces:**
- Produces:
  - `export interface SecretEntry { value: string; ownerGroup: string; sharedWith: string[]; profiles: string[]; createdBy: string; createdAt: number; updatedAt: number; }`
  - `export interface GroupVault { [name: string]: SecretEntry }` keyed first by group id, then name: `export type Vault = { [groupId: string]: GroupVault }` (one server-owned file, policy-scoped — physical split optional per spec).
  - `export function resolveSecretValues(vault: Vault, groupId: string, names: readonly string[]): Record<string,string>` — resolution **own group → shared-in → `Main` → absent**, per name, unique-per-group names, no cross-group pin.
  - `export function secretWriteVerdict(...)` kept, extended with the owner-group membership precondition (the identity check stays in the server; the pure verdict gains `ownerGroupMatches: boolean`).
  - `export function migrateFlatVault(flat: Record<string,string>, mainId: string, createdBy: string, now: number): Vault` — lifts today's flat map into `Main`'s slice (Task 14 / spec "Migration (secrets)").
- `secretsFor(profile?.secrets)` (called at spawn `src/server.ts:2144` and cron `src/server.ts:413`) becomes `resolveSecretValues(loadVault(), agentGroupId, profile?.secrets)` — the agent's group derived from its session.

- [ ] **Step 1: Write failing tests** — resolution precedence (own beats shared beats Main beats absent); a name defined in two groups resolves independently per group; a shared-in secret resolves for the shared-with group and not for a third; `migrateFlatVault` puts every flat entry under `Main` with `ownerGroup:"main"`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the nested vault + resolution + migration; keep `normalizeVault` auto-migrating the legacy shapes (today's flat map AND the older per-repo nesting) into the new structure.
- [ ] **Step 4: Run, verify pass; `npm run build` clean.**
- [ ] **Step 5: Commit** — `feat(secrets): per-group vault, share-by-reference, own→shared→Main resolution`.

### Task 10: Scoped secrets API + ACL on every gated route

**Files:**
- Modify: `src/server.ts` — `GET/PUT/DELETE /secrets` (`src/server.ts:1396-1414`), a new share-list edit and a profile-binding edit; `GET /channels` (`src/server.ts:1253`); the `/ws` action cases (`prompt` `src/server.ts:3348`, `choose`/`toggle`/`freetext`/`confirm` `3451-3534`, `restart` `3613`, `set-profile` `3618`, `set-parent` `3634`, `stop` `3649`)
- Test: `test/server-acl.test.ts` (new)

**Interfaces:**
- Consumes: `callerGroups(req)` (Task 4), `visibleChannels` (Task 4), `canSeeGroup`/`canAdministerGroup` (Task 1), `resolveSecretValues` (Task 9).
- Produces:
  - `GET /channels` filters through `visibleChannels(loadChannels(), loadGroups(), viewerFor(currentAccount(req)))` — the `_req` at `src/server.ts:1253` is now read.
  - `GET /secrets` returns only names the caller's groups resolve (own + shared-in + `Main`), each tagged `{ name, source: "own"|"shared"|"main", ownerGroup? }` — **names only, never values**.
  - `PUT /secrets` requires **owner-group membership** (private: owner only; `Main`/restricted: admin) and stamps `createdBy` from the session (agent) or account (browser), never the client body.
  - `PUT /secrets/share` (owner-group membership gated) edits a secret's `sharedWith`; `PUT /secrets/profiles` edits its `profiles` binding — the link now lives on the secrets side.
  - Each `/ws` action case checks `canSeeGroup(groupOf(session), me)` before acting (see/drive = own + public); a cross-group drive is refused with `error { code: "forbidden" }`.

- [ ] **Step 1: Write failing tests** (booted app or gate-helper unit): a member of COMEX sees COMEX + public channels and not RH's (Review Focus #2); `GET /secrets` for a SALES caller omits COMEX-only names; a `prompt`/`restart` on a channel in a group the caller isn't in is refused; a deleted-account caller (`currentAccount → null`) gets an empty channel list and a clean 401/empty, not a 500 (Review Focus #3); an agent's `PUT /secrets` lands in its own group and records `createdBy` as the agent.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the filtering + action gating + the two new secret-edit routes. In mono-tenant, `callerGroups` resolves everyone to the single `Main` commons so the filters are no-ops (behaviour identical to today).
- [ ] **Step 4: Run, verify pass; `npm run build` clean.**
- [ ] **Step 5: Commit** — `feat(acl): server-side scoping of channels, secrets and every drive action`.

### Task 11: Secrets UI — group-scoped panel + profile editor read-only

**Files:**
- Modify: `public/index.html` (`#secretsOverlay`, the groups bar, the profile editor `profSecretsList`)
- Modify: `public/profile-card.js` (if the secrets-names badge logic moves) + `test/profile-card.test.ts`
- Test: browser verification on a free port (per CLAUDE.md "Running YOUR build"); pure UI helpers unit-tested where extracted

**Interfaces:**
- Consumes: the scoped `GET /secrets` tags (Task 10), the `Group` list.
- Produces: the panel scoped to one group showing three sections (**own** editable with a per-secret "shared read with" control; **shared-in** read-only with owner group; **inherited from `Main`** read-only); a 🔑 entry per group in the groups bar; write-only value field with `createdBy`/`createdAt`/`updatedAt` display; **single-flat-list degradation** when only `Main` exists; the profile editor turned read-only on secrets with a "→ Manage secrets" link.

- [ ] **Step 1:** If any decision logic is pure (e.g. which sections to show, degradation), extract it to a bridged ESM module (invariant 10/12 — carry `__CSP_NONCE__`, `?v=` on imports) and write its unit test first (fails).
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the overlay sections, the 🔑 per-group entry, the audit display, the degradation branch, and the profile-editor read-only change. Reuse the validated mockup (`scratchpad/secrets-mockup.html`) and the group-create box (`scratchpad/group-create-mockup.html`, Public vs Restricted).
- [ ] **Step 4:** `npm run build`; run the instance on a free port (`PORT=3899 SHADOK_VERSION_CHECK_MIN=0`), drive it with Playwright, screenshot the panel in both single-group (flat) and multi-group (three-section) states, read the screenshots back, capture the console (CSP/module errors are silent in the DOM).
- [ ] **Step 5: Commit** — `feat(ui): group-scoped secrets panel, 🔑 per group, profile editor read-only on secrets`.

---

## Phase 4 — Files, ledger, talk

### Task 12: The shared pot (`~/shared/`) mounted into every HOME

**Files:**
- Modify: `src/osusers.ts` (`provisionGroupUser` mounts/links `~/shared/`)
- Test: `test/osusers.test.ts` (plan)

**Interfaces:**
- Produces: `export function sharedPotWiring(home: string, sharedBase: string): { link: string; target: string }` — `<home>/shared` → the one server-owned `sharedBase`, group-writable by all.

- [ ] **Step 1:** Failing test on `sharedPotWiring` (exact link/target; same for public and isolated HOMEs).
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the link in `provisionGroupUser` and in the commons HOME setup (Task 15). Accept the spec's trade-offs (no per-file guardrail; dropping a file there makes it public).
- [ ] **Step 4:** Run, verify pass.
- [ ] **Step 5: Commit** — `feat(files): shared ~/shared/ pot across all group HOMEs`.

### Task 13: Ledger scoped by group (`--public` to publish)

**Files:**
- Modify: `context/ledger-skill/ledger-core.mjs` (`upsertEntry` at `:39`), `context/ledger-skill/ledger.mjs` (`parseFlags` `:46`, `record` `:78`), `context/ledger-skill/SKILL.md`
- Modify: `src/ledger.ts` (`LedgerRow` at `:23`; `deltaSince` at `:112`), `src/server.ts` (the push at `src/server.ts:3424`)
- Test: `test/ledger.test.ts` (extend), `context/ledger-skill/test/*.test.mjs`

**Interfaces:**
- Produces:
  - `LedgerRow` gains `scope?: "group" | "public"` (default `"group"`).
  - `upsertEntry(entries, patch, now, newId)` threads `patch.scope` onto the row (the spread at `ledger-core.mjs:43`/`:59`).
  - `ledger.mjs record` gains a **boolean** `--public` flag (fix `parseFlags` so a bare boolean doesn't consume the next arg) → sets `scope:"public"`; bare `record` stays `scope:"group"` (safe default).
  - `export function deltaSince(rows, watermark, cap, visibleScope: { groupId: string | null; includePublic: boolean })` — filters to rows whose `scope` is `"public"` **or** whose authoring group matches the caller's group; `check` filters the same way.
- The server derives the agent's group (from its session) when building the push at `src/server.ts:3424` and when answering `check`; the watermark bookkeeping (`ledgerSeenFileFor`) is unchanged.

- [ ] **Step 1: Write failing tests** — `upsertEntry` carries `scope`; default is `"group"`; `--public` parses as a boolean and sets public scope; `deltaSince` with a group filter drops another group's group-scoped rows and keeps public ones.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the scope field + filter + the `--public` flag + SKILL.md wording (document the safe default and the `~/shared/` twin). Direction of the default is the non-negotiable invariant — group-private by default.
- [ ] **Step 4:** Run, verify pass; `npm run build` clean.
- [ ] **Step 5: Commit** — `feat(ledger): per-row group/public scope, --public to publish to the commons`.

### Task 14: Cross-group talk — a letter, not a remote control

**Files:**
- Create: `src/talk.ts` (pure ACL)
- Modify: `src/server.ts` (a new talk route/WS message built on `driveChannel` at `src/server.ts:481`), `context/agents-skill/pilotctl.mjs` + `SKILL.md`
- Test: `test/talk.test.ts`

**Interfaces:**
- Consumes: `driveChannel(sessionId, text, target)` (`src/server.ts:481`), `markAgentPrompt`/`notificationText` (`src/kinship.ts`), `canSeeGroup` + the `Group` store.
- Produces (pure, `src/talk.ts`):
  - `export function talkVerdict(sender: Group, recipient: Group, hasHandle: boolean): { ok: true } | { ok: false; error: string }` — public recipient: free; other restricted: only `hasHandle`; private recipient: sealed both ways (refused); private **sender** to public/restricted: allowed outbound (a letter).
- Server `POST /talk` (or a `talk` WS message) resolves sender group from the session, recipient from a **handle**, checks `talkVerdict`, and delivers via `driveChannel` with a `markAgentPrompt`-wrapped letter. The sender never receives the recipient's transcript. No roster enumeration across groups.

- [ ] **Step 1: Write failing tests** — public recipient messageable without a handle; other-restricted only with a handle; private recipient refused from outside; a private sender may send outward; the delivered text is wrapped as a hidden agent prompt.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement `talk.ts` + the server route on top of `driveChannel` + the pilotctl `talk` subcommand and SKILL.md. Handle-passing plumbing (how a handle is obtained) is the spec's `[OPEN]` — expose a handle the server mints for a known counterpart; do not add enumeration.
- [ ] **Step 4:** Run, verify pass.
- [ ] **Step 5: Commit** — `feat(talk): narrow consensual cross-group message (public free, restricted by handle, private sealed)`.

---

## Phase 5 — Migration and lifecycle

### Task 15: Automatic migration boot step (root → non-root commons)

**Files:**
- Create: `src/migrate-groups.ts` (pure plan + impure runner, injectable)
- Modify: `src/server.ts` (boot sequence — a new step before `startFirstAgent`, near `src/server.ts:3898`, after `ensureClaudeHome`)
- Modify: `Dockerfile` (no `USER` change needed — the commons user is created at runtime by migration; document why)
- Test: `test/migrate-groups.test.ts`

**Interfaces:**
- Produces:
  - `export interface MigrationPlan { createCommonsUser: boolean; chownTree: boolean; vaultToMain: boolean; provisionPrivatePerAccount: string[]; labelExistingPublic: boolean; }`
  - `export function migrationPlan(input: { alreadyMigrated: boolean; mode: DeploymentMode; accounts: string[] }): MigrationPlan | null` — `null` when `alreadyMigrated` or `mode==="mono-tenant"` (a non-capable install is **not** migrated).
  - `export async function runMigration(plan, deps): Promise<void>` — idempotent, **marker on the `shadok-data` volume**, fail-safe (a partial failure logs and does not break boot): create non-root `main` user → `chown` the existing root-owned tree to `main` once (files do not move) → flat vault → `Main` slice (`migrateFlatVault`, Task 9) → auto-provision each account's private group (empty) → label existing channels/groups public.
  - Running pre-migration agents are **respawned once under `main`** (`--resume`, history kept), **one at a time** (the OAuth refresh discipline), reusing `restartAllSessions`-style sequencing — never re-adopted as root.

- [ ] **Step 1: Write failing tests** — `migrationPlan` returns `null` in mono-tenant and when already migrated; in capable+fresh it lists one private group per account and sets every flag; it is idempotent (second call after `alreadyMigrated` → `null`).
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the pure plan + the impure runner (injected `run`/`chown`/`fs`), wire it into boot **before** `startFirstAgent`, guarded by the volume marker and `DEPLOYMENT_MODE`. Log every step; surface once in the UI that the instance moved to isolated groups (Review Focus #5).
- [ ] **Step 4:** Run, verify pass; `npm run build` clean.
- [ ] **Step 5: Commit** — `feat(migrate): automatic, idempotent root→non-root commons migration`.

### Task 16: Account lifecycle hooks — invite provisions, delete tears down

**Files:**
- Modify: `src/server.ts` (`POST /invite/:token` redeem at `src/server.ts:951`; `DELETE /users` at `src/server.ts:1508`)
- Modify: `src/groups.ts` (private-group helpers) / `src/osusers.ts` (provision/teardown)
- Test: `test/server-acl.test.ts` (extend) / `test/groups.test.ts`

**Interfaces:**
- Consumes: `provisionGroupUser`/`teardownGroupUser` (Task 6), `membershipVerdict` (Task 1), `userWriteVerdict` (`src/accounts.ts:76`).
- Produces:
  - Redeeming an invite (unprivileged path) creates the account **and** kicks the privileged **private-group provision** for that person (one `private` group, `owner=name`, `members=[name]`).
  - `DELETE /users` (admin-only, browser-only, `src/server.ts:1508`) triggers the **cascade teardown** of that account's private group — OS user, HOME, running agents — behind an explicit admin confirmation ("permanently destroys X's private space, which cannot be inspected"). Data is removed, never revealed (no break-glass).

- [ ] **Step 1: Write failing tests** — redeeming an invite provisions exactly one private group for the new account; deleting an account tears down its private group and only its private group (not its restricted memberships' groups).
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the hooks (guarded by `DEPLOYMENT_MODE`; in mono-tenant there are no private groups, so both hooks no-op).
- [ ] **Step 4:** Run, verify pass.
- [ ] **Step 5: Commit** — `feat(accounts): invite→private-group provision, delete→cascade teardown`.

### Task 17: Scope the lead agent to `Main`

**Files:**
- Modify: `src/first-agent.ts` (`firstAgentPlan` at `src/first-agent.ts:36`), `src/server.ts` (`startFirstAgent` at `src/server.ts:342`)
- Test: `test/first-agent.test.ts` (extend)

**Interfaces:**
- Produces: `firstAgentPlan` input gains the notion that the "no channel at all" condition is scoped to **`Main`** — only `Main` has a lead; every other group (including a freshly provisioned private group) starts **empty**. The signature gains `mainChannelCount` (channels in `Main`) replacing the bare `channelCount`, or a `groupId` parameter.

- [ ] **Step 1: Write failing test** — a brand-new private/restricted group with zero channels does **not** trigger a lead spawn; only `Main` being empty does.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement the scoping; keep idempotency ("no channel in `Main`") and the signed-in precondition.
- [ ] **Step 4:** Run, verify pass; `npm run build` clean.
- [ ] **Step 5: Commit** — `feat(first-agent): only Main gets a lead; every other group starts empty`.

---

## Phase 6 — Docs

### Task 18: Documentation (ships with the change, not after)

**Files:**
- Modify: `CLAUDE.md` (new modules `groups.ts`/`capability.ts`/`osusers.ts`/`talk.ts`/`migrate-groups.ts`; new invariants: never-a-fake-wall, no-root-agent, group-derived-from-session, ledger/talk scope), `docs/architecture.md` (the groups/isolation subsystem and its trade-offs), `README.md` (deployment modes, the capability requirement, the groups UX)
- Test: the prose-locking tests where they exist (e.g. a `test/*-docs.test.ts` twin of `test/skill-auth-docs.test.ts` if a skill's wording is load-bearing)

- [ ] **Step 1:** Update `CLAUDE.md` architecture map + invariants.
- [ ] **Step 2:** Update `docs/architecture.md` (cite symbols, not line numbers).
- [ ] **Step 3:** Update `README.md` deployment-mode + groups sections.
- [ ] **Step 4:** `npm test` + `npm run build` clean.
- [ ] **Step 5: Commit** — `docs: multi-tenant groups, deployment modes, isolation invariants`.

---

## Self-review notes

- **Spec coverage:** core model → T1–T2; capability probe/modes → T3, T8; execution isolation/setuid → T5; OS-user provisioning → T6; Claude auth (incl. the verify-first gate) → T7; files/`~/shared/` → T12; visibility/ACL → T4, T10; collaboration spawn/see/drive/talk/git → T5, T10, T14 (git = branch-protection on the remote, operational, no code); secrets model + UI + scoped API → T9, T10, T11; ledger under groups → T13; migration (instance + secrets + accounts) → T9, T15, T16; lead scoped to Main → T17; cost/disk → no code (operational). Open-decisions: auth broker resolved in T7; Telegram multi-tenancy deferred (spec `[OPEN]`, not planned here); talk-handle discovery partially in T14, rest `[OPEN]`.
- **Degradation invariant** is tested in the owning tasks (T5/T8/T10/T13/T16 each assert the mono-tenant / single-group path is unchanged), per Global Constraints.
- **Deferred, by the spec, not by omission:** Telegram multi-tenancy; disk quotas; a creation guardrail/quota on isolated OS users; the full handle-passing plumbing for talk.
