---
name: shadok-scheduler
description: Schedule recurring prompts (monitoring, reporting, watching) for the CURRENT shadok-ai channel — with an optional deterministic "check" that runs WITHOUT the LLM so routine "nothing to report" runs cost ZERO tokens. Use whenever the user asks to monitor / report / watch / alert on something on a recurring basis (every N minutes, hourly, daily, each morning…).
---

# shadok-scheduler

Turn a natural-language request like *"surveille le budget Google Ads chaque matin
et alerte-moi si un plafond est dépassé"* into a token-efficient scheduled job on
**this channel**.

Only works inside a shadok-ai channel — it needs `SHADOK_SESSION_ID` and
`SHADOK_PORT` in the env (set automatically). If they're missing, tell the user
this must be run from inside a shadok-ai session.

## The token-efficient pattern — DO THIS

Never schedule a bare LLM prompt for monitoring: it burns tokens every run even
when nothing changed. Instead, split detection (free) from wording (rare):

1. **Write a check script** that prints **nothing** when everything is fine, and a
   short line **only** when there is something to report (a threshold crossed, an
   error, a meaningful change). Prefer reusing existing skill scripts (e.g.
   `~/.claude/skills/google-ads/scripts/…`) for the data. Save it somewhere
   durable (a skill's `scripts/` dir). Test it once: it should be silent on a
   normal day.
2. **Register a cron** with that check plus a short alert prompt. The server runs
   the check on schedule (0 tokens); the agent is woken **only** when the check
   prints something, and receives that output prepended to the prompt.

Result: quiet days cost nothing; the LLM is spent only to word a real alert.

For pure reporting where you WANT output every run (e.g. a daily figures digest),
omit the check — the prompt runs every time.

## Commands

```
python3 scripts/schedule.py add --schedule <spec> --prompt "<text>" [--check "<shell command>"] [--tz <zone>]
python3 scripts/schedule.py list
python3 scripts/schedule.py del <id>
python3 scripts/schedule.py tz [<zone>|-]
```

`<spec>`: `every:30m` · `every:2h` · `daily:09:00`.

### Timezone — read this before scheduling a `daily`

A `daily` runs at that wall-clock time **in a timezone**, and the default is
whatever the SERVER's machine is set to. On a machine running in UTC,
`daily:09:00` fires at 11:00 for someone in Paris — silently.

- `schedule.py tz` prints the timezone `daily` schedules actually use.
- `schedule.py tz Europe/Paris` pins it for every `daily` on this instance,
  including the ones already scheduled (they're realigned immediately).
- `--tz Europe/Paris` on `add` pins one schedule only.

When the user names an hour and you're not sure the server sits in their
timezone, check with `tz` first — `list` shows the zone next to each schedule.
An interval (`every:30m`) is a duration, so it has no timezone.

### Example — guarded monitoring (near-zero tokens)

```
python3 scripts/schedule.py add \
  --schedule daily:09:00 \
  --check "python3 $HOME/.claude/skills/google-ads/scripts/check_budget.py" \
  --prompt "Le monitoring a détecté une anomalie budget Google Ads. Rédige une alerte claire et actionnable pour l'équipe."
```

### Example — plain recurring report (runs every time)

```
python3 scripts/schedule.py add --schedule daily:18:00 \
  --prompt "Fais le point de la journée sur le compte et poste un court résumé."
```

After creating a schedule, confirm to the user in plain language: what it watches,
when it runs, and that quiet runs won't cost tokens (if a check was set).
