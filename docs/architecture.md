# shadok-ai — technical architecture

Deep dive behind `CLAUDE.md`. Read `CLAUDE.md` first for the map and invariants.

## The big picture

```
 browser (public/index.html)            server (src/server.ts)          claude CLI
 ┌───────────────────────┐   WebSocket  ┌──────────────────────┐       ┌──────────┐
 │ channels / groups     │ ───/ws────▶  │ sessions: Map<id,Live>│       │  TUI in  │
 │ chat, dialogs, gauges │ ◀─────────── │  per session:         │──────▶│  a PTY / │
 │ engine room, diff     │              │  • pilot (PTY|tmux)   │ drive │  tmux    │
 └───────────────────────┘   HTTP GET   │  • .jsonl tail        │◀──────│          │
             │              ───────────▶ │  • screen watcher     │ read  └────┬─────┘
             │  /usage /live /diff …     └──────────────────────┘            │ writes
             ▼                              ▲        ▲                        ▼
   ~/.shadok-ai/channels/<cwd>.json         │        └─ reads ─ ~/.claude/projects/<cwd>/<id>.jsonl
   (channel + group lists)                  │                    (authoritative transcript)
                                            │ WebSocket (loopback)
                                  ┌─────────┴───────────┐
                                  │ src/telegram.ts     │ one topic = one agent
                                  │ src/crons.ts (tick) │ scheduled prompts
                                  │ pilotctl / cli      │ agents & scripts
                                  │ — all WS clients of │
                                  │   this same server  │
                                  └─────────────────────┘
```

