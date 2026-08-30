---
name: shadok-reload
description: Reload (respawn) your OWN agent session to pick up a changed pilot prompt or newly-seeded skills — for example after an operator enables a feature. You keep your history (it is a resume), you just come back as a fresh process with the new prompt/skills active. Use when told a change won't take effect until you reload, or when you (a lead) refresh an agent.
---

# shadok-reload

The cockpit pilot prompt and the bundled skills are fixed **at spawn**, so a
change to either only lands at the next (re)spawn. This reloads **your own**
session in place — a `claude --resume`, so your transcript is kept:

```
node ~/.claude/skills/shadok-reload/reload.mjs
```

Only your own session can be reloaded this way: it is scoped by the per-session
key in your environment (`SHADOK_SESSION_KEY`), not by the public session id.
Your current turn ends as the process is replaced; you come back with your
history intact and the new prompt/skills active.

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
