# An agent can put a secret it obtained into the vault

Date: 2026-08-09
Status: validated, ready for an implementation plan

## Problem

An agent regularly ends up **holding a credential it obtained itself**: it ran
`gh auth login`, provisioned a database, created an API key with a vendor CLI.
Today that credential dies with the session. The next agent re-authenticates
from scratch, and in a container — where there is no OS keyring to fall back on
— it may not be able to at all.

The vault already exists for exactly this (`~/.shadok-ai/secrets.json`, 600,
injected as env at spawn), but nothing connects the two: an agent has no idea it
can write to it.

Note what this is **not**: the user pasting a secret into the chat. That case was
considered and left out — the value would be written into the transcript, the
Telegram history and the screen, which is a different problem needing a
different answer (Telegram's `/secret` already solves it by deleting the
message).

## What is actually missing

Almost no plumbing. `PUT /secrets` exists, and every agent already carries
`SHADOK_AUTH` in its environment, so an agent could `curl` the vault **today**.
Three things are missing, and only three:

1. it does not know it can;
2. there is no path that keeps the value out of the transcript and out of `ps`;
3. overwriting is unguarded — a machine could silently replace a real credential.

So: one guard and one skill. No new subsystem.

## 1. The guard — no silent overwrite

`PUT /secrets` overwrites blindly. It now refuses a name that already exists,
answering `409 { error: "exists", name }`, unless the request explicitly carries
`overwrite: true`.

The two **human** surfaces pass that flag, because a person looking at the vault
list and clicking Save is acting deliberately:

- the web Secrets panel (`public/index.html`, both `PUT /secrets` call sites);
- Telegram's `/secret NAME value` — which needs **no change at all**: it calls
  `setSecret()` directly, not the endpoint.

That last point is what makes the boundary honest rather than decorative: an
agent is a separate process, so **HTTP is the only way it can reach the vault**.
Guarding the endpoint guards exactly the machine path, and nothing else.

Pure core, unit-tested:

```ts
secretWriteVerdict(exists: boolean, overwrite: boolean): "created" | "updated" | "refused"
```

## 2. The skill — `shadok-secrets`

Versioned in `context/secrets-skill/`, installed and refreshed at boot beside
`seedSchedulerSkill()` — the same pattern, for the same reason: server-owned,
overwritten each boot so it tracks the running build.

`scripts/secret.py` offers `list` and `set`. **There is no `get`.** Values are
never readable back out of the vault, by anyone; keeping that true is worth more
than any convenience it would buy.

The rules it carries are the actual substance:

- **The value arrives on stdin, never as an argument.** `argv` is world-readable
  through `ps`, so a token passed as a parameter leaks to every process on the
  machine. The agent pipes the producing command straight in:
  `gh auth token | secret.py set GITHUB_TOKEN --stdin`.
- Never print it, never write it into a file in the working directory, never
  repeat it in the reply. The chat is a transcript on disk.
- A name that already exists → the script reports the refusal and stops. The
  agent tells the user and lets them decide; it does not retry with `overwrite`.
- Once stored, the agent states **the name** and adds that a secret only reaches
  an agent once it is attached to a profile in the Profiles panel.

## 3. Visibility

No new UI. The name appears in the Secrets panel, and the agent announces it in
the chat. A secret stored in silence is a secret nobody knows to revoke — the
announcement is the feature, not politeness.

## Testing

- `secretWriteVerdict` — pure, three cases.
- `PUT /secrets` — creates; refuses an existing name with 409; updates it with
  `overwrite: true`.
- `secret.py` — `set --stdin` sends the value in the body and never places it in
  `argv`; a 409 exits non-zero with a readable message.
- Browser: saving an existing secret from the Secrets panel still works (it
  passes `overwrite`), per `CLAUDE.md`'s rule that a runtime change is verified
  in a browser, side by side on a free port.

## Deliberately out

- **Reading a value back.** Not now, not behind a flag.
- **Attaching the secret to a profile.** Without it the secret is inert, which is
  why the agent must say so — but doing it from an agent means letting a machine
  decide which credentials reach which roles, and that deserves its own design.
- **A per-profile "may write secrets" permission.** The write is already
  reachable by `curl` from any agent, so the flag would be theatre until that
  path is closed too.
