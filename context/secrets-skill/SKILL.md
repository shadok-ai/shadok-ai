---
name: shadok-secrets
description: Store a credential you OBTAINED yourself (a CLI login, a provisioned key, an API token you just created) in shadok-ai's secret vault, so the next agent doesn't have to obtain it again. Use when you end a task holding a credential that outlives the session. Never for a secret the user typed in the chat.
---

# shadok-secrets

You sometimes finish a task **holding a credential**: you ran `gh auth login`,
provisioned a database, created an API key with a vendor CLI. That credential
dies with your session, and the next agent starts from nothing — in a container,
where there is no OS keyring, it may not be able to start at all.

Put it in the vault instead.

Only works inside a shadok-ai agent — it needs `SHADOK_PORT` in the env (set
automatically). If it is missing, say so rather than improvising.

## Store it

```bash
gh auth token | node ~/.claude/skills/shadok-secrets/scripts/secret.mjs set GITHUB_TOKEN --stdin
node ~/.claude/skills/shadok-secrets/scripts/secret.mjs list
```

## Keep it for yourself — attach it to your profile

A stored secret reaches nobody until it is attached to a profile. You can attach
a secret **you stored yourself** to **your own** profile, and then reload to get
it:

```bash
gh auth token | node ~/.claude/skills/shadok-secrets/scripts/secret.mjs set GITHUB_TOKEN --stdin --attach
node ~/.claude/skills/shadok-reload/reload.mjs    # comes back with it in the env
```

It is injected as an environment variable **at your next reload**, not into the
process you are running now — the environment of a live process cannot change.

## Another role needs it — name it when you store it

You provisioned a credential a DIFFERENT agent needs (the one you are about to
launch, a role that does the nightly import). Name that role in the same
command — one write, bound at creation:

```bash
gh auth token | node ~/.claude/skills/shadok-secrets/scripts/secret.mjs set GITHUB_TOKEN --stdin --profile Importer --profile Reviewer
```

`--profile` is repeatable, and it works **only on the creation**: you are the
one who obtained the value, so you may say who needs it. Changing a binding
afterwards is a person's decision, from the vault panel — by then other roles
depend on it, and it is no longer only yours to move.

Say in your reply which roles you bound it to. They receive it at their **next
spawn**, so an agent already running needs a reload.

Three limits, and they are not bugs to work around:

- **Only a secret you created.** Any other name — one a human typed, one another
  role stored — is refused. You never held that value, and the vault is shared
  by every profile on this machine.
- **Only at creation.** Re-binding an existing secret, yours included, is
  refused: ask the user, they do it from the vault panel in two clicks.
- **Never the role strangers run on.** A guest door's guests all run the SAME
  profile, so a credential there is one handed to every stranger. Refused, and
  a guest's own agent names no role at all.

If you need a secret you did not create, ask the user: they attach it from the
web Profiles panel in two clicks.

## The rules — these are the point

- **Pipe the value in. Never put it in the command.** `ps` shows every
  process's arguments to every user on the machine, so a token as an argument
  leaks. `--stdin` is required precisely so there is no other way.
- **Never print it, ever.** Not in your reply, not in a log line, not into a
  file in the working directory. Your reply is written to a transcript on disk
  and may be mirrored to Telegram.
- **You cannot read a value back.** There is no `get`, by design. `list` shows
  names only.
- **A name that already exists is refused.** That is deliberate: overwriting
  replaces a live credential with nothing to show it happened. Do not retry, do
  not work around it — tell the user the name is taken and let them choose.
- **Say what you stored.** Name the secret in your reply, and say whether you
  attached it to your profile. A secret stored in silence is one nobody knows to
  revoke.

## Not for this

A secret the **user typed in the chat** is already exposed — it is in the
transcript, and in Telegram's history. Storing it does not un-expose it. Point
them at the web Secrets panel, or Telegram's `/secret NAME value`, which deletes
their message afterwards.

## Authenticating a direct API call

The commands above do this for you. If you call the cockpit's API yourself, send
your session key — it is in your environment and it does not expire:

```bash
curl -sS -H "x-shadok-session-key: $SHADOK_SESSION_KEY" \
  "http://127.0.0.1:$SHADOK_PORT/channels"
```

That key is your ONLY credential, and it does not expire. You are no longer
handed a cookie or the cockpit password, and a call made with the key is made
as YOU — an agent of your own group, never an admin: account, backend and
other cockpit-admin routes answer `403`, and so do the person-only (browser)
ones. That is by design; ask the human when you need one of those. A
`401` means that header is missing — or that you were started before this
existed, in which case nothing you hold can authenticate any more and only a
human can fix it: ask them for *Reload agent* on your ⋯ menu.