Every other way in is **a client of our own server**, not a second code path:
the Telegram bridge, the cron driver, `pilotctl` and the CLI each open a
loopback WebSocket and speak the same protocol the browser does. That's why a
Telegram session and a web tab are literally the same `Live` object, why a cron
firing at a channel is indistinguishable from a human typing at it, and why sync
is automatic rather than replicated. It is also why the origin guard has to let
`Origin`-less clients through (invariant #11) — all of these have no `Origin`.

Three data planes per session:

- **Content plane — the `.jsonl` tail.** Claude Code writes every turn to a
  JSONL transcript. `src/tail.ts` tails it and emits complete assistant text,
  tool calls, tool results, and token usage. This is authoritative and
  survives everything (it's a file). The UI's chat is built from it.
- **Control plane — the rendered screen.** The pilot exposes `screen()` (the
  rendered TUI). Used to: submit prompts, detect turn end (`screenShowsWork`),
  detect interactive dialogs (`detectDialog`), parse `ctx:NN%`, and mirror the
  raw TUI in the "engine room". **Never** used to reconstruct response text.
- **Raw plane — the byte pipe (experimental, tmux only).** `attachRaw()` streams
  the pane's actual output bytes so the browser can run a real terminal emulator
  instead of a rendered snapshot. See "Interactive terminal" below.

Splitting content from control is the key design decision. Early versions
scraped the screen for content and suffered truncation + fragility; the tail
fixed it.

**The one deliberate exception — the web live preview.** The `.jsonl` only
writes a text block once it is *complete*, so a long paragraph is invisible
during generation then lands all at once. `public/live-text.js`
(`extractLiveText`, pure and unit-tested) pulls the in-flight block off the
screen and shows it in a **provisional** grey bubble, replaced 1-for-1 by the
authoritative tail block on `stream-text` and dropped on `turn-done`/`dialog`.
It is never persisted; a failed extraction returns `""` and the UI falls back
to block-level rendering. This is a *rendering* concession, not a content one.

## Transport: PTY vs tmux

Both implement the same interface (`start, screen, submit, press, write,
waitForIdle, isWorking, onExit, hasExited, stop, kill`). The server picks one
via `makePilot()`.

- **`PtyPilot` (node-pty)** — spawns `claude` as a child of the server,
  with `@xterm/headless` replaying the ANSI stream into a virtual screen so we
  can read it. Must forward xterm's query responses (cursor position, etc.)
  back to the PTY or the TUI ignores keystrokes. Dies with the server.
- **`TmuxPilot` (default when tmux present)** — runs `claude` inside a detached
  tmux session named `sk-<sessionId>`. tmux owns the terminal, so the agent
  survives the server crashing/restarting; on next `start` for that id,
  `has-session` is true → **reattach** instead of respawn. `screen()` is a
  polled `capture-pane`; input is `send-keys` / bracketed-paste `paste-buffer`.
  tmux handles terminal queries itself, so that whole class of PTY hacks
  disappears. Does **not** survive a machine reboot (tmux dies then).

`SHADOK_TMUX=0` forces node-pty.

## Interactive terminal (experimental, tmux only)

The engine room mirrors `screen()` — a *rendered snapshot*, polled every 300 ms.
That is enough to read and to click keys, but it is not a terminal: no scrollback
of its own, no selection, no full-fidelity redraw. So there is a second, opt-in
path where the browser runs **xterm.js** against the pane's real byte stream.

- `attachRaw(cb)` (`src/tmux.ts`) starts `tmux pipe-pane -O` writing the pane's
  output to a file, then tails that file and hands chunks to the callback.
  `-O` matters: `pipe-pane` only carries output produced **after** it starts, so
  the pane is redrawn to prime the stream.
- The server frames each chunk as base64 in `term-data`; the client feeds it to
  xterm.js. Input goes the other way as `term-input` (also base64), plus
  `term-resize` to match the pane to the browser viewport.
- `term-attach` / `term-detach` bracket the pipe, and only one pipe exists at a
  time per pane (`pipe-pane` with no command closes it).
- **`PtyPilot` has no `attachRaw`.** This plane is tmux-only; with node-pty the
  engine room is all there is.

Vendored client-side (no CDN, see the CSP section): `/vendor/xterm.js`,
`/vendor/xterm.css`, `/vendor/addon-fit.js`.

Treat it as experimental: it bypasses the "screen is control only" discipline by
design, and a raw pipe plus a rendered snapshot of the same pane can disagree.

## Session lifecycle

1. **start** (`ClientMessage.start`): compute a deterministic session id
   (new → `randomUUID()` + `--session-id`; resume → the given id; continue →
   latest in cwd). If `worktree`, create an isolated checkout and use it as the
   cwd; if `branch`/`repo` are given, recreate a reclaimed checkout instead.
   Spawn args are assembled from the permission mode, the pilot prompt, and the
   channel's `profile` (role, guardrails, secrets, model). `makePilot()` →
   `pilot.start()` (reattach if the tmux session exists).
2. **startup gate**: wait for the TUI to be up (`❯`, spinner, or trust prompt);
   accept the trust dialog; **auto-answer the resume-from-summary prompt**
   (keep full session). Then send `ready` + `history` (replayed from `.jsonl`)
   + `tokens` + `context`.
3. **turn**: `prompt` → pace gate (unless `force`) → `pilot.submit()` →
   `finishTurn()` waits for idle, then broadcasts either a `dialog` (interactive
   question) or `turn-done`. Content streams independently via the tail.
4. **screen watcher** (300 ms): broadcasts `screen`, `context`, and catches a
   spontaneous resume (a background turn starting with no client prompt).
5. **detach**: a client leaves → if it was the last, arm an idle-reclaim timer
   (`SHADOK_IDLE_MIN`, default 60 min). Reattaching cancels it.
6. **destroy**: process exits, explicit `stop`, or idle timeout → kill the
   pilot (and tmux session), drop it from the registry, archive/close its
   Telegram topic, and `pruneWorktree` (below).

`stop` carries an optional `sessionId` so the UI can kill a channel it isn't
attached to — that's how a dead/zombie tab is removed. Orphans are also
self-healed at boot.

**Who spoke.** Because several clients share one session, a prompt arriving out
of nowhere is confusing. `start` carries an `origin` (`"web"`, `"cron"`,
`"telegram"`, `"cli"`…) that travels with `prompt-echo`, so every other client can
attribute the prompt instead of showing it anonymously. A `prompt` refused
mid-turn comes back as `error` with `code: "busy"` — a machine client can
classify the refusal without pattern-matching the message text. And
`stream-text` carries `at`, the time the block was **written**, not the time we
read it, so a client dates history correctly instead of stamping everything with
the moment it reconnected.

## Worktrees

Created as `~/.shadok-ai/worktrees/<repo>-<tag>` on branch `shadok-ai/<tag>`,
branched from the repo's current HEAD. **Worktree-per-agent is the default**
for spawned agents; the main channel runs at the repo root.

On session end, `pruneWorktree` keeps anything that could be work and reclaims
what can't be:

| State of the worktree | Checkout | Branch |
|---|---|---|
| Uncommitted changes | kept | kept |
| Commits, clean tree | removed | **kept** (recoverable) |
| No commits, clean tree | removed | deleted |

`git worktree remove` is called **without `--force`**, so git itself refuses to
discard a dirty tree — the safety is structural, not a check we could forget.
A branch that carries commits always survives; `/recover` recreates its
checkout on demand (`ensureWorktreeCheckout`). See invariant #5.

## Tweaking shadok-ai from inside shadok-ai (`src/selfrepo.ts`)

The people who feel a rough edge in the cockpit are rarely the ones who can fix
it: doing so means knowing the cockpit is itself a git repo, cloning it, finding
the right working directory, and knowing enough of the invariants not to break
the session you are talking in. The **Tweak Shadok-AI** card, pinned at the
bottom of the agents column, collapses that into one click.

What the click does:

1. `POST /tweak/prepare` → `ensureSelfRepo()` clones
   `https://github.com/shadok-ai/shadok-ai.git` into `~/.shadok-ai/self/shadok-ai`,
   or fast-forwards its `main` if it is already there, and returns that path.
2. The client starts an **ordinary session** on it with `worktree: true` and
   `profile: "Shadok-Tweak"`. Everything downstream — the `shadok-ai/<tag>`
   branch, the isolated checkout, the Diff panel, `pruneWorktree` on close — is
   the existing machinery, unchanged.

The card is not a launcher that piles up sessions: **it is the channel's slot**.
The tweak channel is unique, the CTA shows only while it does not exist, and once
started the channel's own tab is *moved* into the slot rather than added to the
agents list. Being a real `.tab`, it carries the session states, the ✕, the
rename and the whole context menu — `✈️ Mirror to Telegram` included — without a
line of parallel code. Closing it restores the CTA. On reload, or when the
channel is discovered from the registry (born on another device or in Telegram),
it is routed back to the slot on `profile === "Shadok-Tweak"`.

Three decisions are worth keeping in mind if you touch this:

- **The clone is separate from the launch directory**, even for a maintainer who
  already has one. It is predictable, and it can never be the directory the
  running server was started from. It is also the first session whose repo is not
  the launch repo, which is what invariant 20 is about.
- **The clone is anonymous, and authentication is deferred to push time.** A user
  can describe an idea, watch the agent work and read the whole diff before
  connecting any GitHub account. Only when there is something worth pushing does
  the agent run `gh auth login` (device flow, relayed in the chat), fork under the
  user's account and open the PR. No token is ever pasted into the cockpit.
- **The role is injected through the profile pipeline, not a new path.**
  `context/tweak-prompt.md` is versioned in the repo, and `seedTweakProfile`
  refreshes the managed `Shadok-Tweak` profile's `systemPrompt` from it at every
  boot, so it tracks the running build instead of rotting in the user's
  `profiles.json`. Only that field is rewritten (`withManagedPrompt`), so a vault
  secret or model attached in the Profiles editor survives. `profile` is already
  re-applied on resume and restart, so the role is not lost when a session comes
  back.

The card is a **desktop affordance**: under 640px `#tabbar` is hidden entirely,
so the CTA is not offered on a phone. Reviewing a diff or driving a code change
on that screen is not realistic, and once started the tweak session is a normal
channel reachable from the mobile channel selector like any other.

## Interactive dialogs

`detectDialog(screen)` finds numbered options with a `❯` selector, strips any
right-hand preview column, and returns `{question, options[], multi}`. The UI
renders clickable buttons; Telegram renders an inline keyboard.

- **single-select** (`choose n`): server moves the `❯` cursor with arrow keys to
  option n, then Enter. Digit keys don't work for preview-style dialogs.
- **multi-select** (`toggle n`, then `confirm`): digit toggles the checkbox;
  confirm is Tab → "Submit" page → Enter.
- **free text** ("Type something", `freetext n text`): digit → paste → Enter.
- A dialog already on screen at attach time is surfaced via `sendPendingDialog`
  (except the auto-answered resume-from-summary one).

## The web client (`public/`)

`index.html` is the entire client: no framework, no build step, no bundler. The
server serves it and the browser runs it.

**Vocabulary warning.** The UI says **agent**; the code, the endpoints and the
storage keys all still say **channel**. They are the same thing. Renaming the
wire format was judged not worth the churn.

**Pure logic is extracted, not inlined.** Anything with real decisions in it
lives in its own ESM module that is *both* loaded by the browser and imported by
a Node test — which is why the client has a test suite at all:

| Module | Pure function | Tested by |
|---|---|---|
| `public/live-text.js` | `extractLiveText(screen)` | `test/live-text.test.ts` |
| `public/notify.js` | `notifyState(channels, view)` | `test/notify.test.ts` |
| `public/profile-card.js` | `profileBlurb`, `profileBadges` | `test/profile-card.test.ts` |

`notifyState` decides the favicon colour, the title badge and whether to blink,
from the channel list plus `{hidden, phase}`. Two rules worth keeping: the badge
blinks **only** when the browser tab is hidden *and* an **unmuted** channel is
waiting for an answer, and both phases stay visible — a timer throttled by a
background tab must never leave the page looking calm when it isn't.
`profileBadges` derives its labels from what a `Profile` already has
(`systemPrompt` / `deny` / `model` / `secrets`); nothing was added to the type to
feed the card.

**The trap that comes with this** (invariant #10): the `<script type="module">`
that bridges those exports onto `window` runs **after** the document is parsed,
while the classic `<script>` below it runs *during*. Anything that paints on load
must wait for `DOMContentLoaded` or guard on `window.<fn>`. The profile grid
painted immediately, `window.profileBlurb` was `undefined`, the first card threw,
and the grid stayed empty **in silence** — the call site is an unawaited async
function. `tsc` and the tests were green; only the browser showed it.

## The Telegram bridge (`src/telegram.ts`)

One board **group** per instance (`/setup` binds it), one **topic** per agent.
A topic created by hand auto-spawns an agent and keeps its own name; `/spawn`
creates the topic and the agent together.

**The main channel is the group's General topic** — the binding with no thread
id *and* a negative `chatId` (Telegram gives groups and supergroups negative
ids). It is always displayed as `general`, server-authoritative so a stale
client can't rename it, and it isn't deletable. The `chatId < 0` half of that
test is load-bearing: a **DM** binding also has no thread id, and forcing every
thread-less binding to `general` produced a bogus second "general" next to the
real one. DMs keep their own name.

**DMs belong to exactly one person.** `dmGate(owner, from)` returns
`claim` / `allow` / `deny`: the first private user claims ownership (persisted in
`…-telegram-owner.json`), everyone else is denied. At boot the owner is adopted
from an existing DM binding, or failing that from the board group's creator — so
an instance that already had a DM doesn't hand itself to whoever messages next.
Without this gate a public bot username is an open shell.

- **Binding** = `{chat, thread} → WebSocket to our own server`, persisted on
  the channel record so it survives a restart.
- **Rendering**: the agent's Markdown is converted to Telegram HTML; messages
  are chunked under the 4096-char limit. A "typing…" heartbeat runs for the
  whole turn and is stopped by *every* terminal outcome (`turn-done`, `dialog`,
  `pace-blocked`, `exited`, WS close) — a missed one leaves it spinning forever.
- **Commands**: `/setup`, `/spawn [profile] <name>`, `/profiles`, `/stop`
  (alias `/esc` — interrupts the turn), `/new`, `/end`, `/restart`, `/list`,
  `/cron` (`every 30m …`, `daily HH:MM …`, `list`, `on`, `off`, `del`),
  `/secrets`, `/secret`, `/unsecret`, `/update`, `/help`. Anything else is sent
  to the agent as a prompt.
- **Stale prefaces.** A `dialog`'s `preface` comes from screen extraction, so it
  can still hold the *previous* turn's answer when the new turn hasn't written to
  the transcript yet. `isStalePreface` drops it when it matches a block already
  streamed (`Live.recentTexts`, last 8). It is deliberately looser than
  `prefaceMatches`: dropping a fresh preface only delays it (the tail will
  deliver it anyway), whereas keeping a stale one leaves a permanent duplicate —
  nothing ever comes along to edit it away.
- **Attachments**: photos and documents are downloaded and handed to Claude
  Code as file paths; a media group is buffered and flushed as one prompt.
- `/secret NAME value` deletes the user's message after storing, so the value
  doesn't linger in chat history (needs *Delete messages* admin rights).

## Profiles & secrets

- **Secret vault** (`src/secrets.ts`, `~/.shadok-ai/secrets.json`, mode 600) —
  central, name→value. Values live outside any repo.
- **Profiles** (`src/profiles.ts`, `~/.shadok-ai/profiles.json`, mode 600) —
  a named bundle of: a role (`--append-system-prompt`), permission guardrails
  (`--settings` deny/allow, e.g. forbid `git commit`), a model, and a list of
  **secret names** to inject as env. Applied at spawn via `profileArgs`, stored
  on the channel, re-applied on resume/restart.

Guardrails are **soft**: the agent runs as the same OS user. This is a
misfire-prevention mechanism, not a sandbox — don't treat it as containment.

**An agent can add to the vault, and only add.** A credential an agent obtains
itself — `gh auth login`, a provisioning CLI — used to die with the session. The
`shadok-secrets` skill (seeded at boot from `context/secrets-skill/`) gives it a
way to keep that credential for the next agent, under three constraints that are
the whole design:

- **Write-only.** There is no `get`, and `GET /secrets` returns names. A value
  leaves the vault in exactly one way: injected as env into an agent at spawn.
- **The value never touches `argv`.** `secret.mjs set NAME --stdin` makes the flag
  *required*, so there is structurally no argument to leak — `ps` shows a
  process's arguments to every user on the machine.
- **No silent overwrite.** `PUT /secrets` refuses an existing name (409) unless
  the caller passes `overwrite: true`. The web Secrets panel passes it, because a
  person reading the list and clicking Save is deliberate. An agent does not, and
  is told to report the clash rather than work around it. Overwriting is the only
  destructive move here: it replaces a live credential, shows nothing, and the
  vault keeps no history.

Telegram needs no guard: `/secret NAME value` calls `setSecret()` directly, in
the server's own process. HTTP is the only door an agent has, which is why
guarding the endpoint guards precisely the machine path.

## Permission mode

Spawned agents start in `acceptEdits` (the Shift+Tab auto-accept-edits mode) by
default. Configurable from the GUI (`POST /permission-mode`), persisted in
`config.json`, overridable with `SHADOK_PERMISSION_MODE`. Only affects agents
started *after* the change — a running one keeps its launch mode.

## Claude onboarding and sign-in (`src/claude-home.ts`, `src/claude-auth.ts`)

A fresh instance has no Claude credentials and no Claude Code onboarding state,
and both failures look identical from the cockpit: the agent starts, sits on a
screen with no input box, and every prompt fails. Two modules, deliberately
independent.

**Seeding (`claude-home.ts`).** `seedPlan` is pure: given the current
`~/.claude.json` it returns the merged object to write, or `null` when nothing
is missing. `ensureClaudeHome()` runs once at boot with the globals
(`hasCompletedOnboarding`, `lastOnboardingVersion` — and deliberately **not**
`theme`: the CLI deletes an unknown top-level `theme` key on its next write, and
the picker is already skipped without it);
`ensureProjectTrusted(cwd)` runs inside `makePilot` before every spawn, because
a worktree is a brand-new directory and therefore a brand-new trust dialog.

`settingsPlan` covers a second file and a subtler case: `~/.claude/settings.json`
gets an explicit `tui` value, which suppresses the fullscreen renderer upsell.
That one is **not** an onboarding screen — it appears only **after** a sign-in,
so no signed-out probe can find it, and it is *blocking* (`❯ 1. Yes, try it /
2. Not now`), reaching the chat as a question before the agent is usable. It is
counted by `fullscreenUpsellSeenCount`, but seeding a counter means guessing its
threshold; recording a preference is durable, because a choice already made
cannot be upsold. Same additive rule: a `tui` the user set is never touched, and
the rest of `settings.json` — permissions, hooks, model — is preserved.

Three properties are load-bearing. It is **purely additive** — a key already
present is never overwritten — which is what removes the need for the Docker
gate that `src/ssh.ts` had to adopt: on a machine that has used Claude Code
before, the plan is empty and nothing is written. The write is **atomic** (temp
file in the same directory, then rename), because the file carries megabytes of
per-project history and truncating it costs incomparably more than the screen
this avoids. And a file that fails to parse is **left alone**, never "repaired".

**Sign-in (`claude-auth.ts`).** The design decision worth recording: the sign-in
is a **piped child process**, not a piloted screen. `claude auth login
--claudeai` needs no PTY — with plain pipes it prints the OAuth URL on stdout
and reads the code from stdin. Driving it through `PtyPilot`/`TmuxPilot` and
`detectDialog` would have worked too, and would have put one of the most
fragile parts of the codebase (the screen heuristics, invariant nº 2) on the
critical path of the one flow a brand-new user meets first. A stdout parser and
one `stdin.write` have neither the fragility nor the latency.

Two traps live in that parsing. The CLI wraps the URL in an **OSC 8 hyperlink**,
so the URL appears twice in the raw stream and a naive regex captures a
fragment — `parseLoginUrl` strips escapes before matching. And **success is a
clean exit, not a string**: the refusal wording was observed, the success
wording never was, and guessing it would report a completed sign-in as never
finishing (invariant 29).

`authStatus` reports **three** states, not two: "I observed it is signed out" and
"I could not look" are different facts. The probe is a ~850ms process spawn, so
it flakes on a busy machine — and collapsing a failed probe into *signed out*
popped the sign-in card, spawned a login child and refused every spawn on
instances that were signed in the whole time. `unknown` retries once, is never
cached, never opens the card and never blocks a spawn; only an observed
`signed-out` does any of that.

`startLogin` / `submitLoginCode` / `cancelLogin` drive **one instance-global
flow**, because the credentials are machine-global and two concurrent logins
would race for the same keychain entry. The upside is free: the web card
(`#authOverlay`) and Telegram's `/login` + `/code` share the same URL, and a
code pasted from either finishes the other's flow.

The `start` WS handler refuses to spawn while signed out, with `code:
"logged-out"` — following the `code: "busy"` precedent so a machine client
classifies the refusal without matching message text. That refusal, not the
sign-in itself, is what prevents zombie agents: the historical failure was an
agent allowed to start with no credentials. It also calls `announceLoggedOut()`,
which posts once to the Telegram board group and is deduplicated until the state
flips back (`shouldAnnounceLoggedOut`, pure and tested) — a five-minute cron
would otherwise turn one sign-out into a flood.

Deliberately **not** built: an "instance status" panel. Everything it would show
is either permanent and invisible (the seeded state) or transient and blocking
(signed out → nothing works), so it would read "all good" almost always and
never be visited. The onboarding is instead cards that exist only while
something is missing.

## Auth (optional password gate)

Set a password (`--password`, `SHADOK_GUI_PASSWORD`, or config) and every page,
endpoint and WebSocket requires it — except `/login`. The session cookie is
derived **deterministically from the password by HMAC**, not random: a server
restart therefore doesn't log everyone out, and any instance sharing the
password accepts the same cookie. It's one-way, so the cookie never leaks the
password. The in-process Telegram bridge presents that same cookie on its
loopback WS.

## Where it listens, and who may talk to it (`src/net.ts`)

The cockpit runs arbitrary commands on the host, so the network surface is
deliberately small and **fail-closed**. All three decisions are pure functions,
unit-tested without a server.

- **`resolveHost`** — `SHADOK_HOST`, defaulting to `127.0.0.1`. This machine
  only, unless you say otherwise.
- **`bindRefusal`** — binding a non-loopback interface **without a password is
  refused outright**: the server declines to start rather than hand the network a
  shell. Not a warning, a refusal.
- **`originAllowed`** — a browser whose `Origin` isn't the request's own `Host`
  is rejected, because a WebSocket ignores the same-origin policy: without this
  check any page you happened to visit could drive your agents. `SHADOK_ORIGINS`
  lists extra origins for a reverse proxy that rewrites `Host`.

The subtle half of that last one (invariant #11): **an `Origin`-less client must
be allowed through.** The Telegram bridge, `pilotctl`, the CLI and the scheduler
all open loopback connections with no `Origin` header at all, so tightening that
branch into a deny cuts Telegram off from its own sessions. This guard only ever
addresses browsers; the bind and the password are what stop a network attacker.

## Browser hardening: CSP + sanitization

An agent's output reaches the DOM. It is also, by construction, text the agent
read somewhere — a cloned README, a fetched web page, a Telegram message. So the
page is written as if that output were hostile.

- **CSP with a per-request nonce** (`src/csp.ts`). `index.html` is served by a
  dedicated route (not `express.static`) that replaces the `__CSP_NONCE__` marker
  with a fresh nonce, and the policy refuses `unsafe-inline`. That is what
  neutralizes HTML an agent writes into a transcript. Consequence worth
  memorizing (invariant #12): **an inline `<script>` added without the marker
  silently does not run**, and the nonce does *not* cover inline handlers, so
  `onclick=` must become `addEventListener`. `test/csp.test.ts` locks both.
- **DOMPurify before every `innerHTML`** (invariant #13).
  `DOMPurify.sanitize(marked.parse(…))` — `marked` passes raw HTML through
  untouched. If DOMPurify failed to load, the code falls back to `textContent`
  rather than injecting unfiltered HTML.

Both libraries are vendored and served from the server (`/vendor/marked.js`,
`/vendor/purify.js`, `/vendor/xterm.js`…): the CSP forbids external hosts, and a
cockpit that only listens on loopback shouldn't need the internet to render.

## Distribution & self-update

`npx shadok-ai` runs `src/main.ts`, which is **not** the server: it parses
flags, prompts once for a bot token on first run, then runs the **supervisor**
(`src/supervisor.ts`). The supervisor launches the npm-installed server
(`~/.shadok-ai/app/node_modules/shadok-ai/dist/server.js`) as a child and
restarts it on a dedicated exit code.

- The server polls npm for a newer version; if `autoUpdate` is on it downloads
  in the background (to shrink the reload gap), then exits with the update code.
  The supervisor restarts it and connected browsers reload via `server-reload`.
- `autoUpdate` is a GUI checkbox persisted in `config.json`, and **config wins
  over env once set** — `SHADOK_AUTOUPDATE=0` alone will not stop it.
- CI publishes on every merge to main; the version is `major.minor.<commit
  count>`. The repo's `package.json` stays at `0.1.0`, so a local version
  "behind" npm is normal.

### Two channels

An instance follows one of two release streams, set in the version menu and
persisted as `updateChannel` (absent = `beta`):

| Channel | Moves on | npm dist-tag |
|---|---|---|
| `alpha` | every merge to main | `alpha` |
| `beta` (default) | a promotion — a minor bump | `latest` |

**Promoting is one edit**: bump the minor in `package.json` and merge. CI
compares that minor with the one `latest` currently points at; different means
this merge is the promotion.

The channel also decides the NUMBER. An alpha is `<major>.<minor>.<commit
count>` — the version says which commit it is. A promotion is
`<major>.<minor>.0`: a milestone, not a commit pointer. The first promotion
shipped as `0.3.77` under the older rule and read as the 77th patch of a 0.3
series whose 0.3.0–0.3.76 never existed, which is a version number that lies to
the person reading it. No collision is possible either way — an alpha's patch is
a commit count, never 0. The decision is read from the registry, not from
git history, so a re-run or a replay reaches the same verdict instead of
promoting twice.

The beta channel is `latest` rather than a `beta` dist-tag, and that is not an
aesthetic choice: npm Trusted Publishing (OIDC) authenticates `npm publish` and
nothing else, so `npm dist-tag add` would require storing a long-lived npm token
as a repository secret. Since `npm publish` *sets* a tag, an ordinary merge
publishes `--tag alpha` and a promotion publishes with no tag — which is exactly
what moves `latest`. A fresh `npx shadok-ai` therefore lands on the promoted
version, which is what a newcomer should get.

One wrinkle falls out of it: a promotion moves `latest` while `alpha` still
points at the previous build, so for the span of one merge the "newest" channel
resolves *older* than the calm one. `pickTarget` (`src/update-channel.ts`) closes
it client-side — alpha takes the newer of the two tags — because an alpha
instance downgrading itself is worse than the oddity it fixes.

This is the trap when testing a local build: see "Running YOUR build" in
`CLAUDE.md`. A second server finds the port busy, falls back to the next one,
then auto-updates itself out from under you.

## Persistence

- **Transcripts**: Claude Code's own `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
  History and streaming both read these. Keyed by cwd — see invariant #1.
- **Channel + group lists**: `~/.shadok-ai/channels/<encoded server cwd>.json`
  and `…-groups.json`, via `src/channels.ts`. **Keyed by the server's launch
  directory** — each project/repo the server is started from keeps its own
  cockpit, its own bot token, and its own board group. Server is the source of
  truth; browser localStorage is an offline fallback. See invariant #6 for the
  erosion trap.
- **Global config**: `~/.shadok-ai/config.json` (600) — port, per-launch-dir
  Telegram token/allowed chats/enabled, GUI password, `autoUpdate`,
  `permissionMode`, `timezone`.
- **Vault & profiles**: `~/.shadok-ai/secrets.json`, `profiles.json` (both 600).
- **Crons**: `~/.shadok-ai/crons/<encoded cwd>.json`, per launch directory like
  the channel list.
- **Telegram DM owner**: `~/.shadok-ai/<encoded cwd>-telegram-owner.json` — the
  single user allowed to DM this instance.
- **Tail offsets**: `~/.shadok-ai/tail/<id>.pos`. The tail persists its byte
  offset and **resumes there** instead of starting at EOF (invariant #7).
  Starting at EOF silently dropped everything an agent wrote *during* a restart —
  i.e. on every auto-update. The web recovered by accident (it reloads history);
  Telegram never did. And resuming is useless if nobody is listening, so
  `reconcileOnBoot` reattaches the bridges whose tmux agent is still alive. Both
  halves are needed; keep them together.
- **Worktrees**: `~/.shadok-ai/worktrees/<repo>-<tag>` on `shadok-ai/<tag>`.

Everything the cockpit owns lives under `~/.shadok-ai` — nothing is written
into the piloted repo.

## Pace guardrail (`src/pace.ts`)

For each window (5h, 7d): `idealPace = fraction of the window elapsed`;
`ratio = used / (idealPace + PACE_EPSILON)`. **Blocked when `ratio > 100`**,
i.e. `used > idealPace + PACE_EPSILON` (currently 2). It's dynamic: as time
passes the ideal rises, so a block clears on its own once you're back within
budget. `/usage` returns the verdict; a `prompt` bypasses with `force: true`.
The UI shows two-bar gauges (consumed vs elapsed) and a per-message force path.

The OAuth token backing `/usage` is read **live** (keychain first) rather than
captured at boot, so the gauges self-heal when the token rotates instead of
silently freezing.

## Auto-retry (`src/retry.ts`)

A turn that dies on a transient API error (529, 5xx, timeout) is resubmitted
automatically, with `auto-retry` / `auto-retry-cancelled` / `auto-retry-gave-up`
broadcast so the UI can show what's happening rather than looking hung.

## Scheduled prompts (`src/crons.ts`)

A cron is a prompt fired at a channel on a timer: `{sessionId, prompt, schedule,
enabled, check?, tz?}`, persisted per launch directory in
`~/.shadok-ai/crons/<encoded cwd>.json`. Two schedules: `interval` (every N
minutes) and `daily` (HH:MM). The server resumes the channel and prompts it, so
nothing has to stay alive between runs — which is why there is no duration cap
here, unlike an agent scheduling itself.

**The deterministic guard is the point.** `check` is a shell command run
server-side, in the channel's cwd, with the profile's secrets — and **without the
LLM**. The convention is stdout: print nothing → nothing to report, the agent is
never woken and the run costs **zero tokens**; print something → that output is
prepended to the prompt and the agent runs. A monitoring cron that is quiet 23
hours a day therefore costs nothing 23 hours a day.

Those secrets come from the channel's **profile** and from nowhere else
(`secretsFor(profile?.secrets)` in `runCronCheck`). A channel with no profile —
the default — gives its guard none, and `secretsFor` skips a name missing from
the vault without a word. The agent that wrote the check has the key in its own
env, so testing the command by hand proves nothing about the guard's. That
asymmetry is why agents hardcode values into check scripts "just in case";
`schedule.mjs env` (the `shadok-scheduler` skill) prints the real list so they
don't have to guess.

That convention has a sharp edge worth knowing (invariant #16): `grep`, `diff`
and `test` all exit non-zero *precisely* when there is nothing to report. So
`runCronCheck` keys on **stdout** for news, and treats a non-zero exit as broken
only when it also wrote to **stderr** (or was killed / never spawned). A guard
that is genuinely broken wakes the agent on purpose, so the monitoring cannot
die in silence — it costs tokens every slot until someone fixes it.

**Where a cron runs is resolved once.** `resolveCronTarget` (pure, in
`src/crons.ts`) maps a cron's `sessionId` to its channel's `cwd`, `profile`,
`branch` and `repo`; `fireCron` calls it once and hands the result to both the
guard and the resume. It used to be two lookups: the guard resolved the channel's
cwd, and `driveChannel` sent `cwd: process.cwd()` — the repo root. Since
`loadHistory` is keyed by the cwd (invariant #1), a cron on a **worktree** channel
woke its agent in the wrong directory with an empty history (invariant #19). The
resume also forwards `branch` + `repo` when the channel has both, so a worktree
whose checkout was pruned is recreated (`ensureWorktreeCheckout`) instead of
failing. For that to be worth anything the branch has to survive: the start
handler patched `branch: worktree?.branch ?? null` on every `ready`, and a resume
holds no `worktree` object, so the first resume erased the branch recorded at
creation. It is now only ever *asserted* — the key is omitted when there is
nothing to assert, which is how `repo` has always behaved. An unknown `sessionId`
still falls back to the server's cwd, with a log line — a lost registry entry
shouldn't stop a root-directory cron from firing, but it shouldn't run somewhere
unexpected in silence either.

**Time zones.** `nextRunFor` reads a `daily` in an explicit IANA zone, resolved
by `cronTimeZone`: the cron's own `tz`, else the global default (config
`timezone`, exposed as `GET`/`POST /timezone`), else the machine's. Without that
the hour silently follows the machine, and a server running in UTC shifts every
daily cron. Two details the tests lock down: the next occurrence is the next
**calendar** day, not `+24h` (a DST day is 23 or 25 hours long, and 09:00 must
stay 09:00), and `instantOfWallClock` does **two** passes over the UTC offset,
because the offset depends on the instant you're still looking for — one pass was
an hour wrong on both switchover days. `scheduleLabel` always prints the zone for
a `daily`: a bare "daily at 09:00" doesn't say 09:00 *where*.

**Firing, and losing a fire.** `cronTick` advances `nextRun` *before* firing —
that's what stops a long run from double-firing — and `cronsFiring` holds the
slot until `fireCron` settles. `driveChannel` returns a typed `DriveOutcome`, and
`settleCron` replays a **transient** miss (`pace-blocked`, `busy`, `ws-error`,
`exited`) about 10 minutes out via `nextRunAfterFailure`, capped at 3 attempts
and **never past the next normal slot**. Non-transient is never replayed:
`error` is an application-level refusal that won't evaporate in 10 minutes,
`gone` means the channel's directory is really absent (the resume already tried
to recreate a worktree checkout), and `timeout` means the turn is *still
running*, so replaying would stack two prompts
on one channel. `lastOutcome` is persisted, so the JSON store alone tells you
what happened without reading logs — and every fire logs one `cron: <id8> …`
line, **including the quiet one**, because otherwise "ran, found nothing" and
"never ran" are indistinguishable (invariant #15).

**Ids are addressed by prefix.** Every surface — web, skill, Telegram — prints
only the first 8 characters of a cron id, so `resolveCronId` accepts a prefix.
It is pure and total: an empty prefix and an ambiguous prefix are both
**refused**, never resolved arbitrarily. Strict equality plus an unconditional
`{ok:true}` used to mean "deleted" while deleting nothing, and a bare
`/cron del` wiped whichever cron came first (invariant #17).

Surfaces: `GET`/`POST`/`DELETE /crons`, the `⏰` on a channel tab (fed by the
**derived** `crons` field that `GET /channels` computes and never stores — see
invariant #6), Telegram's `/cron every 30m …` / `daily HH:MM …` / `list` / `on` /
`off` / `del`, and the `shadok-scheduler` skill.

**Staying silent.** A cron with nothing to say must be able to produce no
message at all. `isNothingToShow` (`src/tail.ts`) drops a text block that is
*only* `NOTHING TO SHOW`; twin filters live in `loadHistory` and in the web live
preview, so the placeholder never surfaces on any of the three paths.

## Parent and child agents (`src/kinship.ts`)

An agent that spawns another is recorded as its **parent** (`Channel.parent`,
server-owned and persisted, so the tree survives the auto-update restart that
would otherwise orphan every child). The child stores its parent and never the
reverse: one writer per fact, and the two directions cannot disagree.

The link is set automatically at spawn — `pilotctl` reads `SHADOK_SESSION_ID`,
which the server already exports on every piloted session, so nothing has to be
configured — or by hand through `set-parent`, the only path allowed to write a
server-owned field. `linkRefusal` refuses a self-link, a cycle, an unknown
parent, and anything past `MAX_LINK_DEPTH` / `MAX_FANOUT`, always **explicitly**:
the silent version would leave a parent believing it will be notified, waiting
for a child it was never linked to.

**Scoping is the point.** A parent hears about its own children and nothing
else. Without it a chatty Telegram channel would wake a boss on every turn, and
a wake is not free: measured on this repo's transcripts, an API call re-reads
~359k tokens of prefix, about 36k effective per wake in a large session. That
same arithmetic is why the payload is the child's own summary plus pointers
(branch, `/diff` link) and **never the diff** — the parent fetches it if it
decides it needs one.

Delivery reuses `driveChannel`, the function crons already use, so a child's
completion is indistinguishable from a cron firing, which is indistinguishable
from a human typing. It is fire-and-forget: awaiting would hold the *child's*
`finishTurn` open for as long as the parent takes to think.

Two hooks suffice. `finishTurn` covers a completed turn; `publishDialog` covers
a pending question — and that one is a single funnel only because invariant 23
moved dialog detection into the screen watcher, so raw `key` input goes through
it too. Its dedup on `dialogKey` is what makes hooking there affordable at all,
since the watcher runs several times a second. A death notifies as well: a
failure that says nothing is indistinguishable from a run with nothing to say
(invariant 15), and the parent would wait forever. A child whose whole answer is
`NOTHING TO SHOW` wakes nobody, and `loadHistory` filters `AGENT_PROMPT_MARK`
beside the cron mark so a notification never resurfaces on a reload or backfill.

`parentInbox` holds notifications for a parent that is mid-turn, since a prompt
sent during a turn is refused with `code:"busy"`. `flushParentInbox` runs in
`finishTurn`'s `finally`, **after** `busy` is cleared — any earlier and it would
hit the very refusal the queue exists to avoid. It doubles as free batching: a
parent is busy precisely when it is working, so several children coalesce with
no timer, and one wake carries the batch instead of re-paying the prefix N times.

**Two bounds and one caveat.** `MAX_LINK_DEPTH` and `MAX_FANOUT` stop a
notification→spawn→notification cascade, which the pace guard cannot bound (it
blocks one prompt at a time, never a chain). And answering a child's dialog is a
**profile capability** (`canAnswerChildren`, set only on `Shadok-Boss`), not an
ambient right: a `READONLY_DENY` boss could otherwise authorise a child to do
what it is itself forbidden from doing, making the guardrail that forces
delegation bypassable by delegating.

Known cost, written down rather than discovered later: the parent's context
grows with every notification and it re-pays that prefix on every wake. That is
a curve, not a plateau. The mitigation is the deferred agent-fork idea — fan
out, synthesise, fork to start light on the next batch.

## Spawning agents (`shadok-ai-agents` skill)

`pilotctl.mjs` is a thin WS/HTTP client so an agent (or a human script) can
`spawn` / `prompt` / `choose` / `diff` other agents through the same server —
each spawned agent is visible in `/live` ("Agents running now" in the UI).
Spawned prompts respect the pace gate; a block is currently silent to the
parent (a known rough edge).

## Known rough edges / debt

- Much was built in low-visibility agent sessions; detection heuristics,
  `pilotctl`, `/live`, auto-retry and pace are the least-reviewed areas — most
  past bugs were found there.
- Agents run in parallel and a parent now hears back from the ones it launched,
  but nothing *orchestrates* them: there are no declarative pipelines ("when A
  finishes, run B"), and nothing gates the quality of their work before it lands.
  The parent is a model; the notification only gives it the information.
- Landing/merge was the #1 source of breakage (blind merges, conflict markers).
  The `pr-merge` skill now carries that flow, but it is a *procedure*, not an
  enforced gate: nothing structurally prevents a blind merge in the shared
  checkout.
- Agent worktrees are branched from HEAD at spawn and never rebased, so a
  long-running agent drifts from a moving main. A full design exists and was
  **deliberately deferred** — see
  `docs/superpowers/specs/2026-07-28-worktree-rebase-drift-design.md`. Only its
  section 1 has landed: the frozen `baseSha` is gone, `gitDiff` and
  `listPastSessions` compute the fork point live (`merge-base` off the repo's
  own branch), so the diff panel and the recover list show the agent's own work
  whatever the base did — rebased or not. The drift itself (telling the agent
  main moved, and the rebase procedure) is still open.
- The interactive terminal (raw byte plane) is **experimental** and tmux-only. It
  deliberately breaks the "screen is control only" rule, and it has no equivalent
  under node-pty.
- **Token spend is measured but not attributed.** `src/tail.ts` parses the four
  numbers that matter (`input`, `output`, `cacheCreation`, `cacheRead`) and
  `tokenTotals` broadcasts them per session, but `origin` is a local variable
  that only feeds `prompt-echo`. Nothing joins the two and nothing persists
  them, so "what did the crons cost this week" is unanswerable today.
- Profile guardrails are soft (same OS user). Anything needing real containment
  is not covered today.
