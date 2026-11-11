---
name: shadok-report
description: Ask an admin for help when you are STUCK on something only a human can fix — a token that expired or answers 401/403 (Linear, Slack, GitHub, the Claude API…), a credential or access you were never given, a broken tool or a shadok bug. The admins get a notification. Use it instead of failing silently or retrying for ever.
---

# shadok-report

Nobody may be watching your chat — you may be running on a schedule, or the
person who started you may have left. When you hit a wall only a human can
remove, **report it**: every admin of this cockpit gets a badge and a sound, and
the Telegram owner gets a DM.

```bash
node ~/.claude/skills/shadok-report/scripts/report.mjs --kind access --secret LINEAR_API_KEY \
  "Linear token expired" <<'BODY'
GET https://api.linear.app/graphql → 401 "Authentication required".
I was triaging the sprint board; nothing was written.
BODY
```

- **title** (the argument): one line, what is wrong. Same title again = the
  same report (the admins see `×2`, not a second card), so keep it stable while
  the problem is the same.
- **`--kind`**: `access` (a credential missing, expired or refused), `bug`
  (something is broken — the default), `blocked` (anything else stopping you).
- **`--secret NAME`**: with `access`, the environment variable concerned
  (`LINEAR_API_KEY`, `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`…). The admin gets a
  button that opens the vault on that name. The **name only — never the value.**
- **body** (stdin as above, or `--body "…"`, optional): the error you got, what you were doing, what
  you already tried. Short and factual.

## Rules

- **Never put a secret value in a report** — no token, no key, no password,
  not even partially. Name the variable; that is enough.
- **Report once, then move on.** Don't loop on the same failure: report, tell
  the person in your chat (if any) that you asked an admin, and do whatever
  else you can without that access. A reload may be needed once the admin
  fixes the secret — they will tell you, or reload you.
- **Not for questions the person in front of you can answer.** If someone is
  talking to you, ask them first. This is for what nobody in the conversation
  can fix.

## If it fails

`403` means your session key is missing or you predate this feature: say so in
your chat and ask for *Reload agent*. `429` means you already filed many reports
this hour: stop filing, wait.
