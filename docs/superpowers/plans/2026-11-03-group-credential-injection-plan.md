# Group Credential Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate every isolated-group agent to the shared Claude subscription by injecting the long-lived subscription token as an environment variable at spawn, and remove the shared-credential-file machinery #373 built for the old symlink approach.

**Architecture:** The privileged server reads one server-owned vault secret (`MT_CLAUDE_OAUTH_TOKEN`) and injects it as `CLAUDE_CODE_OAUTH_TOKEN` into each drop-to-user spawn, in the forced-last env layer (after the `^CLAUDE` strip and after profile secrets) so nothing can shadow or disable it. `claude` authenticates from that env token and writes no credential to disk, so the per-HOME symlink + `shadok-cred` group + reachability chain are deleted.

**Tech Stack:** TypeScript/ESM/Node 20, node-pty + tmux pilots, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-11-03-group-credential-injection-design.md` (and it supersedes the credential section of `docs/superpowers/specs/2026-10-29-multi-tenant-scoped-isolation-design.md`).

## Global Constraints

- Everything written into the repo is **English** (code, comments, identifiers, tests, log/error strings, commits, docs).
- The token is injected in the **forced-last env layer** — after the `/^(CLAUDE|CLAUDECODE|AI_AGENT)/` strip and after profile secrets — exactly where `FORCED_CLAUDE_ENV` is spread in both pilots. `CLAUDE_CODE_OAUTH_TOKEN` begins with `CLAUDE`, so any earlier layer would be stripped; a profile secret of the same name must never win.
- Inject **only on a drop-to-user spawn** (a group HOME, i.e. `opts.user` set). Mono-tenant (no user) injects nothing and is byte-for-byte unchanged — agents there keep authenticating via the server HOME's own credential.
- Vault secret name is **`MT_CLAUDE_OAUTH_TOKEN`**: a **server-owned** secret, resolved under `MAIN_GROUP_ID`. It is **not** a per-group vault slice and **not** a profile secret (invariant 31).
- `/usage` is unchanged: it reads the **server's own** HOME credential (`readToken` in `src/usage.ts`), which still exists from the instance's normal `claude auth login`. This plan never touches `/root/.claude`.
- This lands on branch `mt-isolated-groups` (PR #373): an isolated-spaces PR — **never auto-merged**, carries the `hold` label.
- Build with `npm run build`; verify a local build **side by side on a free port** with `SHADOK_GUI_PASSWORD='' SHADOK_HOST=127.0.0.1` (mono-tenant, never triggers the privileged migration); never take over 3789.
- Docs ship with the change: update `README.md` (multi-tenant provisioning) and the `2026-10-29` design's credential section in this same branch.

## Review Focus

- **Profile shadow attempt:** a profile whose `secrets` resolve a key literally named `CLAUDE_CODE_OAUTH_TOKEN` must NOT override the forced group token. Test asserts the forced value wins. (Task 1)
- **Mono-tenant regression:** a spawn with no `user` must inject no `CLAUDE_CODE_OAUTH_TOKEN`; the env is identical to today's. Test asserts absence. (Task 1)
- **Absent token on a capable instance:** multi-tenant + `MT_CLAUDE_OAUTH_TOKEN` unset must surface a **named, actionable** message (store a token via `claude setup-token`), not a bare per-spawn auth failure — the more so as CC 2.1.314+ adds an org-config/managed-settings consent gate and 2.1.317 a privacy plugin prompt (ledger `[be2d]`/`[bc09]`) that could otherwise mask the cause. Test asserts the message. (Task 3)
- **Over-removal:** deleting the credential-sharing steps must leave the OS-user / HOME / skill-seed provisioning intact — only the credential file, symlink, `shadok-cred` group, and reachability checks go. Test asserts user/HOME provisioning still runs. (Task 2)
- **tmux adopt-on-restart:** a pane created before a token rotation keeps the token it was spawned with until `restart-all`; this is documented, not silently broken. Covered by a comment + the design's verify-first, no new failure path. (Task 1)

---

### Task 1: Inject the subscription token into the forced-last spawn env

**Files:**
- Modify: `src/session.ts` (`PilotOptions` type near the top; `start()` env block at ~`src/session.ts:151-157`)
- Modify: `src/tmux.ts` (the exports builder that runs the `^CLAUDE` strip → secrets → `FORCED_CLAUDE_ENV`, ~`src/tmux.ts:90-131`; thread the new option)
- Modify: `src/server.ts` (`makePilot`, `src/server.ts:5038`; pass the token when `resolveSpawnIsolation` yields a `user`)
- Test: `test/forced-oauth-env.test.ts` (new)

**Interfaces:**
- Consumes: `secretsFor(["MT_CLAUDE_OAUTH_TOKEN"], MAIN_GROUP_ID)` from `src/secrets.ts` (returns `Record<string,string>`; empty when unset).
- Produces: a new optional pilot option `oauthToken?: string` on the shared options type both `PtyPilot` and `TmuxPilot` accept; when set, both spawn with `CLAUDE_CODE_OAUTH_TOKEN=<oauthToken>` placed **after** `FORCED_CLAUDE_ENV`.

- [ ] **Step 1: Write the failing test** `test/forced-oauth-env.test.ts`

Build the spawn env the way `PtyPilot.start()` does (extract the env assembly into a tiny pure helper if needed, e.g. `spawnEnv(opts, baseEnv)`, so it is unit-testable without spawning a PTY — mirror how other pure cores were carved out). Assert:
```ts
// token present and last-wins over an inherited/profile value
spawnEnv({ user: "sk-x", home: "/home/sk-x", env: { CLAUDE_CODE_OAUTH_TOKEN: "PROFILE" }, oauthToken: "FORCED" }, {})
  .CLAUDE_CODE_OAUTH_TOKEN === "FORCED"
