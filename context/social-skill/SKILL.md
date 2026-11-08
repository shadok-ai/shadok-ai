---
name: shadok-social
description: Post on LinkedIn (or another social network) for the person you are talking to. Use when they ask you to post, publish or share something on LinkedIn or social networks.
---

# shadok-social

Publishes a post on a LinkedIn account the person connected in the cockpit.
You never hold the account's token and it is never available to you — do not
look for it. The server publishes on your behalf.

## Steps

1. **Pick the account.**

   ```bash
   node ~/.claude/skills/shadok-social/scripts/social.mjs accounts
   ```

   One line per account: `<id>  <label>  <provider>  policy=<policy>  expires=<date>`.
   If none is listed, tell the person to connect one in Secrets → Connected
   accounts. If an account is marked `EXPIRED`, say so; they must reconnect it.

2. **Show the final text in the chat FIRST**, exactly as it will be posted, and
   wait for their go-ahead if they have not already approved it.

3. **Post it.** The text goes through stdin, never argv:

   ```bash
   node ~/.claude/skills/shadok-social/scripts/social.mjs post --account <id> [--image /abs/path.png] --stdin <<'EOF'
   the exact text
   EOF
   ```

   `--image` must be an absolute path. The limit is 3000 characters.

## Never claim it is published until you are told

With `policy=approve` the post is only a **draft** waiting for the person to
approve it in the cockpit. The command says so ("Draft … is waiting for
approval"). Do not say it is published: a hidden notice reaches you when it is
published or discarded. Only a printed URL means it is already live.

If the server refuses, the script prints its sentence and exits 1 — relay it
as it is, and do not retry in a loop.

## Authenticating a direct API call

The command above does this for you. If you call the cockpit's API yourself,
send your session key — it is in your environment and it does not expire:

```bash
curl -sS -H "x-shadok-session-key: $SHADOK_SESSION_KEY" \
  "http://127.0.0.1:$SHADOK_PORT/social/accounts"
```

That key is your ONLY credential, and it does not expire. You are no longer
handed a cookie or the cockpit password, and a call made with the key is made
as YOU — an agent of your own group, never an admin: account, backend and
other cockpit-admin routes answer `403`, and so do the person-only (browser)
ones such as approving a draft. That is by design; ask the human. A
`401` means that header is missing — or that you were started before this
existed, in which case nothing you hold can authenticate any more and only a
human can fix it: ask them for *Reload agent* on your ⋯ menu.
