# Group Credential Injection — Design (#373 Task 7)

**Status:** proposed, awaiting approval. Supersedes the shared-credential-file
auth path in `2026-10-29-multi-tenant-scoped-isolation-design.md` (§ "The Claude
credential").

**Date:** 2026-11-03

## Intent

Under isolated groups (#373) every private/restricted group runs its agents as
its **own OS user** with its **own HOME**. The open question Task 7 gates is:
**how does each group's `claude` authenticate to the one shared Claude
subscription**, given that (a) the subscription is legitimately global, and (b)
`claude` refreshes its on-disk credential by **write-new-then-rename** (measured
on mt373 — see ledger `[2d5c]`), which silently breaks a cross-user shared file +
symlink scheme the moment any one group refreshes.

The #373 branch answers this with a **server-owned shared credential file**
(`/var/lib/shadok-ai/credentials/.credentials.json`, unix group `shadok-cred`,
mode `0660`, each HOME's `~/.claude/.credentials.json` a symlink to it) plus a
reachability-checked traversal chain, and left an `[OPEN]` on whether an auth
broker owning the refresh is also needed. The rename measurement turned that
`[OPEN]` into "broker mandatory from day one".

**This design removes the need for all of it.** A pre-flight (below) shows the
subscription can be handed to each `claude` as an **environment token**, which
`claude` uses for auth and **never writes to disk** — so there is no shared file
to clobber, no symlink, no cross-user write-back, no rename race, and no refresh
race.

## The measurement that reframes it

Run on this production cockpit container, `claude` 2.1.316/317, with the token
minted by `claude setup-token` (long-lived, 1 year):

1. **Headless.** `claude -p "…"` with **only** `CLAUDE_CODE_OAUTH_TOKEN` set and
   a **fresh empty `CLAUDE_CONFIG_DIR`** (+ fresh `HOME`): exit 0, answered,
   **no onboarding block**.
2. **No disk leak.** After that run: **no `.credentials.json` anywhere** in the
   config dir or HOME, and a byte-exact `grep` of the token value across both
   returns **nothing**. The token lives **only in the child's environment**.
3. **Config fully isolated.** All of `.claude.json` / `projects/` (transcripts) /
   `sessions/` landed inside the dedicated `CLAUDE_CONFIG_DIR`; the host
   `~/.claude` was untouched.
4. **Interactive too.** The same token, same isolation, spawning the **interactive
   TUI** (`claude`, no `-p`) in tmux: it reaches the **onboarding theme chooser**,
   **not a login/sign-in screen**, and again writes **no token to disk**.

(1)+(4) together **refute line 282 of the #373 spec** — "`CLAUDE_CODE_OAUTH_TOKEN`
is not a substitute; it only feeds `/usage`, not the TUI's own auth". As of 2.1.x
the env token authenticates **both** the headless and the interactive paths.

## Goals

- Every group's agents authenticate to the shared subscription, with **zero
  credential material written into any group HOME**.
- No cross-user file sharing, no symlink, no `shadok-cred` unix group, no
  traversal-reachability problem, no refresh/rename race.
- Per-group `claude` state (config, transcripts, sessions) stays isolated.
- `/usage` (pace) keeps working.

## Non-goals / anti-goals

- **Not** per-group *distinct* subscriptions. The subscription is **one company
  account**, shared by design (already `[DECIDED]` in the #373 spec, with the
  user's explicit acceptance that any group's agent can read the subscription
  token). Isolation protects **vault secrets** and **work files**, not the
  subscription auth.
- **Anti-goal:** reintroducing a writable on-disk credential any group user can
  reach. That is exactly the rename-race surface this removes.

## Design

### One token, injected as env, per spawn

- The subscription is provisioned **once** as a long-lived token via
  `claude setup-token` (browser OAuth on the operator's subscription; valid ~1
  year) and stored in the **vault** under the server-owned name
  **`MT_CLAUDE_OAUTH_TOKEN`** (done — ledger `[a95a]`). It is a **server-owned
  secret**, *not* a per-group vault slice and *not* a profile secret
  (invariant 31).
- At **every** agent spawn — commons/public **and** private/restricted — the
  privileged server injects it as **`CLAUDE_CODE_OAUTH_TOKEN`** through
  **`FORCED_CLAUDE_ENV`** (`src/session.ts`), i.e. **after** the
  `/^(CLAUDE|CLAUDECODE|AI_AGENT)/` env strip and **after** the profile's
  secrets. This is load-bearing: `CLAUDE_CODE_OAUTH_TOKEN` begins with `CLAUDE`,
  so the strip would otherwise remove it, and forcing it last means a profile
  cannot shadow or disable it (same discipline as the transcript-forcing env,
  invariant 29/31).
- Each group keeps its **own `CLAUDE_CONFIG_DIR`** (inside its HOME). The token
  never lands there; `claude` reads it from the environment on each run.

### What this removes from the #373 branch

The shared-file machinery becomes dead and should be removed with this change
(same PR — docs ship with the change that makes them wrong):

- `src/osusers.ts`: `SHARED_CRED_GROUP` (`shadok-cred`),
  `DEFAULT_SHARED_CREDENTIAL_PATH`, the symlink wiring (`credentialLink`),
  `groupadd shadok-cred` / `install -d … 0750` / `usermod -aG` / `chgrp`, and the
  credential **reachability** checks (ancestor-traversal, the four lstat shapes).
- `src/migrate-groups.ts`: `migSeedSharedCredential` and the commons-HOME symlink
  step.
- `src/server.ts`: the `SHADOK_SHARED_CREDENTIAL_PATH` wiring and the migration
  call that seeds/symlinks the shared credential.
- The red "Group isolation did NOT complete" banner no longer depends on a
  credential-seeding step that could only run post-sign-in (the fresh-instance
  bug this session already fixed from the other side).

Per-group HOME, per-group OS user, per-group vault slice, the privileged
drop-to-user spawn, and `CLAUDE_CONFIG_DIR` isolation all **stay** — they are
what isolate secrets and work files, independent of the auth path.

### `/usage` and `src/claude-creds.ts`

`/usage` (pace) authenticates centrally from the server, not per group. Today
`src/claude-creds.ts` reads `~/.claude/.credentials.json` for the token.
**Builder, verify:** after this change, point the usage path at the same
`MT_CLAUDE_OAUTH_TOKEN` (vault) / `CLAUDE_CODE_OAUTH_TOKEN` (env) the spawns use,
rather than a per-HOME credential file, so a group HOME with no credential file
does not break pace. (The server's own `CLAUDE_CODE_OAUTH_TOKEN`, if set for
`/usage`, is independent and does not collide — the vault secret has a distinct
name and is injected only into agent spawns.)

### Provisioning on a fresh instance

`setup-token` needs a browser OAuth step, so it cannot be fully automated. On a
fresh multi-tenant instance the operator runs `claude setup-token` **once** and
stores the result as `MT_CLAUDE_OAUTH_TOKEN`. Document this in the README
multi-tenant section and surface a clear boot/mode check: **if capable
(multi-tenant) and `MT_CLAUDE_OAUTH_TOKEN` absent, say so** (a named, actionable
message — spirit of `claudeStubMessage`) instead of letting group spawns fail
with a bare auth error.

### Expiry & rotation

- The token is valid ~1 year and is **static** (no refresh-to-disk), which is
  why the rename race disappears.
- A boot/daily check warns as expiry approaches; rotation is a manual re-mint via
  `claude setup-token`, re-stored under the same vault name. One operator action
  per year, versus the per-refresh cross-user race the old path fought.

## Isolation / security analysis

- The subscription token is **global by decision**. Within a single group's OS
  user it sits in the child env (`/proc/<pid>/environ`), readable by that same
  user — one trust domain, already accepted.
- **Across** groups it is isolated by **uid**: a different group's OS user cannot
  read another group's `/proc/<pid>/environ`. So the env route gives the same
  cross-group boundary the file route aimed for, without a shared writable file.
- The FD-descriptor route (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, 39× in the
  2.1.316 binary) would additionally keep the value out of `/proc/environ` for the
  **same** user. On this soft, same-user-within-a-group model that is a marginal
  hardening with real plumbing cost; **deferred**, not adopted. Recorded so a
  future hardening pass can pick it up.

## Verify-first (builder, before planning)

1. **Interactive, past onboarding, real turn.** The pre-flight proved interactive
   `claude` reaches onboarding (not login) on the env token. Confirm a **seeded**
   `CLAUDE_CONFIG_DIR` (the `claude-home.ts` onboarding seed) + env token drives a
   full interactive turn end-to-end under a **non-root** group user via the
   drop-to-user spawn — the real runtime shape.
2. **`/usage` on the env token** with no per-HOME credential file (above).
3. **tmux adopt path** (invariant 25/29): a server restart re-adopts an existing
   pane and **skips** the env re-application. Confirm the forced env token is
   present in panes created before a restart, or that re-adoption carries it —
   otherwise a long-lived agent could outlive a token rotation. (Same class as the
   transcript-strip-skipped-on-adopt note.)

## Testing

- Pure/unit: the spawn env assembly puts `CLAUDE_CODE_OAUTH_TOKEN` in
  `FORCED_CLAUDE_ENV` **after** the strip and after profile secrets (a profile
  carrying that name cannot shadow it). Mirror `test/…` forced-env coverage.
- Source-scan (server un-importable): the migration no longer references the
  shared-credential path / `shadok-cred` (locks the removal, invariant-24 class).
- End-to-end on mt373: a private group created **after** the old shared-token
  refresh window (which the old path would have left on an expired shared copy —
  ledger `[2d5c]`) authenticates fine, proving the race is gone.

## Rollout

#373 is on hold and not merged, so this is an in-branch revision, not a
migration off shipped behaviour. Removing the shared-file path and adding the
forced env token land together on `mt-isolated-groups`, with README +
`2026-10-29-…-design.md` updated in the same change.
