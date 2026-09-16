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

Two limits, and they are not bugs to work around:

- **Only a secret you created.** Any other name — one a human typed, one another
  role stored — is refused. You never held that value, and the vault is shared
  by every profile on this machine.
- **Only your own profile.** There is no way to attach a secret to someone
  else's role, the lead included.

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

`$SHADOK_AUTH` (a cookie) is still accepted, but it was frozen into your
environment at spawn and expires after a week, so never rely on it alone. A
`401` means that header is missing — or that you were started before this
existed, in which case nothing you hold can authenticate any more and only a
human can fix it: ask them for *Reload agent* on your ⋯ menu.
