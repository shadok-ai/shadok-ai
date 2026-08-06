# shadok-ai

A **web cockpit that drives multiple real Claude Code sessions in parallel** —
each channel is one `claude` process, on your Claude subscription (not the API).
Pilot them from a browser **and** from **Telegram** (one topic = one agent),
with git-worktree isolation, agent profiles, a secret vault, a diff panel,
scheduled prompts, and quota gauges.

## Quick start

```bash
npx shadok-ai
```

Then open **http://localhost:3789**.

**Prerequisites:** Node ≥ 20 and the [`claude`](https://claude.com/claude-code)
CLI installed and signed in on the machine (shadok-ai drives your existing
Claude Code, on your subscription). `tmux` is optional but recommended — with
it, agents survive the server restarting.

On the first run it asks once for an optional **Telegram bot token** (press
Enter to skip; you can add it later from the web UI).

| Flag | Effect |
|---|---|
| `--port, -p <n>` | HTTP/WS port (default 3789; falls back to the next free one) |
| `--no-telegram` | web-only; don't prompt for or use a bot token |
| `--password <p>` | require this password to open the GUI (stored in config) |
| `--version, -v` · `--help, -h` | version / help |

## What you get

- **Channels** — one `claude` process each, running in parallel. Renaming,
  grouping, and closing all sync live between the browser and Telegram: it's
  one list, server-owned, not two copies.
- **Worktree isolation** — spawned agents get their own git worktree and branch
  by default, so parallel agents never collide. Work is never auto-discarded:
  an empty worktree is reclaimed on close, anything with changes or commits
  stays (and `Recover` reopens it).
- **Interactive dialogs** — the TUI's permission prompts and multiple-choice
  questions become clickable buttons in the chat, and an inline keyboard in
  Telegram.
- **Agent profiles** — a named bundle of role prompt, permission guardrails
  (e.g. forbid `git commit`), model, and which secrets to inject. Applied at
  spawn, remembered across resume.
- **Secret vault** — stored under `~/.shadok-ai`, never in your repo, injected
  as env vars into the agents that need them.
- **Scheduled prompts** — give a channel a recurring prompt (every N minutes, or
  daily at HH:MM in a time zone you choose) for monitoring and reporting. Each
  schedule can carry a **deterministic guard command** that runs *without the
  model*: prints nothing → nothing to report, the agent is never woken and the
  run costs **zero tokens**; prints something → that output is prepended to the
  prompt and the agent runs. A watcher that is quiet most of the day costs
  nothing most of the day.
- **Quota gauges + pace guard** — 5h and 7d subscription usage, with an
  optional block when you're burning faster than the window elapses (any
  message can force through).
- **Notifications** — favicon, title badge and an optional sound when an agent
  needs you. It only blinks when the tab is hidden *and* an unmuted channel is
  actually waiting.
