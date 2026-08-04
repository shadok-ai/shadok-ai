# Persistent per-container SSH identity (Docker) — design

Date: 2026-08-04 · Status: approved

## Goal

When shadok-ai runs **in a Docker container**, it should have its own SSH key
that **survives restart and recreate** — so agents can `git clone/push` private
repos over SSH and `ssh` into servers without re-provisioning a key on every
container lifecycle event. Each container gets its **own unique** key.

Explicitly **out of scope on the host**: on a normal (non-Docker) machine — e.g.
the developer's Mac — shadok must not touch `~/.ssh` at all.

## Constraints (why the obvious answer is wrong)

- The four production containers on vps1 already mount `shadok-data →
  /root/.shadok-ai` and that volume **survives `docker restart` AND `docker rm`
  + recreate** (it's where the auto-updated `app/`, secrets and channels live).
  `/root/.ssh` is **not** mounted → it lives in the ephemeral container layer →
  a plain `docker restart` keeps it, but any recreate (the normal way config or
  a pinned version changes) **wipes it**.
- We must **not** change the `docker run` command, rebuild the stale
  `shadok-ai:latest` image (pinned 0.1.131), or recreate the 4 existing
  containers to add a new volume. So the key must live on the volume that is
  **already** mounted: `/root/.shadok-ai`.

## Design

A new module `src/ssh.ts` exposing `ensureSshIdentity()`, called once at server
startup (in the `server.listen` callback in `server.ts`, next to the other boot
lines). It is a **no-op unless we're in a container**.

### Detection — Docker only

In-container iff **`/.dockerenv` exists** (Docker writes this file in every
container). No env var to add to `docker run`; nothing to configure. A
`SHADOK_FORCE_SSH_IDENTITY=1` escape hatch forces the behaviour on for tests /
non-Docker containerisation, and `SHADOK_SSH_IDENTITY=0` disables it entirely.

### On boot, in a container

1. Ensure `~/.shadok-ai/ssh/` exists, mode **700**. (On the `shadok-data`
   volume → persistent across restart + recreate.)
2. If `~/.shadok-ai/ssh/id_ed25519` is **absent**, generate it:
   `ssh-keygen -t ed25519 -N "" -f ~/.shadok-ai/ssh/id_ed25519 -C "shadok-<hostname>"`.
   Private key mode **600**, public **644**. One key **per container** (each has
   its own `shadok-data` volume) → unique identity for free.
3. Write `~/.shadok-ai/ssh/config` (if absent) with:
   ```
   StrictHostKeyChecking accept-new
   UserKnownHostsFile ~/.shadok-ai/ssh/known_hosts
   IdentityFile ~/.shadok-ai/ssh/id_ed25519
   IdentitiesOnly yes
   ```
   `accept-new` means the first `git clone`/`ssh` to an unknown host succeeds
   (recording its key) without a prompt and without a network keyscan at boot,
   while still refusing a **changed** host key later.
4. Wire `~/.ssh` to point at the persistent dir so plain `git`/`ssh` (which read
   `~/.ssh`) use the key with zero per-agent configuration:
   - If `~/.ssh` is **absent** → `symlink ~/.ssh → ~/.shadok-ai/ssh`.
   - If `~/.ssh` **exists and is already our symlink** → nothing.
   - If `~/.ssh` **exists as a real directory** (e.g. baked into the image with
     a `known_hosts`) → move its files into `~/.shadok-ai/ssh` **without
     overwriting** anything we just created, then replace `~/.ssh` with the
     symlink. Never delete a user file; on any doubt, leave `~/.ssh` as-is and
     fall back to exporting `GIT_SSH_COMMAND` for spawned agents (see below).
5. Log the public key once: `ssh identity: ssh-ed25519 AAAA… shadok-<host>`.

### How agents pick it up

Because `~/.ssh` is the persistent dir (symlink), `git@github.com:…` and
`ssh user@host` Just Work for every spawned `claude` — no per-agent env needed.
As a belt-and-suspenders fallback for the "couldn't safely symlink" branch, the
server also exports `GIT_SSH_COMMAND=ssh -F ~/.shadok-ai/ssh/config` into the
environment agents inherit, so git still uses the persistent key even if `~/.ssh`
was left untouched.

### Retrieving the public key (to register it)

Two zero-web-surface paths, no new endpoint:

- **Boot log**: the `ssh identity: …` line → `docker logs <name> | grep 'ssh identity'`.
- **On demand**: `docker exec <name> cat /root/.shadok-ai/ssh/id_ed25519.pub`.

The operator registers it as a **GitHub deploy key** (per private repo) or in
the target servers' `authorized_keys`. (A GUI display can come later if wanted;
deliberately not in this increment.)

## Module shape (testable)

`src/ssh.ts`:

- `sshPaths(home)` → `{ dir, key, pub, config, dotSsh }` — **pure**, unit-tested.
- `inContainer()` → boolean (`/.dockerenv` or env overrides) — thin, injectable.
- `planDotSshWiring(dotSshState)` → `"symlink" | "migrate-then-symlink" |
  "leave"` — **pure** decision from the state of `~/.ssh`, unit-tested. Keeps the
  irreversible filesystem move behind a decision that can be tested in isolation.
- `ensureSshIdentity({home, isContainer, log})` → orchestrates: side-effecting,
  idempotent, best-effort (never throws into the boot path — an SSH-setup
  failure logs and is swallowed, exactly like `writeJson` in `channels.ts`).

## Invariants / gotchas to record

- **Never overwrite or delete a file under `~/.ssh`.** The migrate branch copies
  only names that don't already exist in the target and never removes the
  originals until the symlink is in place; any error → leave `~/.ssh` alone and
  rely on `GIT_SSH_COMMAND`.
- **Host-safe.** No `/.dockerenv` → `ensureSshIdentity` returns immediately. The
  developer's Mac `~/.ssh` is never read, moved, or symlinked.
- **Idempotent.** Second boot finds the key + config and only re-asserts the
  symlink. Safe to run on every start.

## Testing

- `sshPaths` returns the right paths under a given home.
- `planDotSshWiring` covers: absent → symlink; already-our-symlink → leave;
  foreign symlink → migrate-then-symlink; real dir → migrate-then-symlink.
- `inContainer` honours the env overrides.
- An integration-style test of `ensureSshIdentity` against a temp `home`
  (with `isContainer: true` injected) asserts: key created (600), `config`
  written, `~/.ssh` symlinked to the persistent dir, and a second call is a
  no-op. `ssh-keygen` must be available on the CI runner (it is on
  ubuntu-latest); if absent, the test skips.

## Docs to update in the same PR

- `README.md`: a short "SSH identity in Docker" note (where the key lives, how
  to read the pubkey, that it persists on `shadok-data`).
- `CLAUDE.md`: `src/ssh.ts` row in the architecture map + the "never touch host
  `~/.ssh`" invariant.
- The `vps-shadok-ai-container.md` project memory: add the SSH key to the
  persistence map.
