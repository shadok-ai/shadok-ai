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
`sh -c`, in the CHANNEL's directory, with the vault secrets that resolve for
this agent injected as environment variables. On a multi-tenant instance it
runs as this agent's own OS user, exactly like the agent.

A secret reaches it two ways, and they are stored in different places: the
channel's **profile** lists it, OR the secret itself is bound to that profile —
or to “any profile” — from the web Secrets panel. The second kind reaches a
guard that has no profile at all, so never conclude "no profile, no secrets".

Its environment is otherwise SMALL on purpose: `PATH`, the locale and time
zone, proxy/CA settings, and `SHADOK_SESSION_ID` / `SHADOK_PORT` /
`SHADOK_SESSION_KEY` (send the key as `x-shadok-session-key` to call the local
API). Nothing else from the server's environment reaches it — no token, no
password, no cookie. A credential the check needs goes in the profile.

You can only schedule on an agent you may drive: on a multi-tenant instance,
yourself, a sibling of your own group, or a shared (public) agent.
A cron with a `check`, though, may only target YOURSELF (the check runs with the
target's secrets, so a guard on a sibling would hand you its credentials): the
server answers 403. A check-less cron on a sibling is fine.

So reference a secret by name (`$MY_API_KEY`) and trust it: never hardcode a
value into a check script, and never try to source a shell profile to get one.

The sharp edge is the other direction. A name nothing binds to this agent is
simply **absent** at run time — no error, and you find out at 6am rather than
now. A name that isn't in the vault, or that lives in a group this agent cannot
reach, is skipped just as silently. Your own shell having the key proves nothing
about the guard's.

So ask, before writing a check that needs a secret:

```
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs env
```

It asks the server what it would inject and prints the variable NAMES (never a
value): the secrets that resolve, the ones the profile asks for that do not, and
the whole environment. Two things follow from it being the server's answer and
not a guess:

- **Trust it over your own shell, and over this file.** It reads both halves of
  the secret↔profile link, which no client can.
- **Nothing in it waits for a reload.** The server re-reads the profiles and the
  vault at every tick, so a secret attached a minute ago is already there. A
  *Reload agent* changes only **your** process environment, not the guard's.

And if a guard still behaves as though a variable were missing, test the guard
itself — a one-minute schedule whose check is
`[ -n "$MY_KEY" ] && echo present` costs one wake-up and settles it. Printing a
presence test is fine; printing the value is not.

## Commands

```
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs add --schedule <spec> --prompt "<text>" [--check "<shell command>"] [--tz <zone>]
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs list
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs update <id> [--schedule <spec>] [--prompt "<text>"] [--tz <zone>]
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs del <id>
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs tz [<zone>|-]
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs env
```

`<spec>`: `every:30m` · `every:2h` · `daily:09:00` · `once:2026-08-25T08:42`.
Only on some days of the week: `daily:09:00@mon-fri`, `daily:08:30@mon,wed,fri`,
`daily:10:00@weekend` (English or French day names, ranges allowed).

`update` changes a schedule in place — its frequency, its prompt or its zone —
and keeps everything else, its guard included: `schedule.mjs update 3f2a9c1e
--schedule every:15m`. Use it instead of deleting and re-adding. It cannot
change a guard: for that, `del` then `add` (a guard is a shell command, so it
is always reviewed). `list`, `update`, `del`, `tz` and `env` run without a
permission prompt; `add` may ask.

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
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs add \
  --schedule once:2026-08-25T08:42 \
  --prompt "REMINDER — Alex is back today. Two documents have been stuck in generation since 18/08: …"
```

### Timezone — read this before scheduling a `daily` or a `once`

A `daily` runs at that wall-clock time **in a timezone**, and the default is
whatever the SERVER's machine is set to. On a machine running in UTC,
`daily:09:00` fires at 11:00 for someone in Paris — silently.

- `node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs tz` prints the timezone `daily` schedules actually use.
- `node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs tz Europe/Paris` pins it for every `daily` on this instance,
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
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs add \
  --schedule daily:09:00 \
  --check "python3 $HOME/.claude/skills/google-ads/scripts/check_budget.py" \
  --prompt "The monitoring detected a Google Ads budget anomaly. Write a clear, actionable alert for the team."
```

### Example — plain recurring report (runs every time)

```
node ~/.claude/skills/shadok-scheduler/scripts/schedule.mjs add --schedule daily:18:00 \
  --prompt "Review the day on the account and post a short summary."
```

After creating a schedule, confirm to the user in plain language: what it watches,
when it runs, and that quiet runs won't cost tokens (if a check was set).

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
