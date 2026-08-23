---
name: shadok-scheduler
description: Schedule recurring prompts (monitoring, reporting, watching) for the CURRENT shadok-ai channel — with an optional deterministic "check" that runs WITHOUT the LLM so routine "nothing to report" runs cost ZERO tokens. Use whenever the user asks to monitor / report / watch / alert on something on a recurring basis (every N minutes, hourly, daily, each morning…).
---

# shadok-scheduler

Turn a natural-language request like *"watch the Google Ads budget every morning
and alert me when a cap is exceeded"* into a token-efficient scheduled job on
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

### What a check can see — secrets and cwd

A check does **not** run inside this agent's process. The server runs it with
`sh -c`, in the CHANNEL's directory, with the secrets of the channel's
**profile** injected as environment variables.

So reference a secret by name (`$MY_API_KEY`) and trust it: never hardcode a
value into a check script, and never try to source a shell profile to get one.

The sharp edge is the other direction. A channel with **no profile**, or a
profile that doesn't list that name, gets **nothing** — the variable is simply
absent, and you find out at 6am rather than now. A name that isn't in the vault
is skipped just as silently. Your own shell having the key proves nothing about
the guard's.

`schedule.mjs env` prints exactly what a guard gets here. Run it before writing a
check that needs a secret.

## Commands

```
node scripts/schedule.mjs add --schedule <spec> --prompt "<text>" [--check "<shell command>"] [--tz <zone>]
node scripts/schedule.mjs list
node scripts/schedule.mjs del <id>
node scripts/schedule.mjs tz [<zone>|-]
node scripts/schedule.mjs env
```

`<spec>`: `every:30m` · `every:2h` · `daily:09:00` · `once:2026-08-25T08:42`.

### One-shot — a reminder on a given date

`once:<YYYY-MM-DDTHH:MM>` fires **exactly once**, then the schedule is left in
the list disabled and marked `(fired)` — so you can see it ran, and delete it
when you want.

Use it whenever the user asks to be reminded or warned **on a date** ("warn Alex
on the 25th", "remind me on Monday morning"). Do NOT reach for the harness's own
one-shot scheduler for that: it lives in the agent's process and dies with it,
whereas this one is on disk and survives a restart, an auto-update, and a
container recreate.

Two behaviours worth knowing:

- A date already in the past is **refused**, not silently accepted.
- A slot missed while the server was down still fires **late**, at the next
  tick. A reminder arriving late beats a reminder that vanished — the prompt
  carries its own date, so say in it what it is about and when it was for.

```
node scripts/schedule.mjs add \
  --schedule once:2026-08-25T08:42 \
  --prompt "REMINDER — Alex is back today. Two documents have been stuck in generation since 18/08: …"
```

### Timezone — read this before scheduling a `daily` or a `once`

A `daily` runs at that wall-clock time **in a timezone**, and the default is
whatever the SERVER's machine is set to. On a machine running in UTC,
`daily:09:00` fires at 11:00 for someone in Paris — silently.

- `schedule.mjs tz` prints the timezone `daily` schedules actually use.
- `schedule.mjs tz Europe/Paris` pins it for every `daily` on this instance,
  including the ones already scheduled (they're realigned immediately).
- `--tz Europe/Paris` on `add` pins one schedule only.

When the user names an hour and you're not sure the server sits in their
timezone, check with `tz` first — `list` shows the zone next to each schedule.
An interval (`every:30m`) is a duration, so it has no timezone.

A `once` date is read in that same timezone at CREATION and stored as an
absolute instant. Changing the instance timezone afterwards realigns the
`daily` schedules but **not** a `once` — its instant was already arbitrated.
So check `tz` BEFORE scheduling a dated reminder, not after.

### Example — guarded monitoring (near-zero tokens)

```
node scripts/schedule.mjs add \
  --schedule daily:09:00 \
  --check "python3 $HOME/.claude/skills/google-ads/scripts/check_budget.py" \
  --prompt "The monitoring detected a Google Ads budget anomaly. Write a clear, actionable alert for the team."
```

### Example — plain recurring report (runs every time)

```
node scripts/schedule.mjs add --schedule daily:18:00 \
  --prompt "Review the day on the account and post a short summary."
```

After creating a schedule, confirm to the user in plain language: what it watches,
when it runs, and that quiet runs won't cost tokens (if a check was set).
