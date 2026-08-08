# Claude Code onboarding and login: seeded first-run state + interactive login — design

Date: 2026-08-08 · Status: approved

## Goal

A **brand-new shadok-ai instance** — typically a fresh Docker container — must be
usable from the browser alone, with no `docker exec` and no file surgery on the
host. Two things stand in the way today:

1. A virgin `claude` opens on its **first-run screens** (theme picker, then the
   per-directory trust dialog). An agent spawned there never reaches a prompt: it
   has no input box, every submitted prompt fails, and the tab reads "failed to
   start". This has already produced three zombie agents on a production
   container, discovered a day later.
2. A virgin container has **no Claude credentials at all**, and the login is an
   interactive OAuth flow that assumes a terminal.

And a third thing, which is not onboarding but shares every mechanism with it:
**the login does not stay valid forever**. An instance that logs out mid-life
must be repairable from wherever the user happens to be — which, in practice, is
Telegram more often than the cockpit. Onboarding happens once per instance;
re-login happens repeatedly, so it is the path that will see the most use.

After this change: shadok seeds the first-run state itself, and offers the login
as a link + code-paste — as a card in the cockpit, and as `/login` + `/code` in
Telegram, both driving the same single flow.

## Out of scope

- **A general "instance status" panel.** Considered and dropped: everything it
  would display is either permanent and invisible (the seeded state, which nobody
  ever consults) or transient and blocking (not logged in → nothing works). A
  screen that reads "all good" 99.9% of the time is never visited, yet still has
  to be written, tested and kept honest. The onboarding is instead a set of cards
  that exist **only while something is missing**.
- **Console / API-key auth.** `claude auth login --console` exists; v1 drives the
  subscription flow (`--claudeai`) only. `authStatus()` reports whatever method is
  in use, so an instance already authenticated by `ANTHROPIC_API_KEY` simply reads
  as logged in and no card appears.
- **Git identity and the SSH public key.** Both are genuinely missing on a fresh
  container, but neither blocks an agent from *starting*. The card mechanism is
  built so adding them later is additive.

## What was verified before designing (2026-08-08, claude v2.1.226)

Both halves rest on observed behaviour, not on assumption. Probes ran against an
isolated `HOME`, never against the developer's real one.

