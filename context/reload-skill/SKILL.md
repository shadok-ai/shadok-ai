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
