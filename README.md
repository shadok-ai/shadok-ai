<div align="center">

<h1>shadok-ai</h1>

<h3>Many Claude Codes. One cockpit. And it wrote itself.</h3>

<p>Run <b>real</b> Claude Code sessions side by side, each in its own git worktree,
on the Claude subscription you already pay for. When one of them has a question,
you answer it with a click — in the browser, or from Telegram when you are not
at the desk.</p>

<p>
<a href="https://www.npmjs.com/package/shadok-ai"><img alt="npm" src="https://img.shields.io/npm/v/shadok-ai?color=F5A524&amp;label=npm"></a>
<a href="LICENSE"><img alt="licence AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-7C6CF0"></a>
<a href="https://shadok.ai"><img alt="shadok.ai" src="https://img.shields.io/badge/shadok.ai-F5F0E6?labelColor=08090D"></a>
</p>

<p><code>npx shadok-ai</code></p>

<a href="https://shadok.ai"><img width="720" alt="The cockpit: three agents running in parallel, one of them asking a multiple-choice question that is answered with a click, then the diff it wrote" src="https://shadok.ai/demo.gif"></a>

</div>

**It does not stop at one.** An agent can start other agents — each with its own
worktree, branch and role — and it is told when one of its own finishes, blocks on
a question, or dies. Nothing else wakes it.

**It keeps working when you are not there.** Mirror an agent to a Telegram topic
and answer from your phone, one topic per agent. Put a prompt on a schedule with a
**guard that runs without the model**: prints nothing, nothing happened, zero
tokens spent.

**It stays on a leash.** A profile is a role plus guardrails — forbid `git commit`
and the agent cannot commit. Secrets live in a vault outside your repository and
are injected only into the agents that need them. Quota gauges show the 5h and 7d
windows, and can hold an agent back when it is burning faster than the window
elapses.

**It wrote itself.** shadok-ai is largely built by agents running inside shadok-ai,
in their own worktrees, landed as reviewed pull requests. The section below is what
that produced.

## Quick start

```bash
npx shadok-ai
```

It **opens your browser** for you once the server is listening — at the port it actually landed on, which is not always 3789 (a busy port walks to the next free one). Only on the launch you asked for: an auto-update respawn never pops a tab. Skipped where it would make no sense — in a container, over SSH, or on a Linux box with no display — and `--no-open` turns it off.

**Prerequisites:** Node ≥ 20. shadok-ai drives the
[`claude`](https://claude.com/claude-code) CLI on **your** Claude subscription —
if it isn't installed, the cockpit installs it for you on the first agent launch
(`npm i -g @anthropic-ai/claude-code`; if that can't write the global dir it
tells you the one command to run). Either way you sign in to your Claude account
**once** on first use — that step is yours and can't be skipped (see below).
`tmux` makes agents survive the server restarting, so shadok-ai **auto-installs
it** at boot if it's missing (`brew` on macOS, `apt`/`apk`/`dnf`/`pacman` on
Linux — with `sudo` when not root). If it can't (no package manager, or a sudo
password it can't provide), it falls back to node-pty and tells you the one
command to run. `SHADOK_TMUX=0` skips all of that.

On the first run it asks once for an optional **Telegram bot token** (press
Enter to skip; you can add it later from the web UI).

| Flag | Effect |
|---|---|
| `--port, -p <n>` | HTTP/WS port (default 3789; falls back to the next free one) |
| `--no-telegram` | web-only; don't prompt for or use a bot token |
| `--no-open` | don't open the browser on launch |
| `--password <p>` | require this password to open the GUI (stored in config) |
| `--version, -v` · `--help, -h` | version / help |

## What you get

- **Channels** — one `claude` process each, running in parallel. Renaming,
  grouping, and closing all sync live between the browser and Telegram: it's
  one list, server-owned, not two copies.
- **Groups** — on a desktop the groups live in their own **left column**: pick
  one to narrow the agents pane to it, and the global tools (Profiles, Ledger,
  Secrets, Users, Security, Telegram, Sound) stay in the header at the top. Each
  agent is a round avatar with a presence dot (green ready, red working, hollow
  offline). A group's icon opens the icon picker: choose from the grid, type any
  emoji, or **type a word** (`rocket`, `bug`, `money`…) to search for one; its
  **＋** creates the new agent straight into that group. Dragging an agent onto a
  group files it there, dragging groups reorders them, and double-clicking a name
  renames it. A question the agent asks shows as an *Approval requested* card. The
  whole cockpit is skinned like Microsoft Teams (grey light mode / near-black dark
  mode, the Shadok mark in the header). On a phone the tools sit in the ⋯ menu and
  the agents sheet lists every group.
- **Worktree isolation** — spawned agents get their own git worktree and branch
  by default, so parallel agents never collide. Work is never auto-discarded:
  an empty worktree is reclaimed on close, anything with changes or commits
  stays (and `Recover` reopens it).
- **Interactive dialogs** — the TUI's permission prompts and multiple-choice
  questions become clickable buttons in the chat, and an inline keyboard in
  Telegram. The card carries the prompt's own text too — what it will run or
  read, and Claude Code's warnings such as a read leaving the working directory
  through a symlink — so you approve what the terminal would have shown you.