// no user => no injection, even if a token is available
spawnEnv({ user: null, oauthToken: "FORCED" }, {}).CLAUDE_CODE_OAUTH_TOKEN === undefined
// no token => key absent (not empty string)
!("CLAUDE_CODE_OAUTH_TOKEN" in spawnEnv({ user: "sk-x", home: "/home/sk-x" }, {}))
```

- [ ] **Step 2: Run it, verify it fails** — `npx tsx --test test/forced-oauth-env.test.ts` → FAIL (helper/option absent).

- [ ] **Step 3: Implement.** Add `oauthToken?: string` to the pilot options type. In both pilots, after the `...FORCED_CLAUDE_ENV` spread, add `...(opts.user && opts.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken } : {})`. In `makePilot`, when the resolved isolation has a `user`, read `secretsFor(["MT_CLAUDE_OAUTH_TOKEN"], MAIN_GROUP_ID)["MT_CLAUDE_OAUTH_TOKEN"]` and pass it as `oauthToken`; otherwise pass nothing. Factor the env assembly into the pure helper the test calls.

- [ ] **Step 4: Run tests** — `npx tsx --test test/forced-oauth-env.test.ts` → PASS; then the full suite.

- [ ] **Step 5: Add the tmux adopt note.** A one-line comment at `TmuxPilot` adopt (`attached = true`, ~`src/tmux.ts:245`): a pane adopted after a restart keeps the token it was spawned with; a rotated token reaches it only on `restart-all`. No code path changes.

- [ ] **Step 6: Commit.**

### Task 2: Remove the shared-credential-file machinery

**Files:**
- Modify: `src/osusers.ts` (delete `SHARED_CRED_GROUP`, `DEFAULT_SHARED_CREDENTIAL_PATH`, the credential-link/`credentialWiring` builder, the reachability checks and the four lstat shapes, and the `groupadd shadok-cred` / `install -d …0750` / `usermod -aG` / `chgrp` steps — keep `dropArgv`, `dropEnv`, `resolveSpawnIsolation`, user/HOME provisioning)
- Modify: `src/migrate-groups.ts` (delete `migSeedSharedCredential` and the commons-HOME symlink step)
- Modify: `src/server.ts` (delete the `SHADOK_SHARED_CREDENTIAL_PATH` wiring, `credentialReachableReal` at ~`:2477`, `credentialDivergenceWarned` at ~`:2387`, the Task-7 "ONE Claude credential" block ~`:2348`, and the `credentialWiring` call site)
- Test: update `test/osusers.test.ts`, `test/migrate-groups.test.ts`; add a source-scan in `test/migration-signin-retry.test.ts` (or a new `test/no-shared-credential.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: migration + OS-user provisioning that no longer references a shared credential file; `seedGroupHome` (`src/server.ts:2517`) no longer creates a `.credentials.json` symlink.

