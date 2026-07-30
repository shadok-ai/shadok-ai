# Agent profiles — design

Date: 2026-07-23 · Status: proposed

## Goal

Named agent **profiles** (dev, paid-marketing, support…) applied at spawn, each
with its own **secrets** (env), a **role** (system prompt), a **model**, and
native Claude **permission guardrails** (e.g. a marketing agent can read the
code but cannot `git commit`/`push`). Lets a "swarm" of differently-scoped
agents work on the same project.

## Isolation level (decided): SOFT

Agents run as the same OS user, so this is a **convenience + guardrail** layer,
NOT a security sandbox: a determined agent can read another's secrets (files
*and* env, via `ps eww`). We document this and don't put must-never-leak secrets
in shadok-ai. Real isolation (containers / dedicated users) is an explicit
non-goal here.

## Mechanism (confirmed against Claude Code 2.1.x)

All applied as **CLI flags at spawn** — nothing written into the worktree:

- `--append-system-prompt "<role text>"` — the profile's role/context.
- `--settings '{"permissions":{"deny":[…],"allow":[…]}}'` — inline permission
  rules (claude ≥ 2.1.181). Deny patterns like `Bash(git commit:*)` block
  `git commit …`, compound commands (`x && git commit`), and wrapped forms
  (`env git commit`); read-only git (status/diff/log) still runs.
- `--model <model>` — optional per-profile model.
- **Secrets**: env injection (existing `makePilot`), merged repo ⊕ profile.

## Data model

`~/.shadok-ai/profiles.json` — **global** (a profile is reusable across repos):

```jsonc
[
  {
    "name": "marketing",
    "systemPrompt": "You are the paid-marketing agent for biosense. …",
    "deny": ["Bash(git commit:*)", "Bash(git push:*)", "Bash(git add:*)",
             "Bash(git reset:*)", "Bash(git rebase:*)", "Bash(git merge:*)"],
    "allow": [],
    "secrets": { "META_ADS_TOKEN": "…" },
    "model": null
  }
]
```

A built-in **`read-only` preset** (the git-deny list above) is offered in the UI
so a new profile starts guarded.

## Components

| File | Responsibility |
|---|---|
| `src/profiles.ts` | Store (`loadProfiles`, `getProfile`, `upsertProfile`, `removeProfile`, 600). Pure `profileArgs(profile)` → the `--append-system-prompt/--settings/--model` argv, and `mergeSecrets(repoSecrets, profile)`. Unit-tested. |
| `src/server.ts` | `makePilot`/spawn takes a profile name: prepends `profileArgs` to the claude args and merges the profile's secrets into the env. The session's profile is stored on the channel (`channel.profile`) so **restart/resume re-applies** the same guardrails + role. `GET/PUT/DELETE /profiles`. |
| `src/channels.ts` | `Channel` gains `profile?: string`. |
| `src/telegram.ts` | `/spawn <profile> <name>` (profile optional). `/profiles` lists them. |
| `public/index.html` | Profile selector when creating a channel; a "Profiles" management panel (name, role, deny list w/ read-only preset, secrets, model). |

## Spawn flow

`start { …, profile? }` → server resolves the profile → args =
`[...profileArgs(profile), ...sessionArgs]`, env = `secretsForCwd(cwd)` merged
with `profile.secrets` (profile wins). On resume/restart, the server reads
`channel.profile` and re-applies — the guardrails aren't lost across restarts.

## Interfaces

- **Telegram**: `/spawn marketing outreach` → a worktree agent with the
  marketing role + no-commit guardrail + marketing secrets. `/profiles` lists.
- **Web**: pick a profile in the new-channel form; manage profiles in a panel.
- Both show the same profiles (global store).

## Testing

- `profileArgs`: correct argv for role/deny/allow/model; empty profile → no
  extra args; the deny JSON is valid and shell-safe (each arg is a single token).
- `mergeSecrets`: profile overrides repo on key conflicts.
- Regression: a session with a profile keeps it across restart (channel.profile).

## Non-goals

- Real per-agent isolation (containers / dedicated OS users). Soft only.
- Enforcing the role beyond Claude's own compliance + the deny rules.
- Per-repo profiles (global for now; a profile can still carry repo-specific
  secrets if needed).