- **Thinking effort** — how hard an agent thinks before answering (`--effort`),
  set on a role in the Profiles panel and overridable per agent from its menu.
  Higher levels cost more tokens, and thinking tokens are billed even when they
  stay collapsed, so the picker says so. There is deliberately no thinking
  on/off switch: current models always think, and the settings that used to
  disable it are ignored by them — a toggle would change nothing.
- **Agent profiles** — a named bundle of role prompt, permission guardrails
  (e.g. forbid `git commit`), model, and which secrets to inject. Applied at
  spawn, remembered across resume.
- **A model per agent** — the creation form picks the model this one agent runs
  on, overriding its profile's, with a **long context (1M)** tick beside it.
  Pick a family (Opus, Sonnet, Haiku, Fable) and it follows Claude Code's
  releases, or fold out **Pin an exact version** — that list is read from the
  installed `claude` binary, so a model Anthropic ships appears on its own at
  the next Claude Code update, with nothing to maintain here. Leave it on
  *profile default* and nothing changes: no flag is sent at all. The choice is
  stored on the agent, so a resume or a restart keeps it, and the quota gauge
  meters it against the window it actually asked for.
- **A default model for the machine** — ⋯ → the version menu → *Default model*,
  beside the permission mode. It writes Claude Code's own `settings.json`, which
  is already the last step of the resolution chain (**agent → profile →
  machine**), and applies at each agent's next spawn. Agents that carry no model
  of their own simply follow Claude Code's default, which tracks the newest
  model — so this is for **pinning** one, not for getting the latest. Eight roles ship with it: a lead that
  delegates, a dev, a QA agent that writes the failing test and cannot fix the
  code it covers, a release agent that prepares a deployment and leaves the
  trigger to you, a product agent that writes the spec instead of the change,
  and three go-to-market roles (paid, organic, support). Each one is yours to
  edit, and a role you delete stays deleted.
- **Which account, and when it expires — and re-login before it does** — the
  version menu shows the Claude login this cockpit runs on (its email and
  subscription) and when its sign-in **expires** — i.e. when a re-login will be
  needed. The timestamp is read from Claude Code's own credentials store, never
  the token itself; the short-lived access token refreshes on its own, so the
  figure shown is the session deadline, not that rotation. A **↻ Re-login to
  Claude** button right there signs you in again without waiting for the lapse,
  and in the last **48 hours** (or once it has lapsed) a reminder **banner**
  carries the same one-click re-login — so your agents never quietly start
  hitting `401` because nobody renewed the session.
- **Secret vault** — stored under `~/.shadok-ai`, never in your repo, injected
  as env vars into the agents that need them. Add or **update** a secret from the
  panel, tick the **profiles** it should feed right there, and reload the running
  agents on those profiles in one click so a rotated value takes effect now. An
  agent that **obtains** a credential (a CLI login, a key it just provisioned)
  can add it to the vault itself so the next agent doesn't start from nothing —
  write-only, the value piped in rather than typed as an argument, and never
  overwriting an existing name without you saying so. It can also **attach that
  secret to its own profile** and reload itself to pick it up — but only a
  secret it stored itself: a value you typed, or one another role stored, stays
  yours to attach from the panel.
- **Scheduled prompts** — give a channel a recurring prompt (every N minutes, or
  daily at HH:MM in a time zone you choose) for monitoring and reporting. Each
  schedule can carry a **deterministic guard command** that runs *without the
  model*: prints nothing → nothing to report, the agent is never woken and the
  run costs **zero tokens**; prints something → that output is prepended to the
  prompt and the agent runs. A watcher that is quiet most of the day costs
  nothing most of the day.
- **Agents that report back** — an agent that launches other agents is told when
  each one finishes, blocks on a question, or dies. It hears about **its own**
  children and nothing else, so a busy channel never wakes it. What arrives is
  the child's own summary plus pointers (branch, diff link) — never the diff
  itself, which on a large session costs far more than it is worth. The link is
  set automatically at spawn; you can also attach or detach an agent by hand
  from its ⋯ menu.
- **Quota gauges + pace guard** — 5h and 7d subscription usage, with an
  optional block when you're burning faster than the window elapses (any
  message can force through).
- **Notifications** — favicon, title badge and an optional sound when an agent
  needs you. It only blinks when the tab is hidden *and* an unmuted channel is
  actually waiting.