- **Engine room** — the raw TUI screen, live, with clickable keys, for anything
  the chat can't express. With tmux there is also an **experimental real
  terminal** (xterm.js over the pane's byte stream) when a snapshot isn't enough.
- **Diff panel** — what an agent actually changed, against its base.
- **Tweak Shadok-AI** — a card pinned at the bottom of the agents column. One
  click clones shadok-ai's own source into `~/.shadok-ai/self/shadok-ai` and
  starts an agent on it in its own worktree; that agent delivers its change as a
  **pull request** — a fork under your GitHub account, since you need no rights
  on the repo. Nothing to configure and no token to paste: the clone is
  anonymous, so you describe an idea, watch it work and read the diff first, and
  it only asks for GitHub (via `gh auth login`, device code relayed in the chat)
  when there is something worth pushing. It is **one channel, not a launcher**:
  the card becomes that channel's tab, with the usual menu — mute, reload,
  rename, change profile, mirror to Telegram, close — and closing it brings the
  card back. Desktop only: the agents column is hidden on phones.
- **Self-update** — polls npm and can update and reload itself in place.

### Telegram (optional)

Add your bot to a group with **Topics** enabled, make it an admin with *Manage
topics* (and *Delete messages* so `/secret` can scrub values), then in the group:

| Command | |
|---|---|
| `/setup` | bind this group as the board (one group per instance) |
| `/spawn [profile] <name>` | new isolated agent in its own topic (also a web tab) |
| `/stop` (alias `/esc`) | interrupt the current turn — does **not** end the session |
| `/new` · `/end` | reset · kill the session |
| `/restart` | respawn the agent in place (e.g. to pick up new secrets) |
| `/profiles` · `/list` | list profiles · list bindings |
| `/cron every 30m <prompt>` · `/cron daily 09:00 <prompt>` | schedule a recurring prompt on this agent |
| `/cron list` · `/cron on\|off\|del <id>` | manage them (`<id>` accepts the printed 8-char prefix) |
| `/secrets` · `/secret KEY value` · `/unsecret KEY` | the secret vault |
| `/update` | fetch `@latest` and respawn |

Creating a topic by hand also spawns an agent. Anything that isn't a command is
sent to that topic's agent as a prompt — including photos and files, which are
downloaded and handed to Claude Code.

**Direct messages belong to one person.** The first user to DM the bot claims it;
everyone else is refused. On startup the owner is adopted from an existing DM or
from the board group's creator, so an instance that already has an owner never
hands itself to whoever messages next — a bot username is public, and a DM is a
shell.

### Exposing it beyond this machine

The cockpit runs arbitrary commands on the host by design, so it binds
`127.0.0.1` — **this machine only** — unless you say otherwise. Two things to
know before opening it up:

- `SHADOK_HOST=0.0.0.0` **requires a password** (`--password`, or
  `SHADOK_GUI_PASSWORD`); without one the server refuses to start rather than
  hand the network a shell.
- **In Docker**, `SHADOK_HOST=0.0.0.0` is the only value that works (the
  container's own loopback isn't reachable from the host). Publish the port on
  the host's loopback: `-p 127.0.0.1:3789:3789`. Plain `-p 3789:3789` publishes
  on every host interface **and bypasses ufw/firewalld**, because Docker inserts
  its own iptables rules upstream of them.

Browsers may only talk to the cockpit from its own origin — a WebSocket ignores
the same-origin policy, so without that check any page you happen to visit could
drive your agents. Behind a reverse proxy that rewrites `Host`, list the public
origin in `SHADOK_ORIGINS`.

### Behind TLS (nginx, Caddy…)

Serving the cockpit over HTTPS works, with one requirement: **the proxy must
forward the WebSocket upgrade**. Everything live — the channel list included —
travels over `/ws`, and the page itself is static HTML, so a proxy that drops
`Upgrade`/`Connection` produces a cockpit that loads perfectly and then never
connects. In nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3789;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

The client picks `wss://` on its own when the page is HTTPS, so there is nothing
to configure on that side.

### SSH identity in Docker

When shadok-ai runs **in a container** it gives itself an SSH key on first boot
so agents can `git clone/push` private repos and `ssh` into servers. The key
lives under `~/.shadok-ai/ssh/` — i.e. on the **`shadok-data` volume you already
mount** — so it **survives `docker restart` and `docker rm`+recreate** (unlike a
plain `~/.ssh`, which is wiped on recreate). Each container has its own volume,
hence its own unique key; `~/.ssh` is symlinked to it, so `git`/`ssh` use it with
no extra config. Nothing to add to `docker run`.

Read the public key to register it (GitHub **deploy key**, or the target hosts'
`authorized_keys`):

```
docker logs <name> | grep 'ssh identity'          # printed on every boot
docker exec <name> cat /root/.shadok-ai/ssh/id_ed25519.pub
```

On a normal (non-Docker) host this is a **no-op** — shadok never touches your
`~/.ssh`. Detection is `/.dockerenv`; `SHADOK_SSH_IDENTITY=0` disables it,
`SHADOK_FORCE_SSH_IDENTITY=1` forces it on.

### Configuration

Config lives in `~/.shadok-ai/config.json` (mode 600) and is **authoritative
over the environment once set** from the GUI. The Telegram token, allowed
chats, and the bridge on/off switch are **per launch directory** — running the
server from another repo gives you a different cockpit and a different bot. So
are the channel list and the scheduled prompts.

`timezone` (an IANA name like `Europe/Paris`, settable via `/timezone`) is the
default zone for reading a `daily` schedule. Without it the hour follows the
machine, which silently shifts every daily prompt on a server running in UTC.

| Env var | |
|---|---|
| `PORT` | HTTP/WS port |
| `SHADOK_HOST` | interface to bind (default `127.0.0.1`, this machine only) |
| `SHADOK_GUI_PASSWORD` | require a password for the GUI |
| `SHADOK_ORIGINS` | extra browser origins allowed, comma-separated (reverse proxy) |
| `SHADOK_TMUX=0` | force the node-pty transport instead of tmux |
| `SHADOK_IDLE_MIN` | minutes with no client before a session is reclaimed (60) |
| `SHADOK_PERMISSION_MODE` | mode new agents start in (default `acceptEdits`) |
| `SHADOK_AUTOUPDATE` | fallback only — the GUI setting wins once used |
| `SHADOK_PILOT_PROMPT=0` | don't inject the cockpit system prompt |
| `SHADOK_RESUME_SUMMARY=1` | don't auto-answer the resume-from-summary prompt |
| `SHADOK_SSH_IDENTITY=0` · `SHADOK_FORCE_SSH_IDENTITY=1` | disable / force the Docker SSH identity |
| `TELEGRAM_BOT_TOKEN` · `TELEGRAM_ALLOWED_CHATS` | override the stored config |
| `CLAUDE_CODE_OAUTH_TOKEN` | only for the usage gauges; `claude` itself uses the keychain |

---

> **Hacking on shadok-ai?** Read [`CLAUDE.md`](CLAUDE.md) (map, build/run,
> invariants) and [`docs/architecture.md`](docs/architecture.md) first.

### Keeping the docs honest

Three documents, three jobs — and **they ship with the change that makes them
wrong**, not in a catch-up pass afterwards:

| Document | Holds | Update it when |
|---|---|---|
| `README.md` | what shadok-ai does and how to drive it | a user-visible feature, flag, command, endpoint or protocol message changes |
| `CLAUDE.md` | the file→responsibility map, the build/run recipe, the invariants | you add a module, or you lose an afternoon to something the next person would lose it to as well |
| `docs/architecture.md` | how a subsystem actually works and why it was built that way | you add or reshape a subsystem, or you make a design trade-off worth remembering |
| `docs/superpowers/specs/` | one design per feature, dated | before building anything non-trivial |

This is not bookkeeping. A doc that lags is worse than no doc: it is confidently
wrong, and it is read as current. `docs/architecture.md` once went **48 commits**
without an update, and by then it was missing entire subsystems while its line
references pointed at code that had moved hundreds of lines — a reader in that
window gets misled, not merely under-informed.

Two habits that keep it cheap:

- **Cite symbols, not just line numbers.** `finishTurn` survives a refactor;
  `server.ts:781` does not. Where a line number helps, say which commit it was
  read at.
- **Write the *why*, not the *what*.** The what is in the diff. What the diff
  cannot say is which alternative you rejected and what it cost you to find out —
  that is the whole value of `architecture.md`, and the reason the invariants
  list reads like a scar tissue map.

## How it works

Drives the **Claude Code TUI** (the interactive `claude` CLI) through a real
terminal, and reads the answers from Claude Code's own transcript.

> ⚠️ The Claude Code TUI is not a stable API: a CLI update can break the
> detection heuristics (`❯`, `⏺`, `esc to interrupt` markers).
> For production use, prefer the
> [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
> or `claude -p --output-format stream-json`.

Two transports, same interface:

- **tmux (default when installed)** — `claude` runs in a detached tmux session,
  so it survives the server restarting or crashing and is reattached on the
  next start. tmux answers terminal queries itself, which removes a whole class
  of PTY hacks. It does not survive a machine reboot.
- **node-pty** — `claude` runs as a child of the server inside a pseudo-terminal
  (the TUI believes it talks to a human), with **@xterm/headless** replaying the
  ANSI stream into a virtual screen we can read. Terminal query responses
  (cursor position `\x1b[?6n`, identification `\x1b[c`…) must be forwarded back
  to the PTY, or the TUI ignores every keystroke. Dies with the server.

In both cases prompts are sent via **bracketed paste** with retries (the TUI
flushes stdin received during initialization), and "Claude is done" is detected
heuristically: no `esc to interrupt` marker + screen stable for N ms.

**Responses are not scraped from the screen.** Claude Code writes every turn to
a `.jsonl` transcript; that file is the source of truth for chat content, which
is what makes long answers reliable. The screen is used only for control —
submitting, detecting the end of a turn, reading dialogs, and mirroring the raw
TUI in the engine room.

## Build & test

```bash
npm install
npm run build      # tsc → dist/
npm test
npm run web        # run the server directly (no supervisor, no auto-update)
```

The `postinstall` script fixes the executable bit of node-pty's
`spawn-helper` (a known npm prebuilds bug on macOS).

Note that `npx shadok-ai` does **not** run your working tree: it runs a
supervisor that manages an auto-updating npm-installed copy. To test a local
build, see "Running YOUR build" in [`CLAUDE.md`](CLAUDE.md).

## One-shot CLI

Separate from the cockpit: run a single prompt and print the answer.

```bash
shadok-ai-run [options] "<prompt>"      # or: node dist/cli.js …

  --cwd <dir>       working directory of the claude session
  --continue, -c    resume the latest session of this directory
  --resume <id>, -r resume a specific session (id printed at end of run)
  --watch           mirror the TUI live on stdout
  --keep            keep the session open at the end
  --timeout <sec>   max wait for the response (default 600)
```

Without `--continue`/`--resume`, every run starts a **new** session. The
session id is printed at the end of the run (found in
`~/.claude/projects/<encoded cwd>/`, like any Claude Code session):

```bash
shadok-ai-run --cwd ~/my-project "Explain this project's structure"
# ▶ session: 5fe046dd-…

shadok-ai-run --cwd ~/my-project --resume 5fe046dd-… "Now refactor it"
shadok-ai-run --cwd ~/my-project -c "Continue on the latest session"
```

## WebSocket protocol (to replace the interface)

The interface is a plain static page: all the intelligence lives server-side.
Any client (another front-end, a bot, a script…) can replace it by speaking
this JSON protocol on `ws://…/ws`. The built-in Telegram bridge *is* such a
client — it connects to the same server over loopback.

**Shared sessions**: the server keeps a single claude process per session id.
If several clients (tabs, browsers, interfaces) `start` the same id, they
attach to the same process and all receive the same events — other clients'
prompts (`prompt-echo`), answers, dialogs, screen. Closing a connection
detaches the client; the session is reclaimed after `SHADOK_IDLE_MIN` with no
client, or immediately on an explicit `stop` (which ends it for everyone).

**client → server**

| Message | Purpose |
|---|---|
| `{type:"start", cwd?, resume?, continue?, worktree?, branch?, repo?, profile?, origin?}` | starts or attaches to the session (once per connection). `origin` (`"web"`, `"cron"`, `"telegram"`, `"cli"`…) travels with `prompt-echo` so other clients can say who spoke |
| `{type:"prompt", text, force?}` | sends a prompt (`force` bypasses the pace guard) |
| `{type:"choose", n}` | single-select dialog: picks and validates option n |
| `{type:"toggle", n}` / `{type:"confirm"}` | multi-select: toggles option n / submits |
| `{type:"freetext", n, text}` | "Type something" option: sends a free-form answer |
| `{type:"key", key}` | raw keystroke (`enter`, `escape`, `up`, `down`, `tab`, `ctrl-c`, or a single character) |
| `{type:"settle"}` | after a manual intervention: waits for the turn to finish |
| `{type:"restart"}` | respawns the agent in place (picks up new secrets/profile) |
| `{type:"term-attach"}` · `{type:"term-detach"}` | **experimental, tmux only** — open/close the pane's raw byte pipe |
| `{type:"term-input", data}` · `{type:"term-resize", cols, rows}` | raw input (base64) / match the pane to the viewport |
| `{type:"stop", sessionId?}` | ends the session for all clients; `sessionId` targets another channel (zombie cleanup) |

**server → client**

| Message | Purpose |
|---|---|
| `{type:"ready", sessionId, cwd}` | session started (or attached) |
| `{type:"working"}` / `{type:"turn-done", sessionId}` | turn started / finished |
| `{type:"stream-text", text, at?}` | a complete assistant text block, from the transcript. `at` is when it was **written**, not when we read it |
| `{type:"stream-tool", id, name, summary}` / `{type:"stream-result", …}` | tool call / tool result |
| `{type:"tokens", tokens}` / `{type:"context", pct}` | token usage / context fill |
| `{type:"prompt-echo", text}` | prompt sent by another client of the session |
| `{type:"dialog", question, options:[{n,label,hint,checked?}], multi}` | choice pending |
| `{type:"history", turns:[…]}` | transcript replayed when resuming/attaching |
| `{type:"screen", text, working}` | rendered TUI screen (whenever it changes) |
| `{type:"pace-blocked"}` / `{type:"pace-hold"}` / `{type:"pace-resumed"}` | quota guardrail |
| `{type:"auto-retry"}` / `-cancelled` / `-gave-up` | transient API error being retried |
| `{type:"version", …}` / `{type:"server-reload", version}` | update available / server updated, reload |
| `{type:"term-data", data}` | **experimental** — raw pane output (base64) for a client-side terminal emulator |
| `{type:"gone"}` / `{type:"error", message, code?}` / `{type:"exited", code}` / `{type:"stopped"}` | session lost, errors, termination. `error.code` is `"busy"` for a prompt refused mid-turn, so a machine client needn't match on the message text |

HTTP endpoints (same auth): `/usage`, `/live`, `/sessions`, `/recover`,
`/diff`, `/channels` (its GET adds a **derived** `crons` field — never stored),
`/channel` (DELETE), `/groups`, `/crons`, `/timezone`, `/profiles`, `/secrets`,
`/telegram`, `/defaults`, `/version`, `/autoupdate`, `/permission-mode`,
`/tweak/prepare` (POST — clone/refresh shadok-ai's own source, returns the cwd
to start the tweak agent in).

## Library

```js
import { PtyPilot } from "shadok-ai";

const pilot = new PtyPilot({ cwd: "/my/project" });
pilot.start();
await pilot.waitForIdle();                 // TUI ready

await pilot.submit("Fix the bug in auth.ts");
await pilot.waitForIdle({ timeoutMs: 600_000 });
console.log(pilot.screen());               // rendered screen (visible transcript)

await pilot.submit("Now add a test");      // same session, second turn
await pilot.waitForIdle();

await pilot.stop();                        // clean /exit, kill as fallback
```

Main API:

| Method | Purpose |
|---|---|
| `start()` / `stop()` / `kill()` | process lifecycle |
| `submit(text)` | types a prompt + Enter, with verification and retries |
| `write(text)` / `press(key)` | low-level keystrokes (`enter`, `escape`, `up`, `tab`, `ctrl-c`…) |
| `screen()` / `fullBuffer()` | rendered screen / full buffer |
| `waitForIdle({stableMs, timeoutMs})` | waits for the end of a turn |
| `waitFor(predicate)` | waits for an arbitrary screen condition (dialogs, permissions…) |
| `isWorking()` | true while Claude is working |
| `onData(cb)` / `onExit(cb)` | raw ANSI stream (mirror mode) / process exit |

`TmuxPilot` exposes the same surface and additionally survives a server
restart. `examples/two-turns.mjs` shows a two-turn conversation;
`debug/probe.mjs` logs the terminal sequences exchanged (useful when a CLI
update breaks the detection).

## Known limits

- Every session launched consumes your Claude quota like a normal session.
- Profile guardrails are **soft**: agents run as the same OS user. It prevents
  misfires, it is not a sandbox.
- Agent worktrees are branched at spawn and never rebased, so a long-running
  agent drifts from a moving main branch. A design for this exists and was
  deliberately deferred:
  `docs/superpowers/specs/2026-07-28-worktree-rebase-drift-design.md`.
- The interactive terminal (xterm.js over the raw pane stream) is
  **experimental** and requires tmux; with node-pty the engine room is all there
  is.
- Dialogs the chat cannot handle in one click are managed through the
  engine room (`waitFor()` + `press()` in library mode).
- The TUI runs in the alternate screen: `fullBuffer()` ≈ visible screen;
  very long responses scroll out of view (increase `rows` if needed).