- [ ] **Step 1: Write the failing test.** In the source-scan style (server un-importable): assert `src/migrate-groups.ts` no longer contains `migSeedSharedCredential`, and `src/osusers.ts` no longer contains `shadok-cred` / `DEFAULT_SHARED_CREDENTIAL_PATH`. Add a positive assertion that OS-user + HOME provisioning symbols (`resolveSpawnIsolation`, the `useradd`/HOME-seed step) remain.

- [ ] **Step 2: Run it, verify it fails** (symbols still present) → FAIL.

- [ ] **Step 3: Implement the deletions**, keeping user/HOME/skill-seed provisioning. Update `test/osusers.test.ts` / `test/migrate-groups.test.ts` to drop the credential-wiring cases (and keep the provisioning cases green).

- [ ] **Step 4: Run tests** → PASS; full suite green; `npm run build` clean.

- [ ] **Step 5: Commit.**

### Task 3: Provisioning guard + docs

**Files:**
- Modify: `src/server.ts` (where group spawns are gated on capability — add a check: capable instance + `MT_CLAUDE_OAUTH_TOKEN` absent → a named message, surfaced the way `claudeStubMessage` is, and logged once)
- Modify: `README.md` (multi-tenant section: run `claude setup-token` once, store as `MT_CLAUDE_OAUTH_TOKEN`; note the ~1-year validity and manual re-mint)
- Modify: `docs/superpowers/specs/2026-10-29-multi-tenant-scoped-isolation-design.md` (replace the credential section with a pointer to the new design + the measured reframing)
- Test: `test/mt-token-provisioning.test.ts` (new) — pure check of the absent-token message selector.

**Interfaces:**
- Consumes: `secretsFor([...])` (as Task 1); a capability signal (`mode === "multi-tenant"`, already surfaced by `GET /version`).
- Produces: `mtCredentialMessage(capable: boolean, hasToken: boolean): string | null` (pure, tested) — `null` when fine, a named actionable string when capable and token-less.

- [ ] **Step 1: Write the failing test** asserting `mtCredentialMessage(true, false)` names `MT_CLAUDE_OAUTH_TOKEN` and `claude setup-token`, and `mtCredentialMessage(true, true)` / `mtCredentialMessage(false, false)` return `null`.

- [ ] **Step 2: Run it, verify it fails** → FAIL.

- [ ] **Step 3: Implement** `mtCredentialMessage`, wire it into the capable-spawn path (log once, surface to the group banner the fresh-instance fix already owns), and write the README + design-doc updates.

- [ ] **Step 4: Run tests** → PASS; full suite; `npm run build` clean.

- [ ] **Step 5: Commit.**

## Notes for the executor

- The token is already minted and stored in the vault as `MT_CLAUDE_OAUTH_TOKEN` on the running instance — do not re-mint. For a local free-port build the key is absent and that is fine (mono-tenant injects nothing).
- **Deferred (not in this plan):** a proactive near-expiry warning (the design's boot/daily check). The absent-token guard (Task 3) is the essential safety net for v1; the ~yearly re-mint is documented in the README. A follow-up can add the expiry probe.
- Verify-first before relying on the happy path (from the design): a full **interactive** turn under a **non-root** group user with a **seeded** `CLAUDE_CONFIG_DIR`, clearing the CC 2.1.314/2.1.317 onboarding/consent/privacy gates; confirm the drop-to-user spawn carries the forced token end to end.