- **Engine room** — the raw TUI screen, live, with clickable keys, for anything
  the chat can't express. With tmux there is also an **experimental real
  terminal** (xterm.js over the pane's byte stream) when a snapshot isn't enough.
- **Voice notes on Telegram** — send a voice message to an agent's topic and it
  is transcribed locally, then acted on. What was understood is echoed back
  first (`🎙 « … »`), so a misheard instruction is visible before it runs —
  and the agent is told the words were **spoken**, so it asks about an odd
  file name or branch instead of acting on a mishearing.
  Transcription is installed **on first use** — a static ffmpeg, whisper.cpp and
  a 181 MB model — and the topic says so rather than going quiet for minutes.
  `SHADOK_WHISPER_MODEL` picks a bigger one if your recordings need it.
  Set `SHADOK_WHISPER_DIR` to a directory shared between containers and one copy
  serves them all.
- **Videos on Telegram** — share a video (or a GIF, or a round video note) and
  the agent actually sees it: shadok pulls a handful of stills out of the clip
  for it to look at, and transcribes the sound when there is speech. Both run
  on the same locally-installed toolchain as voice notes, so nothing leaves the
  machine. Clips longer than two minutes keep their stills and the prompt says
  the audio was left unheard — ask and the agent can listen. Telegram caps what
  a bot may download at 20 MB; past that you get a clear notice instead of
  silence.
- **Link to a message** — every message (yours and the agent's) has a 🔗 link
  button beside copy. It copies a URL like `…/#agent=<session>&msg=<id>`;
  whoever opens it — someone who already has access to this cockpit, after the
  usual sign-in — lands on that agent, scrolled to that message, highlighted.
  The link lives in the URL's `#` part, so it never reaches the server or a
  proxy log. A message older than the history shown (the last 100 turns), or an
  agent that was closed, says so instead of opening somewhere else.
- **Run the command an agent asks you to** — when an agent writes `! cmd` for
  you to run (typically because it cannot), a ▶ run button sits right on that
  command's code block, beside its copy button — so it runs where it was
  written, not in a list below. (An inline `` `! cmd` `` with no block of its
  own still gets a button under the message.) It runs in the agent's shell after
  a confirmation showing the exact command, and is refused for anything but your
  browser, since shell mode sits outside the agent's guardrails. The command and
  its output stay in the chat, reload included — as does one you typed yourself
  in the terminal view.
- **Files you hand an agent** — paste or drop a file into the composer, or pick
  one with the 📎 button beside it (an image, a PDF, a CSV…), and it becomes a **chip** above the text box: a
  thumbnail for an image, a named tag for anything else, each with a ✕ to
  remove it. On send, an image shows **inline in your own message bubble**;
  under the hood the agent still receives it as an `[Attached …: path]` line,
  the same format Telegram uses, so nothing about how the agent reads it
  changes. A message can be attachments alone, with no words. The files are
  served back to the browser by `GET /media/<name>` from the same directory
  Telegram attachments land in.
- **Files an agent hands you** — when an agent's result IS a file (a report, an
  export, a screenshot, an archive) it arrives as a download card in the chat,
  inline if it is an image, and as an upload in the Telegram topic. It goes
  through shadok's own `shadok-files` skill rather than depending on the
  harness's file tool, which is **not on every agent**: a long-lived agent keeps
  the Claude Code binary it started with, so one older than that tool would
  otherwise just print a local path you cannot open. **Artifacts are denied**
  cockpit-wide for the same reason — a page on claude.ai is not the file you
  asked for (`SHADOK_ALLOW_ARTIFACTS=1` lifts it).
- **Compaction summaries, folded away** — when Claude Code runs out of context
  it compacts the conversation and writes a long "This session is being
  continued…" summary as the first message of what follows. Shown in full it
  buried the chat, so the cockpit folds it into a collapsible **Context summary**
  box: collapsed by default, one click to read it, capped and scrolling even when
  open. It is still real history — just out of the way.
- **Diff panel** — what an agent actually changed, against its base.
- **What an agent left running, on its tab** — a turning ⏳ for background
  shells, a still 👁 for monitors, each with its count past one. Claude Code
  knows about both and says so in its own footer; the cockpit passes it on, so a
  script an agent left behind — the ones that wake it up later, and the ones
  nobody will ever collect — is visible from the outside. Monitors matter most
  here: a persistent one runs for the whole session and never ends on its own.
- **Context sent** — a collapsed block at the head of every conversation showing
  what shadok added to that agent: its role, its guardrails and permission mode,
  the **names** of the variables injected (never the values), the cockpit prompt.
  It also lists the **capabilities** shadok installs — the skills that let an
  agent start other agents, schedule its own prompts or store a credential —
  by description, since that is what Claude Code actually holds in context.
  Captured **at spawn**, so it is what the running process was actually given —
  not a recomputation that would quietly show today's profile. Also on the ⋯
  menu of each channel. It says plainly that it is shadok's half: Claude Code
  adds its own context, which shadok never sees.
- **Reload-to-apply indicator** — an agent's context is fixed **at spawn**, so a
  long-lived one can drift behind the cockpit: the pilot prompt or its guardrails
  changed, a new skill was seeded, its injected auth token aged past a week
  (so its own calls start failing silently), or Claude Code itself updated. The
  cockpit detects this by **comparing what the running process actually got
  against what a fresh spawn would give it** — a content comparison, not a
  version number, so a release that changed nothing relevant raises nothing, and
  a profile edit that bumped no version still does. A `↻` lights up on the agent
  (hover for the reasons) and the **version menu** shows *Reload N agents to
  apply changes*; a reload respawns each one in place, keeping its history.
  Agents started before a given update stay on the old context until reloaded —
  this is how you spot the ones still running it.
- **Phone layout** — the cockpit is a fixed chassis that never pans sideways,
  sized on the *visual* viewport so the composer stays clear of the browser's
  own bar and, when the keyboard opens, sits right above it (the instrument bar
  folds away while you type). Fields are 16px, which is what stops Safari from
  zooming in on focus. The agents column is replaced by a channel selector in
  the channel bar.
- **Tweak Shadok-AI** — a card pinned at the bottom of the agents column, with the running version in grey beside its title (the code a tweak starts from). One
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
- **Guided tour** — on a browser's first visit, a welcome card explains what
  shadok-ai is, then a spotlight walks the real controls: the agents list, an
  agent's ⋯ menu, scheduled prompts, the toolbar, the quota dials. Skip and
  Escape end it at any point; ⋯ → *Guided tour* replays it. A step whose target
  isn't on screen is **dropped rather than faked** — an empty cockpit has no
  agent menu, so it gets a shorter tour instead of a spotlight on nothing. The
  **phone gets the whole tour**, because a step can name the landmark on either
  layout (the agents column *or* the channel picker) and is framed on whichever
  one is rendered. On a brand-new instance it comes **before** the sign-in card
  — being asked to authorise an OAuth flow before you know what the thing is
  takes it backwards.
- **A lead agent from the start** — an instance with no channel at all gets one:
  `general`, running the **Shadok-Boss** profile, in the launch directory and
  without a worktree. It is created at boot, or right after the first sign-in on
  a brand-new instance (which is signed out at boot, so there is nothing to
  spawn yet). The condition is "no channel", which makes it idempotent: it never
  appears twice.
  While it is being started the central panel says so — *starting your first
  agent…* — instead of the *no agent open* invitation, which would ask you to
  create a second one while the first is being born. It is a status, not a
  screen: nothing to click, nothing to dismiss, and it ends on its own whichever
  way the spawn goes (started, refused because the instance is signed out,
  failed). The two look identical from the browser — an empty cockpit is an
  empty cockpit — so the server is asked (`GET /first-agent`) rather than
  guessed at, and the agent list is reconciled faster while the answer is yes.
  It is the environment's **home base**: pinned at the top of the list, with no
  close button and no *Close agent* in its menu. You can still reload, rename,
  re-profile or mute it — "permanent" should not mean "stuck". A cockpit that
  already had a `general` at its launch directory adopts it on the next start,
  and only ever when exactly one channel matches: a wrong adoption would be
  irreversible from the UI, since that channel becomes the one you cannot close.
- **It says hello, and makes one offer** — the lead's first message is written
  from a deterministic read of the directory it woke up in: version control,
  stack markers, CI configuration, the convention files. It names what it *saw*
  (`package.json`, `Shadok.xcodeproj`) and offers **one** concrete thing that
  fits, then lists the other roles this cockpit holds — the profiles you really
  have, so a role you minted appears and a role you deleted cannot be promised.
  When nothing in the directory is recognisable it says so plainly and offers
  the one thing that is true everywhere ("want me to read this project and tell
  you what it is?") rather than guessing a stack. It is an **offer, not a
  first-run screen**: ignore it entirely and the cockpit works exactly the same.
  `SHADOK_GREETING=0` turns it off.
- **Self-update** — polls npm and can update and reload itself in place.

### Telegram (optional)

The Telegram panel (header icon) carries a folded *How to set it up, step by step*
guide, open until a token is saved and a group is bound.

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
| `/cron once 2026-08-25T08:42 <prompt>` | fire it **once** on that date, then the schedule is left disabled and marked `(fired)` |
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

### Running in Docker

The repo ships an official `Dockerfile`:

```bash
docker build -t shadok-ai .
docker run -d --name shadok-ai --restart unless-stopped \
  -p 127.0.0.1:3789:3789 \
  -v shadok-data:/root/.shadok-ai \
  -v shadok-claude:/root/.claude \
  -v shadok-workspace:/workspace \
  -e SHADOK_HOST=0.0.0.0 -e SHADOK_GUI_PASSWORD=change-me \
  shadok-ai
```

The image bundles **Claude Code**, **shadok-ai** and a **headless browser**
(Playwright Chromium, at `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers`) so
an agent can screenshot or drive the web with no first-run download; `git`, `gh`,
`tmux`, `jq` and a C toolchain are there for agents' own work. The three volumes
are what survive `docker restart` **and** `docker rm`+recreate: `~/.shadok-ai`
(vault, profiles, channels, crons, SSH identity), `~/.claude` (credentials,
transcripts), `/workspace` (agents' files). A fresh container needs a one-time
Claude login: `docker exec -it shadok-ai claude`.

**pid 1 reaps.** The image enters through `tini`, and that is load-bearing in the
long run: agents orphan processes all day (a backgrounded `sleep` loop, an
abandoned `esbuild`, a killed `gh`), an orphan is re-parented to pid 1, and only
pid 1 can reap it — which the cockpit's own supervisor never does, since Node
only waits for the children it spawned itself. A zombie costs no memory and no
CPU, just a pid slot, so nothing shows until the container's pid budget runs out
and it can no longer fork anything at all: no new agent, no `git`, no shell.
Measured on an instance running since August: 79,055 zombies against a 113,098
pid budget. Two things follow for an existing deployment. If you run an image
from before this (or any image whose pid 1 is the app), add `--init` and Docker
supplies the reaper. And either way it is decided when the container is
**created**: `docker restart` empties the table — pid 1 restarts, the kernel
drops the lot — but the leak starts over, so a recreate is what makes it stop.

### Exposing it beyond this machine

The cockpit runs arbitrary commands on the host by design, so it binds
`127.0.0.1` — **this machine only** — unless you say otherwise. Two things to
know before opening it up:

- `SHADOK_HOST=0.0.0.0` **requires a password** (`--password`, or
  `SHADOK_GUI_PASSWORD`); without one the server refuses to start rather than
  hand the network a shell.
- **That password is the `admin` account.** With it set, the login page gains a
  user field — leave it blank to sign in as the admin. An admin can then invite
  other people from the **Users** panel: each invitation is a single-use link,
  valid 48 hours, on which the invitee chooses their own password, so the admin
  never learns it — and redeeming the link signs them in straight away. The ⋯
  menu names who you are and lets you sign out. Two roles: `admin` manages
  accounts, `member` does everything
  else you do. Accounts belong to **one instance** (one launch directory), like
  its channels and its scheduled prompts. With no password there are no
  accounts and no login screen — nothing changes for a machine you use alone.
- **Two-factor sign-in (passkeys).** From the **Users** panel, anyone signed in
  with a named account can register a passkey on their device — the
  fingerprint / face / PIN unlock of the phone or laptop (WebAuthn, user
  verification required). An admin can then turn **Two-factor sign-in** on for
  this instance. From then on a correct password only opens a second step, and
  the session exists once the passkey answers.
  - Switching it on needs **at least 2 named admins, each with a passkey** —
    recovery is "another admin resets you", so a lone admin who lost their phone
    would lock the cockpit for good. The acting admin confirms with their
    passkey.
  - **Adding a device from another one**: on a signed-in device, *Add another
    device (code)* shows an 8-character code valid 10 minutes, single use. On the
    new device, sign in with the password, choose *use a code*, register. A
    password alone never registers a passkey — that is what stops a stolen
    password from enrolling the thief's phone.
  - **Lost something**: another admin opens *recover access…* on your row and
    picks what you lost (always confirming with their own passkey). Nobody can
    recover themselves.
    - *lost password* — one admin; you get a link (48 h), choose a new password,
      then confirm with one of your passkeys, which are all kept;
    - *lost passkey* — a **second admin approves** from their Security panel; you
      then get a device code (48 h) to register a new device;
    - *lost everything* — password and passkeys are wiped **24 hours** later, or
      as soon as a second admin approves; you, the asker or any admin can cancel
      it meanwhile.
    Making or unmaking an admin also needs a second admin's approval. A device
    code for someone who has no passkey yet is still one admin's act. Every
    session opened before a recovery stops working — including one on the lost
    device; removing a passkey or demoting an admin does the same.
  - While it is on, inviting, deleting an account and changing a role also ask
    the admin for their passkey.
  - **Security panel** (🛡 in the header, a badge when something is new): what
    was done to your account — invited, made admin, reset, a passkey added or
    removed, a recovery asked about you — and, for admins, the whole log, the
    requests waiting for their approval, and their own requests with the link or
    code to hand over once done. On anything you don't recognise,
    **This wasn't me** ends your other sessions, removes a passkey you did not
    add, and flags it to every admin. There is no mail yet: this panel is the
    channel, so keep an eye on its badge.
  - While it is on, the instance password (`admin`) **cannot sign in to the
    browser** — it lives in every agent's environment and no one could reset it;
    use a named account. Agents, Telegram and peers keep working (they never use
    the login), but account and two-factor management is reserved to a signed-in
    person: an agent's key can no longer create or reset accounts.
  - Passkeys need a **secure context**: `https://` (see "Behind TLS") or
    `localhost`. They are bound to the hostname — one made on
    `cockpit.example.com` does not work on `localhost`.
  - **Break-glass**, if every admin loses everything at once: on the machine,
    remove the instance's entry under `twoFactor` in `~/.shadok-ai/config.json`
    and restart. Whoever has that shell could read every secret anyway.
  - What it protects against: a leaked password used over the network, and every
    session issued before it was switched on (they stop working). What it does
    not: anything already running as the machine's user — same soft isolation as
    profiles.
- Once people are named, **a prompt carries its sender**: the agent sees who
  asked, and the other browsers show the name above the message instead of
  "pilot (elsewhere)". The server takes that name from the session, never from
  what the browser claims.
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
    client_max_body_size 50m;   # match the server's paste limit
}
```

The client picks `wss://` on its own when the page is HTTPS, so there is nothing
to configure on that side.

**Upload size.** The server accepts a pasted/dropped file up to 50 MB, but
nginx's default `client_max_body_size` is **1 MB** — a full-page screenshot
sails past that, and nginx answers its OWN `413` HTML page **before** the request
reaches the cockpit. Raise the limit to match (`client_max_body_size 50m;`),
or a paste larger than 1 MB fails at the proxy. The cockpit now shows a plain
"too large" instead of a JSON parser error, but the file still won't go through
until the proxy allows it.

**Idle timeout.** A resting agent's `/ws` carries no traffic, and proxies
idle-close a quiet socket (nginx `proxy_read_timeout`, 60s by default;
Cloudflare ~100s) — the symptom is a cockpit that keeps flashing
"reconnecting…" even though nothing is wrong. The server sends a WebSocket ping
every 25s (tunable with `SHADOK_WS_PING_MS`) to keep the connection warm, so no
proxy change is normally needed; if your proxy still cuts it, raise
`proxy_read_timeout` above the ping interval.

### Cross-instance peers

Agents can spawn and drive agents on **another** instance — another of yours, or
a teammate's. It is opt-in and gated like an account.

On the instance being reached (call it **B**), an admin **invites an agent** —
in the **Users** panel, exactly like inviting a person, except the invitee is a
machine so it gets a **prompt to paste** instead of a login link. Give it a name
and, optionally, a brief (what you want it to do); B mints a named, revocable
credential and hands you a ready-to-paste block: the cockpit URL, the key, the
brief, and the commands to join. Copy it into whatever agent you're inviting.

(The same thing over the API: `POST /peers {name, brief}` returns
`{ name, token, invitePrompt }` — the token is shown once.)

On the calling instance **A**, the invited agent registers B and drives it with
`pilotctl --peer` (the pasted prompt spells this out):

```bash
pilotctl peer add B https://B <token>
pilotctl spawn --peer B --profile dev --name "migration bot" --cwd /workspace
pilotctl prompt <id> "run the migration" --peer B
pilotctl diff <id> --peer B
```

The credential is **non-expiring and revocable** (`DELETE /peers?name=instance-a`
on B kills it immediately — future calls **and** the live link). Each invitation
carries a **scope**, chosen when you invite:

- **restricted** (the default) — only the agents it creates on B; it can never
  see, resume, drive or diff B's other agents.
- **member** — the invited agent acts **like a person you invite**: it sees,
  drives and measures **every** agent on B, spawns more, reads its usage. It is
  not an admin (no account or peer management).

The narrow scope is what you get when you say nothing — including for a peer
invited before scopes existed, which stays restricted until you re-invite it as a
member. A credential already in someone else's hands never widens on its own.

**This is remote code execution by a third party** — a peer that can `spawn` runs
commands on B's machine, and a **member**-scope peer has a member's full reach. It
is a deliberate admin grant (you trust an invited agent exactly as much as an
invited person), and a container per instance stays the real boundary (see
*Exposing it beyond this machine*). Even a member cannot read secret **values**
(`/secrets` returns names only) — the vault's floor holds.

### Signing in to Claude

A fresh machine — most often a fresh container — has two things in its way, and
shadok handles both so you never need a shell on the host.

**The first-run screens are pre-answered.** A virgin `claude` opens on a theme
picker, then on a per-directory trust dialog, and an agent started there never
reaches a prompt: no input box, every prompt fails, the tab reads "failed to
start". shadok seeds the answers in `~/.claude.json` — at boot for the global
ones, and before every spawn for the session's directory, because a worktree is
a brand-new directory and therefore a brand-new trust dialog. The seeding is
**purely additive**: a value already there is never overwritten, so on a machine
that has used Claude Code before, nothing is written at all.

**The sign-in is offered in the cockpit.** When the instance isn't signed in, a
card takes over the page with the OAuth link and a field for the code you get
back; agents refuse to start until it's done, so you can't accidentally
manufacture an agent with no credentials. The card exists only while it's
needed — there is no button that opens it when everything is fine.

**From Telegram**, which is where you usually are when a session signs out
mid-life:

```
/login          → replies with the link
/code <code>    → finishes the sign-in (your message is deleted afterwards)
```

Both are restricted to the bound board group or the owner's DM, like `/secret` —
an OAuth code grants access to the account. The sign-in is instance-global, so
the link is the same on both sides and a code pasted in Telegram also closes the
card open in a browser. When a spawn is refused for lack of credentials, shadok
posts **one** message to the board group; it won't repeat until the state flips
back.

**In Docker**, this replaces the old recreate ritual. `/root/.claude.json` is
not on a volume, so `docker rm` + recreate used to lose the onboarding state and
the respawned agents landed on the first-run screen — which meant restoring the
file *before* starting the container (`docker create` → `docker cp` →
`docker start`). That ordering is no longer necessary: shadok writes the file
itself, before any session spawns.

### Running on a self-hosted model

shadok drives Claude Code, and Claude Code can talk to any server that speaks
the Anthropic Messages API: Ollama, llama.cpp's `llama-server`, vLLM, or a
LiteLLM proxy in front of anything else. Point it there with
`ANTHROPIC_BASE_URL`, and agents on that backend need **no Claude sign-in** and
are **never held by the quota guard** (they don't spend your subscription).

Three ways to do it:

- **From the cockpit — the easy one.** The sign-in card a fresh instance opens
  has a second side, **Another model**: pick a provider (Ollama, a llama.cpp
  server, DeepSeek, Z.ai/GLM, Moonshot/Kimi, or any Anthropic-compatible
  server), the address and model are pre-filled, the models a local server
  serves are listed for you, and **Test** sends one real request before
  anything is saved. The lead agent starts as soon as you save. Change it later
  from the version menu, **⚙ Model backend…** (which also offers to go back to
  the subscription). The choice is stored per launch directory in
  `~/.shadok-ai/config.json` and takes precedence over the environment; running
  agents keep the model they were started with until they are reloaded.
- **The whole instance, from the environment.** Launch shadok with the variables:

  ```bash
  ANTHROPIC_BASE_URL=http://localhost:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_MODEL=qwen3-coder:30b SHADOK_CONTEXT_WINDOW=64k npx shadok-ai
  ```

- **One role.** Store the same names as vault secrets and attach them to a
  profile: agents on that profile use the local model, the rest stay on the
  subscription. A profile's secrets win over the instance's environment.

| Variable | Meaning |
|---|---|
| `ANTHROPIC_BASE_URL` | The server. Anything that is not `*.anthropic.com` counts as a custom backend. |
| `ANTHROPIC_AUTH_TOKEN` | Sent as a bearer token. Any value when the server checks none. Prefer it to `ANTHROPIC_API_KEY`, which makes Claude Code ask for confirmation. |
| `ANTHROPIC_MODEL` | The model to run. Also fills every unset `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL`, so the model picker and Claude Code's background calls reach it too. |
| `SHADOK_CONTEXT_WINDOW` | The window the context gauge measures against (`64000`, `64k`, `1m`). Without it the gauge assumes Claude's 200k. |

Hugging Face Inference, Together, Groq and the other **OpenAI-only** APIs are
not in the list on purpose: Claude Code speaks only the Anthropic format, so
they need a translating proxy (LiteLLM, claude-code-router) in front — then
point *Another Anthropic-compatible server* at the proxy. The Test button tells
the two cases apart and says so.

Two things are on you. The model needs **reliable tool calling and a long
context**: Claude Code's own prompt and tool list take ~15–20k tokens before
your first word. And the server must actually *serve* that context: Ollama's
default is a few thousand tokens, so set `OLLAMA_CONTEXT_LENGTH` (64k is a sane
floor) or the agent will lose its instructions without any error.

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
over the environment once set** from the GUI — with two exceptions where the
environment wins: `SHADOK_GUI_PASSWORD` (a saved `--password` is used only when
that variable is unset, and nothing in the cockpit can change it — on Docker,
the password is the one the container was created with) and
`TELEGRAM_BOT_TOKEN`. The Telegram token, allowed
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
| `SHADOK_GUI_PASSWORD` | require a password for the GUI — overrides a password saved by `--password` |
| `SHADOK_ORIGINS` | extra browser origins allowed, comma-separated (reverse proxy) |
| `SHADOK_TMUX=0` | force the node-pty transport instead of tmux |
| `SHADOK_IDLE_MIN` | minutes with no client before a session is reclaimed (60) |
| `SHADOK_PERMISSION_MODE` | mode new agents start in (default `acceptEdits`) |
| `SHADOK_AUTOUPDATE` | fallback only — the GUI setting wins once used |
| `SHADOK_PILOT_PROMPT=0` | don't inject the cockpit system prompt |
| `SHADOK_GREETING=0` | the lead agent starts silent — no first-message greeting |
| `SHADOK_LEDGER=0` | turn OFF the shared-ledger reflex — a per-instance state table siblings read/write so they stop re-surfacing resolved work, plus a `⟦ledger⟧` delta pushed ahead of each message (**ON by default**; `SHADOK_LEDGER=0` or the GUI/config setting turns it off) |
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

### Update channels

An instance follows one of two release streams, picked in the version menu
(click the version next to the brand):

- **beta** — the default, and what a fresh `npx shadok-ai` installs. Moves only
  when a version is promoted, so the instance stays put for days at a time.
- **alpha** — moves on every merge to `main`. Newest work, freshest bugs.

Promoting is deliberate: someone bumps the minor in `package.json` and merges,
and that merge becomes the new beta for everyone.

The numbers tell you which channel a version came from. An alpha carries the
commit count (`0.3.78`); a promotion is a round `0.4.0`. The auto-update switch
and the reload behaviour are identical on both.

```bash
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
| `{type:"start", cwd?, resume?, continue?, worktree?, branch?, repo?, profile?, parent?, origin?}` | starts or attaches to the session (once per connection). `origin` (`"web"`, `"cron"`, `"telegram"`, `"cli"`…) travels with `prompt-echo` so other clients can say who spoke. `parent` records who launched this agent — a refused link is dropped and logged, never fatal to the spawn |
| `{type:"prompt", text, force?}` | sends a prompt (`force` bypasses the pace guard) |
| `{type:"choose", n}` | single-select dialog: picks and validates option n |
| `{type:"toggle", n}` / `{type:"confirm"}` | multi-select: toggles option n / submits |
| `{type:"freetext", n, text}` | "Type something" option: sends a free-form answer |
| `{type:"key", key}` | raw keystroke (`enter`, `escape`, `up`, `down`, `tab`, `ctrl-c`, or a single character) |
| `{type:"settle"}` | after a manual intervention: waits for the turn to finish |
| `{type:"restart"}` | respawns the agent in place (picks up new secrets/profile) |
| `{type:"set-parent", parent}` | attach this channel under another (`null` detaches). Refused **explicitly** on a self-link, a cycle, an unknown parent, or a chain/fan-out past its cap |
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
| `{type:"parent", parent}` | the channel's parent changed (broadcast, so every tab follows) |
| `{type:"prompt-echo", text}` | prompt sent by another client of the session |
| `{type:"dialog", question, options:[{n,label,hint,checked?}], multi}` | choice pending |
| `{type:"history", turns:[…]}` | transcript replayed when resuming/attaching |
| `{type:"screen", text, working}` | rendered TUI screen (whenever it changes) |
| `{type:"pace-blocked"}` / `{type:"pace-hold"}` / `{type:"pace-resumed"}` | quota guardrail |
| `{type:"auto-retry"}` / `-cancelled` / `-gave-up` | transient API error being retried |
| `{type:"version", …}` / `{type:"server-reload", version}` | update available / server updated, reload |
| `{type:"term-data", data}` | **experimental** — raw pane output (base64) for a client-side terminal emulator |
| `{type:"gone"}` / `{type:"error", message, code?}` / `{type:"exited", code}` / `{type:"stopped"}` | session lost, errors, termination. `error.code` is `"busy"` for a prompt refused mid-turn and `"logged-out"` for a spawn refused because the instance isn't signed in, `"resume-refused"` for a `resume` whose shortened id matches no agent or several — so a machine client needn't match on the message text |

HTTP endpoints (same auth): `/usage`, `/live`, `/sessions`, `/recover`,
`/diff`, `/channels` (its GET adds a **derived** `crons` field — never stored),
`/channel` (DELETE), `/groups`, `/crons`, `/timezone`, `/title` (GET/PUT — the
cockpit's name, per launch directory: click the header brand to rename it, so
several cockpits stay apart in the tab bar; an empty PUT reverts to the default),
`/theme` (GET/PUT — the cockpit's colour palette, per launch directory: an accent
key picked from the ⋯ menu, e.g. `emerald`; unknown/`amber` reverts to default.
The default palette (stored key `amber`, labelled *Shadok*) is the Teams purple in
light mode and an indigo in dark mode; light mode follows Microsoft Teams, dark
mode a neutral near-black.
Light/dark **mode** is an orthogonal, **per-browser** choice in the same menu
(default dark; stored in `localStorage`, applied before first paint) and needs no
endpoint — the accent is the instance's shared identity, the mode is personal),
`/profiles`, `/secrets`, `/telegram`, `/defaults`, `/first-agent` (GET —
`{pending, reason}`: whether this instance's lead agent is being started
right now), `/version`, `/autoupdate`,
`/update-channel` (POST `{channel}` — `alpha` or `beta`), `/permission-mode`, `/tweak/prepare` (POST — clone/refresh shadok-ai's own source,
returns the cwd to start the tweak agent in), `/media/<name>` (GET — serves a
pasted/dropped or Telegram attachment back for inline display; sandboxed, basename
only), and the sign-in group: `/auth` (GET
— `{loggedIn, email?, subscriptionType?, tokenExpiresAt?, accessExpiresAt?, backend?, backendModel?}`;
the expiries come from the credentials store, never a token value; `backend:
"custom"` when the instance runs on another model), `/auth/login`
(POST — start a flow, returns `{url}`; DELETE — cancel it), `/auth/code`
(POST `{code}`); and the model-backend group (admin, browser only for writes):
`/backend` (GET — the backend in use without its key, plus the presets; PUT —
`{baseUrl, model, authToken?, contextWindow?}` or `{clear: true}`),
`/backend/test` (POST — one real `/v1/messages` round trip) and
`/backend/models` (POST — the models a server offers).

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
| `waitForIdle({stableMs, timeoutMs, settleOn?})` | waits for the end of a turn; `settleOn(screen)` names a dialog (or `null`) so a dialog that never holds still — a ticking countdown — still ends the wait |
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

## Why it is called that

Les Shadoks were French cartoon birds, drawn by Jacques Rouxel in 1968, and the
whole joke was that they pumped. Relentlessly, exhaustingly, and for no result
anyone could ever identify. One of their mottos: *the more it fails, the more
likely it is to work.*

An agent woken every hour to report that nothing happened is pumping. You pay a
model call to be told there was nothing to do, and it will tell you that
twenty-three more times today. Hence the guard in `crons.ts`: the check runs
without the model, and a quiet hour costs nothing at all.

The name went unexplained here for the project's first month, which is a
strange thing to leave out of a README when the joke *is* the design.
