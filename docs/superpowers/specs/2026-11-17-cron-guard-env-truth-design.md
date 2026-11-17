# `what will my guard see?` — one honest answer

## The problem

The scheduler skill's `schedule.mjs env` exists to answer one question: will my
scheduled check see `$MY_KEY`? It answered by reading the channel's profile and
diffing its `secrets` list against the names `GET /secrets` returns.

That is half of the link. A secret↔profile binding has two writable homes
(invariant #73):

- the **profile's** `secrets` list — `PUT /profiles`, and `PUT /profiles/secret`
  when an agent attaches a secret it created;
- the **secret's** `profiles` list — `PUT /secrets/profiles`, which is what the
  vault panel's chip row and the grouped add form write.

`secretsForProfile` merges both, so both work at run time. A reader of one side
reports the other as absent. Two false negatives followed:

1. a secret bound from the vault side reached the guard and was reported
   missing;
2. an `ANY_PROFILE` (`*`) binding reaches an agent with **no** profile, which
   the tool answered with `guard secrets: NONE — this channel has no profile`.

False negatives are the expensive direction. An agent trusted the tool instead
of testing its guard, reported the credential as missing, and the operator went
looking for a fault that did not exist. Running the guard printed the variable
the tool had just called absent.

Two things the skill could not have got right on its own, which is why the fix
is not "read the other list too":

- `GET /secrets` **withholds** the `profiles` field from an agent viewer for
  commons secrets (`mainWritable` is false for an agent), so the vault side was
  unavailable, not merely unread;
- whether a name resolves depends on the **agent's group** (own → shared-in →
  commons). A caller cannot derive that from the names it happens to see.

## The shape

One builder, two callers.

`cronGuardEnv(sessionId, target)` is extracted out of `runCronCheck` and returns
`{ env, user, secrets }` or a refusal. `runCronCheck` calls it; so does the new
`GET /crons/env?session=<id>`, which answers with the values stripped:

```
{ cwd, known, profile, profileMissing, secrets[], unresolved[], env[], user }
```

- `secrets` — the names that actually resolve, both homes merged;
- `unresolved` — names the profile asks for that do not resolve (a typo, or a
  secret owned by a group this agent neither belongs to nor was lent). This is
  the diagnostic no caller can compute;
- `env` — every variable NAME the guard gets, plumbing included. The allow-list
  is short and invisible from the agent's own shell, so "does my guard even have
  `TZ`?" is a real question.

Names only, never a value — which is what makes it safe for the agent whose
guard it is to call. Scoped by `mayActFor`, exactly like `GET /crons` (whose
payload already carries another group's guard command).

## Decisions

**A server route rather than a dry run.** The agent's own suggestion was to
execute a guard for real and print the names present. A dry run would also
exercise the `setpriv` drop and the empty HOME — genuinely more coverage — but it
spawns a process on a GET, and the question asked is about names. The same
builder with values stripped cannot drift from the real tick, which is the
property that failed here.

**No propagation story.** `cronGuardEnv` reads `profiles.json` and the vault on
every call, so there is no cache and no delay to display: the answer is what the
next tick gets. The skill now says so, because the alternative is the next agent
inventing a reload that does not exist (a *Reload agent* refreshes the agent's
own spawn env, never the guard's).

**The old computation is kept as a fallback, not deleted.** Skills are re-seeded
from the running build at every boot, so normally script and server move
together — except that the machine-wide skill tier is written by whichever
cockpit booted last, so on a host running several instances this script can meet
an older server. A 404 degrades to the profile-side answer **and says it is
half-blind**, instead of aborting the command.

## Locks

- `context/scheduler-skill/test/schedule.test.mjs` — the chip-bound secret
  appears, the `*` secret appears with no profile, `unresolved` is printed, the
  404 path degrades with its warning, and `/profiles` is no longer consulted.
  Making `cmdEnv` take the legacy path turns the first three red.
- `test/route-guards.test.ts` — the route is gated before it resolves anything,
  it sends `Object.keys(...)` and never the value-carrying objects, and
  `runCronCheck` no longer builds an env of its own. Re-inlining `cronCheckEnv({`
  into the tick turns the last one red.
