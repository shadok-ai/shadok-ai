# Per-repo secrets — design

Date: 2026-07-23 · Status: approved

## Goal

Give agents the secrets they need (API keys, tokens) **without ever writing them
into the project directory** (repo/worktree) where they could be committed or
leaked. Secrets live outside any repo and are injected as environment variables
into the agent process at spawn.

## Decisions (locked)

- **Storage:** `~/.shadok-ai/secrets.json`, mode 600 (outside every repo).
- **Injection:** environment variables passed to the `claude` process at spawn.
  Nothing is written to the worktree.
- **Scope:** per repo. An agent gets the secrets of the repo its cwd belongs to.

## Data model

```jsonc
// ~/.shadok-ai/secrets.json (chmod 600)
{
  "/Users/me/projects/app":      { "OPENAI_API_KEY": "sk-…", "DB_URL": "…" },
  "/Users/me/projects/other":    { "STRIPE_KEY": "…" }
}
```

Keyed by the **main repo root**. A worktree agent resolves to its main repo, so
all worktrees of a repo share its secrets.

## Repo resolution

`resolveRepo(cwd)` = `dirname(git -C cwd rev-parse --git-common-dir)` — the main
repo root, worktree-safe (a linked worktree's common-dir points at the main
`.git`). Falls back to `cwd` when it isn't a git repo.

## Components

| File | Responsibility |
|---|---|
| `src/secrets.ts` | The store: `loadStore`, `secretsForRepo`, `secretsForCwd`, `setSecret`, `deleteSecret`, `secretKeys`, `resolveRepo`. 600 perms. Pure helpers (`mergeSecret`, `dropSecret`) unit-tested. |
| `src/server.ts` | `makePilot` resolves `secretsForCwd(cwd)` and passes it as the pilot `env`. Endpoints `GET /secrets?repo` (keys only, never values), `PUT /secrets` (set), `DELETE /secrets` (remove). |
| `src/tmux.ts` | Inject `opts.env` as `KEY=VALUE` entries in the `env …` command that launches claude (PtyPilot already merges `opts.env`). |
| `public/index.html` | A small "Secrets" panel for the active session's repo: lists keys (values never shown), add `KEY`+value, remove a key. |

## Security

- The file is 600; values are never returned by `GET /secrets` (keys only) and
  never logged. The web UI shows keys, not values (write-only input).
- Env injection means the agent (and anything it runs) can read the secrets —
  that's the point. It's the agent's responsibility not to write them to the
  repo; we simply never put them there ourselves.
- Endpoints are localhost-only (same as the rest of the server).

## Non-goals

- macOS Keychain backend (chosen the file for portability; the store is behind
  an interface so a keychain backend can be added later).
- Global or per-session scope (per-repo only for now).
- Secret rotation / expiry.