**A virgin HOME opens on the theme picker** ("Let's get started. Choose the text
style that looks best with your terminal"), and never reaches a prompt.

**Seeding these keys takes the same virgin HOME straight to the prompt** — no
theme question, no trust dialog:

```json
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "<claude version>",
  "theme": "dark",
  "projects": { "<cwd>": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } }
}
```

**`claude auth status --json`** answers deterministically, with no TTY:

```json
{"loggedIn": true, "authMethod": "claude.ai", "email": "…", "subscriptionType": "max"}
```

**`claude auth login --claudeai` is a plain child process** — it needs no PTY. Run
with pipes it writes:

```
Opening browser to sign in…
If the browser didn't open, visit: <URL>      ← full, unwrapped
Paste code here if prompted >                 ← reads the code from stdin
Invalid code. Please make sure the full code was copied.
```

This is the load-bearing finding: **the login touches none of the screen
heuristics**. No `detectDialog`, no `screenShowsWork`, nothing from the fragile
family that invariant nº 2 warns about. It is a spawn, a stdout parser and one
write to stdin.

## Design

### Part 1 — Seeding: `src/claude-home.ts`

One pure planner plus one writer, called at two moments.

- **`seedPlan(existing, {version, cwd})` — pure, unit-tested.** Returns only the
  keys that are **absent** from `existing`. A value already there — the user's
  theme, an existing `hasTrustDialogAccepted` — is never overwritten. Returns an
  empty plan when there is nothing to add, so the writer can skip the write
  entirely.
- **`ensureClaudeHome()`** — called once in the `server.listen` callback, next to
  `ensureSshIdentity()`. Seeds the global keys.
- **`ensureProjectTrusted(cwd)`** — called before every spawn, from `makePilot`.
  This one cannot be a boot-time-only concern: a worktree is a **brand-new
  directory for every agent**, therefore a brand-new trust dialog every time.

Three properties make the module safe to run on a developer's machine:

1. **Purely additive.** On a machine that has used Claude Code before, the plan is
   empty and nothing is written. This is why — unlike `src/ssh.ts`, which had to
   restrict itself to containers (invariant 21) — no Docker gate is needed here:
   additivity already guarantees the no-op.
2. **Never destructive.** `~/.claude.json` carries the whole per-project history
   and reaches several megabytes on a long-lived machine. Writes are atomic
   (temp file in the same directory + `rename`) so an interrupted write cannot
   truncate it. A file that fails to parse is left **untouched** — we do not
   "repair" it by overwriting.
3. **Swallowed on error.** A failed seed must never take down the boot path or a
   spawn, exactly like `ensureSshIdentity`.

`lastOnboardingVersion` is set to the running `claude --version`, so an instance
that later upgrades Claude Code is not sent back to a "what's new" interstitial
by a version string frozen at install time.

This removes the `docker cp .claude.json` step from the container recreate ritual
by making it unnecessary: there is no longer a file to restore before
`docker start`, because shadok writes it itself, before any session spawns.

### Part 2 — Login: `src/claude-auth.ts`

Three pure functions and one live object.

- **`parseAuthStatus(stdout)` — pure.** `{loggedIn, authMethod?, email?,
  subscriptionType?}`. Unparseable or non-zero exit → `{loggedIn: false}`: an
  instance we cannot prove is authenticated is treated as not authenticated.
- **`parseLoginUrl(chunk)` — pure.** The trap is concrete: the CLI wraps the URL
  in an **OSC 8 hyperlink** (`ESC ] 8 ; ; URL BEL URL ESC ] 8 ; ; BEL`), so the
  URL is present **twice** in the raw stream and a naive regex captures a
  fragment. The function strips escape sequences first, then matches
  `visit:\s*(https://\S+)`.
- **`parseLoginOutcome(chunk)` — pure.** `"success" | "invalid-code" | null`. The
  CLI's own wording is surfaced verbatim rather than re-invented.
- **`LoginFlow`** — the live object. `start()` spawns `claude auth login
  --claudeai` with piped stdio and resolves with the URL; `submitCode(code)`
  writes `code + "\n"` to stdin and resolves with the outcome; `cancel()` kills
  it. **One flow at a time per instance** (credentials are machine-global), and
  the flow is killed after ~10 minutes idle — the OAuth URL expires anyway, and a
  stale child holding stdin open is worse than no flow.

The child inherits the server's environment and user, so credentials land exactly
where the spawned agents will read them (keychain on macOS, `~/.claude/` in a
container).

`BROWSER` is neutralised for the child: on a desktop host the CLI would otherwise
open a tab on the **server's** machine, which is not where the user is.

### Part 3 — Protocol and blocking

HTTP, not WebSocket: this is instance state, not session state. All four sit
behind the existing password gate.

| Endpoint | Meaning |
|---|---|
| `GET /auth` | `{loggedIn, email?, subscriptionType?}`, cached 30s — it is a spawn, and the card polls it while a flow is open. A successful `POST /auth/code` invalidates the cache immediately, so the card never has to wait out the window. |
| `POST /auth/login` | starts a flow → `{url}` |
| `POST /auth/code` | `{code}` → `{ok: true}` or `{ok: false, error}` |
| `DELETE /auth/login` | cancel the flow |

**The `start` handler refuses to spawn while logged out**, answering `error` with
`code: "logged-out"` — following the `code: "busy"` precedent, so a machine client
classifies the refusal without matching on message text. This refusal is the part
that actually prevents zombies: the historical failure is not "the login was
missing", it is "an agent was allowed to start without one".

### Part 4 — The card

A popin `#authOverlay` in `public/index.html`, carrying the `.overlay` class
(invariant 18 — omitting it is what once let the crons panel render inline in the
page flow), with its inline script marked `__CSP_NONCE__` and its handlers wired
through `addEventListener`, never `onclick=` (invariant 12).

It opens at exactly two moments: on page load when `GET /auth` reports logged
out, and on a `start` refused with `code: "logged-out"`. It shows:

1. the login link as a real `<a target="_blank" rel="noopener">`;
2. a code field and a submit button, with the CLI's error shown inline on a bad
   code so a retry needs no reload;
3. on success, the account e-mail — confirming **which** account was just
   connected, which matters on a machine that may serve several people.

It closes on success and does not exist otherwise. There is no entry point to
open it when the instance is healthy.

### Part 5 — Telegram: re-login mid-life

Onboarding happens once; **logging out mid-life happens repeatedly**, and when it
does the user is usually not in front of the cockpit. So the same flow gets a
Telegram door.

**Two explicit commands, no captured state.** `/login` starts the flow and
replies with the link; `/code <code>` submits it. The tempting alternative —
"after `/login`, treat the next plain message as the code" — is rejected on
purpose: a Telegram topic **is** an agent, so a bare message in it is a prompt.
Capturing the next one would one day swallow a real prompt from a user who had
forgotten a flow was open.

**Owner-only.** An OAuth code grants access to the account, so both commands go
through `dmGate` / the bound board group, exactly like `/secret`. Never from an
arbitrary topic.

**One flow, two doors.** `LoginFlow` is already a single instance-global object
(credentials are machine-global). The consequence is free and worth stating: the
URL is identical on both sides, and a code pasted from Telegram closes the web
card on its next `GET /auth`.

**How the user finds out.** shadok reacts to a **real failure** — a spawn refused
with `logged-out`, or a cron that could not fire for that reason — and posts one
message to the board group (or the owner DM) naming the cause and the `/login`
remedy. It is **deduplicated until the state flips back**: a cron on a 5-minute
slot would otherwise turn one logout into a flood, and a channel that cries wolf
gets muted before the day it is right.

Periodic polling of `claude auth status` was considered and rejected for the same
reason: an expired-but-refreshable OAuth token can report itself logged out while
the CLI would renew it without complaint, so a poll manufactures false alarms
about a session that is in fact fine. A refused spawn is not a guess — it is the
thing the user actually cares about, already having happened.

## Testing

**Unit (pure, no spawn):** `seedPlan` — empty plan on an already-onboarded file,
never overwrites a present value, adds the project entry for a new cwd, tolerates
a malformed file. `parseAuthStatus` — logged in, logged out, garbage.
`parseLoginUrl` — the real OSC 8 fixture captured on 2026-08-08, and a plain
unwrapped line. `parseLoginOutcome` — the three cases.

**End to end, on a clean vps1 container.** The image auto-updates from npm and is
pinned, so the container must run *this branch*: build here, rsync `dist/` to
vps1, run a **new** container with empty volumes on a free port (3793) with
`SHADOK_HOST=0.0.0.0` (the only value that works in Docker),
`SHADOK_VERSION_CHECK_MIN=0` (otherwise the version poll installs the published
release and exits, and the build under test vanishes without a word), and the
built `dist/` bind-mounted. The four production containers are untouched.

The sequence that constitutes the proof:

1. open the cockpit → the card appears unprompted;
2. follow the link, authorise, paste the code → the card closes and names the
   account;
3. create an agent → **it reaches a prompt**, not the first-run screen;
4. no `docker cp` of `.claude.json` anywhere in the sequence.

Step 4 is the point of the whole feature: the ritual is gone because the file no
longer needs restoring.

**The mid-life path, on the same container**, since it is the one that will
actually be used repeatedly: bind a Telegram bot, log the instance out
(`claude auth logout` inside the container), then attempt a spawn. Expected: the
spawn is refused, **one** message lands in the board group, a second attempt
produces no second message, `/login` returns the link, `/code <code>` restores
the session, and the open web card closes on its own within the cache window.

## Documentation shipped with the change

- `README.md` — the login card, the `/login` and `/code` Telegram commands, the
  `/auth` endpoints, and a rewritten container
  recreate procedure that no longer needs the `docker create` → `docker cp` →
  `docker start` ordering.
- `CLAUDE.md` — `src/claude-home.ts` and `src/claude-auth.ts` in the architecture
  map; invariant 25's paragraph about `/root/.claude.json` amended to record that
  seeding now removes the race it describes.
- `docs/architecture.md` — the onboarding subsystem and why the login is a piped
  child process rather than a piloted screen.
