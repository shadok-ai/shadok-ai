# A secret only reaches an agent through a profile

Date: 2026-08-01
Status: agreed, implemented

## The symptom

"Agents struggle to find the environment variables."

## What the diagnosis showed

Measured on the real installation, not inferred:

1. **The injection mechanism works.** `TmuxPilot` prefixes the command with
   `env KEY=VALUE …`; on a live production agent, `SHADOK_PORT` and
   `SHADOK_SESSION_ID` are indeed present in the process's environment.
2. **But nothing real is injected.** The vault held 5 secrets and **no profile
   referenced a single one** (`secrets: []` everywhere).
   `secretsFor(profile?.secrets)` only injects what a profile references: so the
   agents had, literally, no secrets. Nothing in the UI said that a defined
   secret is useless until it is attached.
3. **And the preprompt lied.** `makePilot` called
   `envVarsNote(Object.keys(env))` **after** adding the internal plumbing. So the
   note a production agent received was:

   > `Secrets available to you as environment variables: SHADOK_SESSION_ID, SHADOK_PORT`

   The plumbing was announced as secrets never to be displayed, and a real secret
   would have drowned in there.

4. **The reload works** (a question asked at the same time): the claude process's
   pid changes on every restart — verified three times in a row. A first probe
   said otherwise: that was an artefact, `ps` truncates arguments at 120
   characters on macOS. The tmux pane's start command
   (`#{pane_start_command}`) gives the full line.

## The fixes

### 1. The note only speaks of real secrets

`makePilot` separates `secretEnv` (the resolved vault secrets) from the full env,
and announces only the former. The names are the **resolved** ones: a profile
referencing a secret absent from the vault no longer makes the agent promise a
variable that does not exist. No secret attached → **no note**, rather than a
misleading one. Nothing depended on the `SHADOK_*` announcement: the skills read
`process.env.SHADOK_PORT` in their own code.

### 2. An actionable note

The old wording ("Read them from the environment") let the agent go hunting for a
file to load, then conclude the secret was missing. The new one heads that off:
the variables are **already set** in every Bash tool command, there is **no
`.env`** to load and nothing to source; one usage example; and the presence test
that does not reveal the value (`[ -n "$NAME" ] && echo set`).

### 3. The Secrets popin says what it is for

A paragraph in the alert tint: a secret reaches no agent on its own, it has to be
ticked in a profile. Plus a **"Manage profiles →"** button that closes the
secrets and opens the Profiles panel — the link that was missing.

### 4. Every orphan secret says so itself

A blurb is read once and then becomes scenery. So every secret row that **no**
profile references carries `⚠ no profile uses it`. On the reference installation
all five light up — which is exactly the problem. `profileCache` is reloaded when
the popin opens so the diagnosis is never stale.

## Tests

- `profiles.test.ts`: the note says "already set", mentions the Bash tool,
  mentions `.env`, and supplies the presence test.
- End to end in the browser: a test secret and a test profile created, a real
  agent launched, the note read from the tmux pane's start command — it contains
  only the secret, not the `SHADOK_*` — and the secret's value is indeed in the
  process's environment. The test secret and profile deleted afterwards, vault
  and profiles re-checked identical.
- The popin verified in the browser: the blurb, the link that does open the
  profiles, and the five orphan warnings.
