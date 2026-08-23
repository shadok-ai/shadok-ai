# CLAUDE.md — shadok-ai

Read this first. It exists so you can evolve shadok-ai **without re-scanning
the whole codebase** and **without repeating the mistakes already made**.
Keep it up to date when you change architecture, invariants, or the protocol.

## What shadok-ai is

A **web cockpit that drives multiple real Claude Code TUI sessions in
parallel**. Each "channel" in the UI is one `claude` process. It runs on the
user's **Claude subscription** (not the API), via a pseudo-terminal or tmux —
so it's Claude Code piloting Claude Code, with a browser chat on top.

It largely **built itself** (agents in git worktrees). See `docs/architecture.md`
for the deep dive; `docs/superpowers/specs/*` for per-feature design specs.

## Build / run / restart (do it exactly this way)

```bash
npm run build          # tsc → dist/  (ALWAYS build before restarting)
```

The server runs under a **detached supervisor**, `node dist/main.js`, launched
from the repo. The supervisor doesn't run your working tree: it runs the
**npm-installed** copy (`~/.shadok-ai/app/node_modules/shadok-ai/dist/server.js`)
and auto-updates it. Every merge to main publishes a new version
(`.github/workflows/publish.yml`, version = `major.minor.<commit count>`), so a
running instance picks up merged work on its own within minutes.

UI: **http://localhost:3789**. Logs: `~/.shadok-ai/local-supervisor.log`.
Health: `curl -s -o /dev/null -w '%{http_code}' localhost:3789/`.

- `package.json` stays at `0.1.0` locally — the CI computes the published
  version. A local version "behind" npm is normal, not a symptom.
- `CLAUDE_CODE_OAUTH_TOKEN` is only for the `/usage` (pace) endpoint; `claude`
  itself authenticates via the keychain.
- Never `cat` the token or print it. Extract it in the shell, pass via env.

### Running YOUR build (to check a fix before merging)

**Run it side by side on a free port. Never take over 3789.** Stopping the
running instance kills every sibling `sk-*` session mid-work — including, when an
agent does it, the very session driving the change (invariant 8,
`context/pilot-prompt.md`). Don't edit `~/.shadok-ai/config.json` either: the
running instance reads it.

```bash
npm run build
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js
```

Three properties make that safe, and all three are load-bearing — change one and
you're back to the old failure:

- `PORT` sets where the port walk *starts* (`START_PORT`, server.ts:102). It does
  not remove the walk: `MAX_PORT_TRIES = 20` still applies, so a busy 3899 climbs
  to 3900 — never down toward 3789.
- `SHADOK_VERSION_CHECK_MIN=0` closes the gate on the version poll
  (`if (VERSION_CHECK_MIN > 0)`, server.ts:878). That poll is what would install
  the npm release and exit for the supervisor to respawn — i.e. your build
  vanishing without a word. Note `triggerUpdate` has a *second* caller, the
  `POST /autoupdate` handler (server.ts:893); it needs a deliberate request, so
  just don't tick the GUI checkbox. `autoUpdate: false` in the config reaches the
  same end, but by mutating state the running instance shares — prefer the env var.
- The Telegram token is keyed by **launch dir** (`cfg.tokens?.[cwd]`,
  config.ts:98), so an instance started from a worktree has no token and starts no
  bridge. That's what lets the two coexist: only one process can long-poll the bot.
  A `TELEGRAM_BOT_TOKEN` in the env overrides the per-dir lookup and *would* steal
  the bot — so confirm your startup output has no `telegram:` line.

Verify you're really on your build: `curl -s localhost:3899/version` must report
the local `current` (0.1.0), not the published one. Check
`curl -s -o /dev/null -w '%{http_code}' localhost:3789/` still answers `200`
before and after. Stop your instance when done; nothing to restore.

No interactive browser? Borrow Playwright from `~/projects/aibrowser`
(`node_modules/playwright`, required by absolute path — don't install into the
worktree), screenshot, and **read the screenshots back**. Capture the console too:
a CSP violation or a failed module import is how invariants 10 and 12 show up, and
both are silent in the DOM.

## Architecture map (file → responsibility)

| File | Responsibility |
|---|---|
| `src/server.ts` | HTTP + WebSocket server. Session registry (`sessions` Map), the `Live` object, the WS message handlers, all endpoints. The hub. |
| `src/session.ts` | `PtyPilot` — drives `claude` in a **node-pty** PTY + `@xterm/headless`. Dies with the server. |
| `src/tmux.ts` | `TmuxPilot` — same interface as `PtyPilot`, but runs `claude` in a **detached tmux session** (`sk-<sessionId>`). **Survives server restart** (reattaches). Default transport when tmux is present. |
| `src/tail.ts` | Tails a session's `.jsonl` transcript → streams assistant text/tool_use/tool_result + token usage. **This is the source of truth for content**, not the screen. Also owns `isNothingToShow` — a text block that is *only* `NOTHING TO SHOW` is dropped (a cron with no signal must be able to stay silent); the twin filters live in `loadHistory` and the web live preview. |
| `src/extract.ts` | Parse the transcript / screen: `loadHistory`, `detectDialog`, `listSessions`, `findSessionId`. |
| `src/detect.ts` | `screenShowsWork(screen)` — the fragile "is Claude working" heuristic. Also `inputText` and `describeStuckScreen`, which names a recognisable blocking state (first-run screen, masked field, pending question) so a submit failure says WHY instead of accusing the input box. See invariant 25. |
| `src/context.ts` | How full the model's context window is, from the TRANSCRIPT's token usage — `contextTokens` (input + cache creation + cache read; output excluded), `windowForModel` (the `[1m]` SETTING, never the model name), `effectiveWindow` (an over-run PROVES the assumed window too small → promote), `pctFromUsage`. Pure, tested against a real message whose CLI footer read 41%. See invariant 24. |
| `src/worktree.ts` | Git worktree isolation: create, diff, list past sessions, recreate a reclaimed checkout. |
| `src/selfrepo.ts` | The working copy of shadok-ai's OWN source (`~/.shadok-ai/self/shadok-ai`) behind the "Tweak Shadok-AI" CTA: anonymous clone (no auth needed to start), `main` hard-reset to the remote on each use, never the launch directory. Only the base clone is refreshed — a live tweak session's worktree is a separate checkout and is never touched. Pure cores (`selfRepoPlan`, `gitFailReason`) tested. |
| `context/tweak-prompt.md` | Role of the tweak agent: read the cloned `CLAUDE.md` first, verify on a free port and never touch 3789, deliver as fork + PR (never a merge), talk to someone who may not be a developer. Injected through the managed `Shadok-Tweak` profile, whose `systemPrompt` is refreshed from this file at every boot (`seedTweakProfile` / `withManagedPrompt`) — only that field, so a secret or model the user attached survives. |
| `src/usage.ts` | Fetches subscription usage (5h/7d) from `/api/oauth/usage`. |
| `src/pace.ts` | The quota **guardrail**: ideal-pace computation + block verdict. |
| `src/retry.ts` | Auto-retry of turns that died on a transient API error (529, 5xx, timeout). |
| `src/channels.ts` | Server-side persistence of the channel + group lists, keyed by launch dir (`~/.shadok-ai/channels/<enc>.json`). `isMirrored` = does this channel live in Telegram too (opt-in per channel; falls back to "has a binding" so existing setups don't change). Also the Telegram board-group binding. Forces the main channel's name to `general`. `isHomeChannel` (pure, tested) is the ONE definition of the home base — the server-owned `home` flag, or a bound board's General (`threadId == null` **and** `chatId < 0`, since a DM has no topic either and must stay closable). It replaced three copies of that condition: `endChannel`, the client's `isMain`, and a comment in `telegram.ts`. `homeAdoptionTarget` gives a pre-flag cockpit its home base and **refuses when it cannot tell** (zero or several candidates): a wrong adoption is irreversible from the UI, since the channel becomes precisely the one that cannot be closed. `homeChannelForGeneral` (pure, tested) is the twin for the OTHER direction: when a board's General is first opened, `bridgeFor` resumes the web home session (`home: true`, not yet Telegram-bound) instead of spawning a SECOND "general" beside it — the home channel gains the binding rather than being duplicated. |
| `src/telegram.ts` | The Telegram bridge (DMs belong to ONE user — `dmGate` + `…-telegram-owner.json`; the owner is adopted at boot from an existing DM binding or the board group's creator): one topic = one agent. Owns the bot long-poll, the command dispatcher (`/spawn`, `/stop`, `/secret`…), Markdown→Telegram HTML, dialogs as inline keyboards, attachments. Each binding holds a **WS client to our own server** — so a Telegram session is the same `Live` the web sees. |
| `src/main.ts` | The `npx shadok-ai` entry point: parses flags, first-run token prompt, then runs the **supervisor**. Not the server. |
| `src/supervisor.ts` / `src/updater.ts` / `src/update-flag.ts` | Self-update: the supervisor runs the npm-installed server as a child, restarts it on the update exit code; the updater installs the channel's resolved version into `~/.shadok-ai/app` (an EXACT version, never a tag — the caller already chose). |
| `src/update-channel.ts` | Which release stream an instance follows: `alpha` (every merge) or `beta` (promotions only, the default). Pure `resolveChannel` (anything malformed → `beta`, never a throw) and `pickTarget` (alpha takes the newer of `alpha`/`latest`, so a promotion cannot make the fast channel downgrade). The beta channel reads the `latest` dist-tag — see invariant 31. |
| `Dockerfile` | The official image (README "Running in Docker"): Claude Code + shadok-ai + a **bundled headless browser** (Playwright Chromium at `/opt/playwright-browsers`, `--with-deps` so the OS libs are present), plus `git`/`gh`/`tmux`/toolchain. COPYs nothing (installs from npm); `.dockerignore` is `*`. NB: NOT what a given deployment necessarily runs — the live VPS builds from a host-side Dockerfile of its own. |
| `src/csp.ts` | The Content-Security-Policy (`cspHeader`) and the nonce injection into the page (`injectNonce`, marker `__CSP_NONCE__`). Pure, tested. See invariant 12. |
| `src/net.ts` | Where we listen and who may speak: `resolveHost` (`SHADOK_HOST`, loopback by default), `bindRefusal` (fail-closed: no network bind without a password), `originAllowed` (same-origin, see invariant 11). Pure, tested. |
| `src/heartbeat.ts` | Keeps **idle** `/ws` connections alive behind a reverse proxy: an idle agent sends no traffic, so a proxy (nginx `proxy_read_timeout` 60s, Cloudflare ~100s) cuts the socket and the client loops on "reconnecting" — with nothing actually broken. `startHeartbeat(wss)` pings every client every 25s (`SHADOK_WS_PING_MS`) and `terminate()`s the one that misses its pong. `heartbeatSweep` is pure, tested. |
| `src/config.ts` | `~/.shadok-ai/config.json` (600): port, **per-launch-dir** Telegram token/allowed chats/on-off, GUI password, `autoUpdate`, `permissionMode`, `timezone`, `cockpitTitle` (**per-launch-dir** display name, `titleForCwd`/`setTitleForCwd` — the header brand + browser tab, so several cockpits stay apart), and `cockpitTheme` (**per-launch-dir** colour palette key, `themeForCwd`/`setThemeForCwd`, validated against `COCKPIT_THEMES`; default/unknown → cleared). Config is authoritative over env once set. |
| `src/crons.ts` | Per-channel scheduled prompts (`~/.shadok-ai/crons/<enc>.json`) + the deterministic `check` that avoids waking the LLM for nothing. Three `kind`s: `interval`, `daily` and `once` (an absolute instant, fired a single time — `stateAfterFire` DISABLES it before the fire, since it cannot advance to a next slot, and `settleCron` re-arms it on a transient loss). `nextRunFor` computes a `daily` in an **explicit IANA zone** (`cron.tz` → config `timezone` → machine): without it the hour follows the machine, and a server running UTC shifts everything silently. `nextRunAfterFailure` decides where to reschedule a fire whose delivery was lost (see invariant 15). `resolveCronTarget` says WHERE a cron runs (the channel's cwd/profile/branch/repo) — one source of truth for the guard and for the resume (see invariant 19). The fire itself lives in `server.ts` (`cronTick` / `fireCron` / `driveChannel` / `settleCron`). Also carries `CRON_PROMPT_MARK`: a cron prompt's text is prefixed, because it ends up in the transcript like an ordinary user message — hiding only the direct echo let it come back on a web reload and in a Telegram backfill, both of which re-read `loadHistory`. Twin of `NOTHING TO SHOW`. |
| `src/kinship.ts` | Who launched whom, and what a parent is told about it. `linkRefusal` (self / cycle / unknown parent / depth / fan-out — every refusal **explicit**, never a silently dropped field), `chainDepth`, `childrenOf`, `notificationText` (the child's own summary + pointers, **never the diff**: the parent is the biggest session in the tree), and `AGENT_PROMPT_MARK` — twin of `CRON_PROMPT_MARK`, since a notification also lands in the transcript as an ordinary user message. Pure, tested. The delivery itself lives in `server.ts` (`notifyParent` / `deliverToParent` / `parentInbox` / `flushParentInbox`). |
| `src/secrets.ts` | Central secret vault (`~/.shadok-ai/secrets.json`, 600). Profiles reference secrets **by name**; values are injected as env at spawn. `secretWriteVerdict` (pure, tested) is the no-silent-overwrite rule behind `PUT /secrets`: an existing name is refused unless the caller passes `overwrite: true`. HTTP is the only way an AGENT can reach the vault (Telegram's `/secret` calls `setSecret()` directly), so that endpoint is exactly the machine boundary. |
| `context/secrets-skill/` | The `shadok-secrets` skill, seeded into `~/.claude/skills/` at boot (`seedSecretsSkill`, twin of `seedSchedulerSkill`): lets an agent store a credential it OBTAINED itself. `scripts/secret.mjs` has `list` and `set NAME --stdin` and **no `get`** — `--stdin` is required so a value can never sit in `argv`, which `ps` exposes machine-wide. |
| `src/claude-home.ts` | Seeds Claude Code's first-run state in `~/.claude.json` — the globals at boot, `projects[<cwd>]` before **every** spawn (a worktree is a new directory, so a new trust dialog every time) — plus an explicit `tui` in `~/.claude/settings.json`, which kills the fullscreen-renderer upsell. That upsell appears only AFTER a sign-in and is **blocking**, so no signed-out probe can find it: the signed-out screens are not the whole set. PURELY ADDITIVE: a key already present is never overwritten, which is why it needs no Docker gate — contrast `src/ssh.ts` (invariant 21). Atomic write; an unparseable file is left alone rather than "repaired". Pure `seedPlan` / `parseClaudeVersion` tested. |
| `src/first-agent.ts` | The lead agent an instance starts life with: `general` on the `Shadok-Boss` profile, in the launch dir, no worktree. `firstAgentPlan` is pure and tested — it spawns only when there is **no channel at all** AND the auth state is `signed-in` (`unknown` is not signed in: that is the zombie shape, cf. invariant 29). That "no channel" condition is what makes it idempotent, so `startFirstAgent` (`server.ts`) can be called both at boot and after a successful sign-in without either knowing about the other — and a brand-new instance, signed out at boot, gets its agent from the sign-in call. It spawns through a **loopback WS to our own server**, like the Telegram bridge and the cron driver: there is no server-side path that opens a session without a client, and adding one would be a second way to start an agent. |
| `src/claude-auth.ts` | Auth status and the interactive sign-in. `claude auth login --claudeai` needs **no PTY**: run with pipes it prints the OAuth URL on stdout and reads the code from stdin — so the sign-in touches NONE of the screen heuristics. One instance-global flow, two doors (the web card, Telegram `/login`+`/code`). Success is a clean **exit**, never a parsed string (see invariant 29). Pure `parseAuthStatus` / `parseLoginUrl` / `parseLoginOutcome` tested. |
| `src/ssh.ts` | Persistent per-container SSH identity (`ensureSshIdentity`, called at boot in `server.ts`). **Docker-only** (`/.dockerenv`): generates an ed25519 key under `~/.shadok-ai/ssh/` — on the `shadok-data` volume, so it survives restart AND recreate — and symlinks `~/.ssh` to it so agents' `git`/`ssh` use it. NO-OP on a normal host (never touches `~/.ssh`). Pure `sshPaths`/`planDotSshWiring`/`inContainer` are unit-tested. See invariant 21. |
| `src/profiles.ts` | Agent profiles (GLOBAL, `~/.shadok-ai/profiles.json` 600): role (`--append-system-prompt`) + permission guardrails (`--settings` deny/allow, e.g. no `git commit`) + secrets + model, applied at spawn via `profileArgs`. Stored on the channel (`profile`) → re-applied on resume/restart. SOFT (same OS user, not a sandbox). |
| `src/cli.ts` | One-shot CLI (`node dist/cli.js "prompt"`), separate from the server. |
| `public/index.html` | The entire web client (no framework, no build). Agents (creation is a **popin**, `#setupOverlay`, profile-first: a grid of cards, the rest folded away; the channel is only born at "Start agent", see invariant 18), groups, dialogs, engine room, diff panel, pace/usage gauges, context bars. UI copy says **agent**; the code, endpoints and storage keys still say `channel`. |
| `public/live-text.js` | Pure `extractLiveText(screen)` — pulls the in-flight assistant text block from the TUI screen for the web live preview. ESM: loaded by the browser (bridged to `window.extractLiveText`) AND imported by `test/live-text.test.ts`. |
| `public/echo-author.js` | Pure `echoAuthor(msg)` — the author label above a prompt that came from ANOTHER client: the sender's name when the emitting client knows it (Telegram does), else its origin, else the generic wording. ESM: loaded by the browser AND imported by `test/echo-author.test.ts`. |
| `public/notify.js` | Pure `notifyState(channels, {hidden, phase})` → `{color, badge, blink}` — the favicon/title/blink decision. The badge only blinks when the browser tab is hidden AND an **unmuted** channel is waiting for an answer; both phases stay visible (a browser-throttled timer must never make the page look calm). ESM: loaded by the browser AND imported by `test/notify.test.ts`. |
| `public/profile-card.js` | Pure `profileBlurb` / `profileBadges` — the labels a profile card shows, derived from `systemPrompt` / `deny` / `model` / `secrets` (nothing added to `Profile`) — plus `defaultAgentName(profile, cwd)`, the name proposed for a new agent (profile → directory → `"agent"`), and `isManagedProfile` — the server-owned roles (`Shadok-Tweak`) that must never appear in a list where one PICKS a profile, since their prompt is rewritten at every boot. ESM: loaded by the browser AND imported by `test/profile-card.test.ts`. |
| `public/tour-steps.js` | Pure `TOUR_STEPS` / `visibleSteps` / `unionRect` / `bubblePlacement` — the guided tour's step data and geometry. A step whose target is not on screen is **dropped, never faked** (a phone has no agents column, an empty cockpit no tab), so the counter reads over the RETAINED steps. The toolbar step targets the six buttons rather than `.hdr-tools`, which is `display: contents` on desktop and therefore has **no box at all** — its rect is zeros and the step vanished on the one layout where the toolbar is most obvious. ESM: loaded by the browser AND imported by `test/tour-steps.test.ts`. |
| `public/gauge-dial.js` | Pure `dialPos` / `dialAngle` / `dialColor` / `arcSegments` / `dialTitle` — the geometry of the 240° quota dial, whose centre is the ideal pace and whose right end is exhaustion. ESM: loaded by the browser AND imported by `test/gauge-dial.test.ts`. |
| `context/pilot-prompt.md` | System prompt appended to **every piloted session** via `--append-system-prompt` (wired in `makePilot`, server.ts). Tells the agent it runs under the cockpit (chat rendering, sibling sessions, worktree discipline). `SHADOK_PILOT_PROMPT=0` disables. |
| `.claude/skills/shadok-ai-agents/pilotctl.mjs` | Thin client that lets an agent spawn/pilot other agents through the server (used by the `shadok-ai-agents` skill). |

## Core model

- **One session = one `claude` process = one `Live` object**, shared by N
  WebSocket clients (several tabs/devices follow the same session live).
- **Content** flows from the `.jsonl` tail (complete, streamed, survives
  everything). **Control** (submit, detect turn end, dialogs, engine-room
  screen) flows through the pilot's rendered screen. Don't scrape the screen
  for response text — that's what caused truncation; use the tail.
  - The **context gauge** used to break this rule and paid for it: it scraped
    `ctx:NN%` off the footer, a string only a custom statusLine ever prints, so
    it worked nowhere but the author's machine. It now comes from the transcript
    like every other datum (`src/context.ts`, invariant 24).
  - **One deliberate exception (web only): the live text *preview*.** The
    `.jsonl` writes a text block only once it's *complete*, so a long paragraph
    stays invisible during generation then appears at once. `public/live-text.js`
    (`extractLiveText`) reads the in-flight block from the screen and shows it in
    a **provisional** grey bubble, **always replaced 1-for-1** by the authoritative
    tail block on `stream-text` (or dropped on `turn-done`/`dialog`). Never
    persisted; if extraction fails it returns `""` → falls back to block-level.
  - **The `preface` of a `dialog` comes from that same screen extraction**, so it
    can be the *previous* turn's answer when the new turn hasn't written yet.
    `isStalePreface` (telegram.ts) drops it when it matches a block already
    streamed (`Live.recentTexts`, last 8). Deliberately looser than
    `prefaceMatches`: dropping a fresh preface only delays it (the tail still
    delivers it), whereas keeping a stale one leaves a permanent duplicate —
    nothing ever comes to edit it away.
- **Sessions outlive clients** on *disconnect* (reload, another device, a
  dropped WS): the process keeps running and is reclaimed only after
  `SHADOK_IDLE_MIN` min (default 60) with no client. With tmux, it also
  outlives the server. **Explicit close ends it everywhere**: the tab ✕, "End
  session", Telegram `/end`, and closing a topic all send `stop`, which drops
  the session from the registry and archives its Telegram topic.

## WebSocket protocol (`/ws`)

**client → server:** `start` (cwd/resume/continue/worktree/branch/repo/profile/
`parent` — who launched this agent; pilotctl puts its own `SHADOK_SESSION_ID`
there, so the link needs no configuring. A refused link is DROPPED and logged,
never fatal to the spawn: killing an agent over a bad link would be worse than an
agent that reports to nobody./
`origin` — "web"/"cron"/"telegram"…, echoed back in `prompt-echo` to say WHO
spoke),
`prompt` (text, `force?`), `choose` n, `toggle` n, `confirm`, `freetext` n
text, `key`, `settle`, `restart`, `set-parent` (`parent` — the channel told when
this one finishes, blocks or dies; `null` detaches. Refused **explicitly** on a
cycle, an unknown parent or a cap),
`set-profile` (`profile` — the profile's name or
`null`; `restart?` to apply it right away by respawning in place. This is the
ONLY legitimate path: `profile` is `SERVER_OWNED` on the channel, so a browser
PUT `/channels` cannot touch it), `stop` (`sessionId?` —
kills a specific channel, so the UI can remove a zombie).

**server → client:** `ready`, `working` (carries `elapsedMs` — how long the turn has been running; the client anchors on the DURATION and never on a server instant, or the stopwatch is off by the whole gap between the two clocks), `turn-done`, `stream-text`,
`stream-tool`, `stream-result`, `history`, `dialog`, `screen`, `tokens`,
`context`, `parent` (the parent channel changed — broadcast, so every tab follows),
`profile` (the `{profile, applied}` pair — desired vs the one the running process
actually carries; their gap is what the UI shows as "at next reload"),
`prompt-echo`, `pace-blocked` / `pace-hold` / `pace-resumed`,
`auto-retry-*`, `version`, `server-reload`, `gone`, `error`, `exited`,
`stopped`. `error` carries an optional `code` — `"busy"` (prompt refused
mid-turn), `"link-refused"` (a `set-parent` the server will not accept) or
`"logged-out"` (a spawn refused because the instance is not signed in to Claude)
— so a machine client can classify a refusal without matching on the message
text.

**HTTP:** `/usage` (5h/7d + pace verdict), `/live` (running sessions),
`/sessions` `/recover` (resumable), `/diff`, `/channels` `/groups` (GET/PUT,
persisted per launch dir; the GET of `/channels` adds a **derived** `crons` —
the channel's schedules, for the tab's ⏰ — never stored, see invariant 6),
`/defaults` (server cwd), `/title` (GET/PUT — the cockpit's per-launch-dir
name; empty PUT reverts to default), `/theme` (GET/PUT — the cockpit's
per-launch-dir colour palette; default/unknown reverts to default),
`/tweak/prepare` (POST — clone/refresh
shadok-ai's own source, returns the cwd to start the tweak agent in),
`/profiles` `/secrets`
(GET/PUT/DELETE). `/secrets`: GET returns NAMES only, and PUT refuses an
existing name with 409 unless `overwrite: true`. `PUT /profiles` writes the
GUARDRAILS and is **browser-only** (cf. the profile-guardrail invariant);
`/profiles/prompt` (PUT) is the only profile write an agent can make — a
`systemPrompt`, its own or, under the lead profile, any.
`/telegram` (GET/PUT — bot config from the GUI), `/version`,
`/autoupdate`, `/permission-mode`, `/login`, `/vendor/marked.js`,
`/paste` (POST — ANY file pasted into the composer, not just images; lands
in the same `MEDIA_DIR` as Telegram attachments, keeps the original name via
the `x-filename` header so the extension stays truthful, and returns the
ready-made `[Image jointe : …]` / `[Fichier joint : …]` line. Accepts every
content type (`express.raw({type:()=>true})`). Browser-origin only: it writes
a file).

Everything except `/login` sits behind the optional password gate (see the
Auth section of `docs/architecture.md`).

## Invariants & hard-won gotchas (DO NOT relearn these the hard way)

1. **Session cwd must be the session's real directory.** `loadHistory` is keyed
   by the cwd (encoded → `~/.claude/projects/<enc>/<id>.jsonl`). A worktree
   session resumed with the repo-root cwd shows **no history**. Always resume a
   worktree session with its worktree path.
2. **Detection heuristics are fragile.** `screenShowsWork` must ignore a
   *quoted* "esc to interrupt" (Claude explaining shadok-ai tripped it →
   session stuck "busy"). `detectDialog` must strip a right-hand **preview
   column** (AskUserQuestion charts) or option labels get mangled.
3. **Single-select dialogs are navigated, not typed.** `choose` moves the `❯`
   cursor with arrow keys then Enter — preview-style dialogs ignore digit keys.
   Multi-select `toggle` uses the digit; `confirm` does Tab→Submit→Enter.
4. **The resume-from-summary prompt is auto-answered** ("full session as-is")
   at startup and never surfaced (`SHADOK_RESUME_SUMMARY=1` to disable).
5. **Worktrees never lose work — but an empty one is pruned on close.**
   `pruneWorktree` (called when a session ends) removes the checkout *only* if
   it's clean (`git worktree remove` without `--force`), and deletes the branch
   *only* if it has zero commits beyond the base — i.e. an agent that did
   nothing. Uncommitted changes → the whole worktree stays. Commits → the branch
   survives even if the checkout goes, and `/recover` recreates the checkout from
   it. Never add `--force` here.
6. **Persistence must never save a partial/empty list.** The channel list
   eroded to one because `persistChannels` skipped tabs without a sessionId and
   pushed mid-restore. Restored tabs get their sessionId **immediately**; pushes
   are suppressed during restore; a failed fetch must never PUT `[]`.
7. **A restart must not eat content.** The tail persists its byte offset
   (`~/.shadok-ai/tail/<id>.pos`) and resumes there — starting at EOF silently
   dropped everything an agent wrote during a restart, i.e. on **every
   auto-update**. The web recovered (it reloads history); Telegram never did.
   And resuming is useless if nobody reads: `reconcileOnBoot` reattaches the
   bridges whose tmux agent is still alive. Keep both halves.
   **Boot is not the only moment a bridge dies.** A bridge goes with its
   WebSocket (`ws.on("close")` drops it from `bridges`), so ending a session —
   a restart, a killed pane, a crash — takes it too, and rebuilding it only at
   boot left a restarted channel deaf towards Telegram until something unrelated
   restarted the server. The 5s `reconcileWebChannels` loop could not save it
   either: it only ever looked at channels with NO binding. Both reconcilers now
   share one rule, `shouldReattachBridge` — bound **chat**, no bridge, **and a live
   tmux session**. That last term is load-bearing: without it the loop would
   respawn a `claude` under every idle mirrored channel, and mirroring an idle
   channel is the topic's job, not a live process's.
   **Bound CHAT, not bound topic.** Keying that rule on `threadId` silently
   excluded the board's General, which by construction has none — that is how
   `mergeChannels` recognises the main channel. Its bridge was therefore never
   rebuilt once it died: the web channel kept working while Telegram went quiet,
   with nothing in the log to show for it. A DM has no topic either, and keys as
   `private:<id>`, never `group:<id>`.
8. **Don't let an agent restart the server.** It kills sibling PTY sessions
   mid-work. (tmux mitigates, but still.) Only the human / top-level restarts it.
   To try your own build, run it side by side on a free port — see "Running YOUR
   build" above. An agent that stops 3789 to free the port also cuts the session
   it is being driven from.
9. **Never `git merge` blind in the shared repo.** Parallel agents leaving
   conflict markers in `.ts`/`.html` = broken build + crashed server + a whole
   afternoon lost. Agents work in **isolated worktrees**; landing is a reviewed,
   conflict-checked, build-verified step. This is the #1 source of past chaos.
10. **The ESM bridge in `index.html` isn't ready at parse time.** The
   `<script type="module">` that puts `extractLiveText` / `profileBlurb` on
   `window` runs **after** the document is parsed; the classic `<script>` below
   it runs **during**. Anything that paints on load must wait for
   `DOMContentLoaded` (or guard on `window.<fn>`). The profile grid painted
   immediately, `window.profileBlurb` was `undefined`, the first card threw, and
   the grid stayed empty **in silence** — the call site is an unawaited async
   function, so nothing surfaced. tsc and the tests were green; only the browser
   showed it.
11. **The origin guard must let `Origin`-less clients through.** `src/net.ts`
   refuses a browser whose `Origin` isn't the request's own `Host` (a WebSocket
   ignores the same-origin policy, so any visited page could otherwise drive an
   agent). But the Telegram bridge, `pilotctl`, the CLI and the scheduler skill
   all open loopback connections **with no `Origin` at all** — tightening that
   branch to a deny would cut Telegram off from its own sessions. The bind
   (`SHADOK_HOST`, loopback by default) and the password are what stop a network
   attacker; this guard only ever addresses browsers.
12. **Every inline `<script>` in `index.html` must carry `__CSP_NONCE__`.** The
   page is served by a dedicated route (not `express.static`) that replaces that
   marker with a nonce drawn on every request, and the CSP refuses
   `unsafe-inline` — which is what neutralises the HTML an agent writes into the
   transcript. A block added without the marker **does not run, silently**. Same
   for inline handlers (`onclick=`), which the nonce does NOT cover: go through
   `addEventListener`. `test/csp.test.ts` locks both down.
13. **The agent's Markdown is always sanitised before `innerHTML`.**
   `DOMPurify.sanitize(marked.parse(…))` — `marked` lets raw HTML through, and
   this Markdown derives from what the agent read (a cloned README, a web page, a
   Telegram message). With no DOMPurify loaded, we fall back to `textContent`
   rather than injecting unfiltered HTML.
14. **Pace guard** blocks a prompt when `used > idealPace + PACE_EPSILON`
   (currently 2). A prompt can bypass with `force: true`. A blocked spawn is
   silent to the parent — surface it if you touch that path.
15. **A cron fire must say what it did, and a lost one must be replayed.**
   `cronTick` still advances `nextRun` *before* firing (that's what stops a long
   run from double-firing) — but `driveChannel` now returns a typed
   `DriveOutcome`, and `settleCron` reschedules a **transient** miss
   (`pace-blocked` / `busy` / `ws-error` / `exited`) ~10 min out via
   `nextRunAfterFailure`, capped at 3 tries and **never past the next normal
   slot**. The invariant survives because a retry is always written in the
   future and `cronsFiring` holds until `fireCron` settles. Non-transient
   (`error`, `timeout`) is never replayed: the timeout means the turn is still
   running, so replaying would stack two prompts. Every fire logs one `cron:
   <id8> …` line — including the quiet one, otherwise "ran, nothing to say" and
   "never ran" stay indistinguishable, which is the bug this fixed.
16. **A guard's exit code is not a failure signal.** `grep`/`diff`/`test` exit 1
   with no output exactly when a cron guard has nothing to report. `runCronCheck`
   keys on **stdout** for news; a non-zero exit only counts as broken when it
   also wrote to **stderr** (or was killed / never spawned). A broken guard wakes
   the agent so the monitoring doesn't die in silence — it costs tokens each slot
   until it's repaired.
17. **A cron id is never displayed in full — so every API that takes one must
   accept a PREFIX.** The three `list` views (web, skill, Telegram) print only 8
   characters. `DELETE /crons` compared the full UUID for strict equality and
   answered `{ok:true}` whatever happened: deleting from the skill deleted
   nothing and announced "deleted". Resolution is now unique and pure
   (`resolveCronId`) — an empty prefix and an ambiguous prefix are **refused**,
   never settled at random (a bare `/cron del` used to erase whichever cron came
   first).

18. **`active` (the current channel, web side) CAN be null.** Creation lives in a
   popin (`#setupOverlay`) and only creates the tab at "Start agent": opening it
   then backing out no longer leaves a stillborn tab, but nothing guarantees a
   channel exists any more — closing the last one leaves `active === null` and the
   central panel shows `#emptyState`. `refreshChrome` handles that case
   explicitly; every new `active.xxx` must be guarded. Corollary: a popin is added
   by carrying `.overlay` (no list of ids left to update — it was that oversight
   that let the cron panel render in the page flow).

19. **Anything that resumes a session on the user's behalf must carry the
   CHANNEL's cwd — invariant nº 1 has a cron-shaped trap.** `driveChannel` sent
   `cwd: process.cwd()` (the repo root) while `runCronCheck`, ten lines above,
   already resolved the channel's own directory: the guard ran in the worktree and
   the agent was resumed at the root, i.e. with **no history at all**. Both halves
   now share one pure resolver, `resolveCronTarget` — a single place that decides
   where a cron runs. It also forwards `branch` + `repo` (both are on `Channel`)
   so the `start` handler can recreate a reclaimed worktree checkout — which
   required fixing a second half: a resume has no `worktree` object, so patching
   `branch: worktree?.branch ?? null` **erased** the branch on the first resume
   (`upsertInto` writes anything non-`undefined`). `branch` is now only ever
   *asserted*, never cleared, like `repo`. And `gone`
   is its own `DriveReason` so a vanished directory is named in the log instead of
   hiding behind a generic `error`. The same trap waits for any future machine
   client (a "run now" button, a webhook): `process.cwd()` is the server's, never
   the session's.

20. **A session's repo is NOT the launch directory — and `mergeChannels` trusts a
   brand-new channel wholesale.** The browser used to send `repo: serverCwd` for
   every channel in `persistChannels`. That was accidentally right for years,
   because every worktree came from the repo the server was launched in. The
   "Tweak Shadok-AI" agent is the first whose repo differs (a worktree of
   `~/.shadok-ai/self/shadok-ai`), and a wrong `repo` is not cosmetic: it is what
   `ensureWorktreeCheckout` uses to recreate a reclaimed checkout, so a reopened
   session would hunt its branch in a repository that never had it. `repo` is
   server-owned, but `mergeChannels` pushes a channel the client just created
   **as-is** (`if (!prev) result.push(c)`) — being in `SERVER_OWNED` protects a
   field only once something is stored for that id. So the client no longer
   invents the key, and the server asserts it from `session.worktree.repo` at
   `ready`, ASSERT-only like `branch` (invariant 19).

21. **The SSH identity must never touch a real host's `~/.ssh`, and must live on
    the mounted volume — not `/root/.ssh`.** `ensureSshIdentity` (`src/ssh.ts`)
    runs at boot but is a NO-OP unless `/.dockerenv` is present: on a developer's
    Mac it must not read, move, or symlink `~/.ssh`. In a container it puts the
    key under `~/.shadok-ai/ssh/` **because that is the only path on a volume that
    survives `docker rm`+recreate** (the ephemeral `/root/.ssh` does not — a plain
    restart keeps it, a recreate wipes it, which is exactly the failure this
    fixes). Wiring `~/.ssh` is best-effort and **never destructive**: it migrates a
    pre-existing `~/.ssh` into the volume without clobbering the managed key/config
    and never deletes a user file; on any doubt it leaves `~/.ssh` alone and falls
    back to `GIT_SSH_COMMAND`. The whole thing is swallowed on error — an SSH-setup
    failure must never take down the boot path.

22. **The browser's socket scheme follows the page's — never hardcode `ws://`.**
    `openLink` (`public/index.html`) built `` `ws://${location.host}/ws` ``. That is
    correct on every developer setup, because they are all `http://localhost:3789`,
    and it breaks the moment the cockpit sits behind a TLS reverse proxy: the
    browser blocks a `ws://` socket from an HTTPS page as mixed content. The
    failure mode is the nasty one — the page is static HTML, so it paints
    perfectly, and only the channels never connect. Nothing appears in the DOM,
    tsc and the tests were green, and the server even answers `101` to a `curl`
    upgrade, so the proxy looks correct. It shipped to two HTTPS instances before
    anyone noticed. `test/ws-url.test.ts` scans `index.html` for it, the same way
    `test/csp.test.ts` locks the nonce. The proxy side has a twin trap: it must
    forward `Upgrade`/`Connection` or the socket dies before reaching us (README,
    "Behind TLS"). The server-side sockets (`telegram.ts`, `server.ts`) stay
    `ws://` on purpose — they dial 127.0.0.1, where there is no TLS.

23. **Dialog detection belongs to the screen watcher, not to one input path.**
    `detectDialog` used to be reachable only from `finishTurn`, i.e. only from the
    handlers that submit on the user's behalf (`prompt`, `choose`, `toggle`,
    `confirm`, `freetext`). `case "key"` — the terminal view — writes the
    keystrokes straight to the pilot and returns, so a question asked after typing
    there was **never announced**: it sat on the screen, visible in the engine room
    and absent from the chat, with `/live` reporting `busy: false` because the
    server never knew a turn had started. The `isWorking()` line in the watcher
    was not a safety net either — by the time a dialog is up, the screen no longer
    looks busy, so it never fired. The watcher now runs `detectDialog` on every
    screen change while `!busy`, which covers `key` and anything that ever bypasses
    `finishTurn`. That is affordable only because `publishDialog` dedups on
    `dialogKey` (question + labels, deliberately NOT the ❯ position nor the
    checkbox states — a cursor move is not a new question, and a multi-select
    toggle re-renders through its own direct broadcast). `finishTurn` clears the
    key on `turn-done` so asking the SAME question twice still reaches the clients.

24. **The context gauge reads the transcript, never the footer — and the window is
    a SETTING, not a model.** The percentage used to come from
    `screen.match(/ctx:\s*(\d+)\s*%/)`. That string is not produced by Claude
    Code: it comes from a **custom statusLine** the user happens to have
    configured. So the gauge worked on the author's machine and on essentially no
    one else's — every fresh install and every container showed no bar at all,
    silently, because a footer that never matches is indistinguishable from a
    session that has not answered yet. It is now computed from the `.jsonl` token
    usage, which is where the rest of the content already comes from. Two traps
    live in that arithmetic. **Cache reads count** — they are context the model
    was given, and excluding them under-reports a long session by most of its
    size; output does not count, the next request does not start from it. And the
    1M window is **per-session**, written as a suffix on the model setting
    (`"opus[1m]"`), while the transcript records the RESOLVED name
    (`claude-opus-4-8`) with the suffix stripped — so it cannot be recovered from
    the transcript, and matching on model NAMES is wrong, the same model runs at
    either size. When nothing is configured (a container's `settings.json` has no
    model), the standard window is assumed and `effectiveWindow` promotes it on
    proof: 409k tokens cannot fit in 200k. Verified end to end — the same message
    the CLI footer showed as `ctx:41%` computes to 41%, with or without the model
    setting.

25. **A restart must GUARANTEE a new process — `TmuxPilot.start()` adopts an
    existing pane by design.** That adoption is what makes an agent survive a
    server restart, and it is also the trap: if the pane outlives the stop, the
    "restart" silently reattaches to the very process the user wanted gone. Same
    pane, same wedged state, no error, nothing in the log — `Reload agent` became
    a no-op. Two things allowed it. `stop()` began with `if (this.exited) return`,
    and `exited` **latches on a single failed `has-session` probe** (`tmuxOk`
    swallows every tmux error into `false`), so a pilot that wrongly believed
    itself dead returned without killing. And the graceful exit runs through
    `submit("/exit")`, which needs an input box — precisely what a wedged TUI does
    not have, so the very situation a restart exists to rescue is the one where
    the graceful path cannot work. Now: `stop()` consults `hasSession()` and never
    the flag, and `restartSession` **enforces** the outcome (hard `tmuxKillSession`
    + re-check) instead of merely watching its wait loop expire. The rule
    generalises — any code that respawns must verify the old process is gone, not
    assume a stop worked.
    Where the wedged agents came from is worth keeping too: `/root/.claude.json`
    holds the onboarding state and is **not** on a volume, so a container recreate
    loses it. `reconcileOnBoot` respawns sessions ~1s after boot, i.e. before a
    post-`run` `docker cp` can restore the file — the agents land on Claude Code's
    first-run screen and never reach a prompt. **`src/claude-home.ts` closes that
    race**: `ensureClaudeHome()` runs before `ensureSshIdentity()` in the boot
    path, so the file is written before anything can spawn and the
    `docker create` → `docker cp` → `docker start` ordering is no longer needed.
    Keep the history anyway — the symptom it names is what a *future* onboarding
    change would surface again.
    `describeStuckScreen` (`src/detect.ts`) now names such a screen in the submit
    error: the bare "the text never appeared in the input box" points at an input
    box that does not exist, and sent two investigations to the wrong subsystem.

26. **A field accepted in `start` is not a field STORED — and only the browser
    tells you.** `parent` was added to the `start` message, sent by `pilotctl`
    from its own `SHADOK_SESSION_ID`, typed in `ClientMessage`, and covered by
    unit tests. `tsc` was clean, 408 tests were green, and the automatic link —
    the entire point of the feature — did **nothing**: the handler simply never
    read `msg.parent`, so it was dropped between the wire and `upsertChannel`.
    Only an end-to-end run against a real server on a free port surfaced it. The
    class generalises beyond this field: a `start` payload is a plain object,
    every unknown key is silently ignored, and no type in the union proves that
    anyone consumed it. When you widen `start`, assert the value came out the
    other side. Two smaller rules came with it: the link is validated exactly
    like `set-parent` (a cycle costs the same either way), but a refusal at
    start only DROPS the link instead of failing the spawn — killing an agent
    over a bad link is worse than one that reports to nobody — and it is logged,
    so it is not a silent loss. And `parent` is ASSERT-only on the channel, like
    `branch` and `repo` (invariant 19): a client that omits the key must never
    erase a link that already exists.

27. **The diff baseline is COMPUTED, never stored — and `A...B` is the wrong
    way to compute it.** `Worktree` used to carry a `baseSha` frozen at spawn,
    and `gitDiff` diffed against it. Two ways that goes wrong, in opposite
    directions: a sha frozen days ago is no longer where the branch forks once
    the agent rebases (the panel then shows main's work as the agent's), and
    diffing against the base's *tip* instead has the same effect from the start.
    Both disappear with `git merge-base <base> HEAD` recomputed on each call —
    one field of state removed rather than added. The trap in the fix is the
    obvious spelling: `git diff <base>...HEAD` also picks the merge-base, but it
    stops at the branch **tip**, so everything the agent has not committed yet
    vanishes from the panel — and uncommitted work is most of what the panel is
    for. Diff against the merge-base COMMIT (`git diff <mb>`), which compares it
    to the working tree. Same split in `listPastSessions`: `hasChanges` needed
    the three-dot form (it compares two refs, no working tree involved), while
    `commits` was already right as `base..branch` — that range excludes the
    base's commits by construction, even ones the agent merged in.

28. **A profile carries the GUARDRAILS, so an agent must never be able to write
    one.** `PUT /profiles` accepts `deny`/`allow`/`secrets`/`model`, and until
    now nothing stopped an agent from calling it: `requestAuthed` returns true
    outright when no GUI password is set, and the origin guard deliberately lets
    Origin-less callers through (invariant 11, for Telegram and pilotctl). A
    read-only agent could therefore `curl -X PUT /profiles -d '{"deny":[]}'` and
    hand itself git writes. That route now requires a real same-origin `Origin`
    header (`browserOrigin`, stricter than `originAllowed` on purpose), and
    agents get `PUT /profiles/prompt`, which only ever writes `systemPrompt` —
    an update reuses the stored profile, so guardrails survive by construction,
    and a created role gets `secrets: []` whatever the body asked for. Scoping
    is the per-session `SHADOK_SESSION_KEY` from the agent's env, **never the
    session id**: `/live` publishes every id, so it proves nothing. Two limits
    to keep honest — a managed prompt (`Shadok-Tweak`) is refused rather than
    swallowed, since a boot would silently overwrite it; and none of this is a
    sandbox. Agents run as the same OS user and can rewrite
    `~/.shadok-ai/profiles.json` directly. This removes the accident and takes
    the capability off the documented surface; a hard boundary needs a separate
    OS user or a container per agent.
29. **A signal you never observed is not a signal — and the sign-in's success is
    one of them.** `claude auth login --claudeai` prints `Invalid code. Please
    make sure the full code was copied.` on a refusal; that wording was captured
    from the real binary. It presumably prints *something* on success too, but
    nobody ever saw it, and matching a guessed phrase would produce the worst
    failure this feature can have: a sign-in that completed fine, reported as
    never finishing, forever. So success is taken from the child **exiting
    cleanly** after a code was submitted — an observable fact. Two neighbours
    follow the same rule. An invalid code does **not** end the flow (verified: the
    CLI re-prompts, so a retry reuses the same child and needs no new URL).
    Generalise it: when a state can be read from an exit code, a file, or an API,
    prefer that over the prose next to it.
    **Corollary, learned the hard way one day later: "I observed it is signed
    out" and "I could not look" are DIFFERENT facts.** `parseAuthStatus` first
    collapsed them, reading unparseable output as *signed out* on the argument
    that a spurious card costs one click. It does not: the card **spawns a
    `claude auth login` child** and the same verdict **refuses every spawn**. And
    the probe is a ~850ms process spawn whose error `execFile` was silently
    dropping, so a busy machine popped the sign-in card on instances that were
    signed in the whole time. `AuthState` is now three-valued; only `signed-out`
    is ever asserted, `unknown` retries once, is never cached, never opens the
    card and never blocks a spawn.

30. **On a phone the viewport is THREE different rectangles, and CSS only knows
    two of them.** The cockpit is a fixed chassis, so its height is load-bearing:
    `100%` is the *layout* viewport, which assumes the URL bar retracted — that is
    what put the composer under the browser's own bar. `100dvh` follows the bar.
    Neither follows the **keyboard**: when it opens, the layout viewport keeps its
    full height, the composer ends up underneath, and the browser then scrolls the
    document to reveal the field — which is the "everything jumps up" symptom, the
    header leaving by the top. Only `visualViewport` reports the keyboard, so
    `syncViewport` sizes the chassis from it (`--app-h`, `body.vv-sized`) and the
    browser's rescue scroll has nothing left to do. Guarded on `(pointer: coarse)`:
    on a desktop `visualViewport` also tracks pinch-zoom, and resizing the page on
    every pinch would be a regression for nobody's benefit.
    The sideways drift had the same single root cause as the jump, and it is not
    where anyone looks: **Safari zooms into any focused field whose font is under
    16px.** The zoom makes the layout viewport wider than the screen, so the whole
    interface can suddenly be dragged left and right — and whatever sat at the
    right edge of the header (the 🔑) is simply off-screen. Nothing overflows,
    every element measures correctly, and a desktop browser narrowed to 390px
    reproduces none of it. The fix is 16px fields, **not** `maximum-scale=1`: that
    would take pinch-zoom from the people who need it. Each rule has to match or
    beat the specificity of the one it corrects (`#composer textarea` beats a bare
    `textarea`) or it silently loses. `test/mobile-viewport.test.ts` locks all of
    it, the way `test/csp.test.ts` locks the nonce.

31. **The beta channel IS the `latest` dist-tag — CI can only ever SET a tag, not
    move one.** npm Trusted Publishing (OIDC) authenticates `npm publish` and
    [nothing else](https://docs.npmjs.com/trusted-publishers): `npm dist-tag add`
    needs a traditional token, so the obvious design — publish everything as
    `alpha`, then move `beta`/`latest` on promotion — would put a long-lived npm
    credential back in repository secrets, undoing the reason Trusted Publishing
    was adopted. Since `npm publish --tag X` *sets* X, an ordinary merge publishes
    `--tag alpha` and a promotion publishes with no tag, which is what moves
    `latest`. Two consequences to keep: **do not add a `beta` dist-tag** thinking
    it is tidier — it cannot be maintained without the token; and a promotion
    leaves `alpha` pointing at the PREVIOUS build, so for one merge the fast
    channel resolves older than the calm one. `pickTarget` fixes that client-side
    (alpha takes the newer of the two tags) rather than in CI, because an alpha
    instance that downgrades itself is worse than the window it closes.
    Promotion is decided from the REGISTRY (`package.json` minor vs the minor
    `latest` points at), never from git history, so a workflow re-run or a replay
    cannot promote twice. The channel also picks the NUMBER: an alpha is
    `<major>.<minor>.<commit count>`, a promotion is `<major>.<minor>.0`. The
    first promotion went out as `0.3.77` under the older rule — a number that
    reads as the 77th patch of a 0.3 series that never had one, which is worse
    than useless to whoever is trying to tell two releases apart.

32. **A multi-question `AskUserQuestion` is a form with a tab bar, not one
    dialog — answer each question, never auto-drive past it.** When Claude asks
    several questions in one call, the TUI shows a `←  ☐ Q1  ☐ Q2  ✔ Submit  →`
    tab bar and one question at a time. A SINGLE-select question already worked:
    `choose` sends the cursor + Enter, which advances to the next question, and
    `finishTurn` re-detects and publishes it. A MULTI-select question did NOT:
    the `confirm` handler pressed **Tab then Enter** — fine for a *standalone*
    multi-select (Tab opens the recap page), but in a multi-question form Tab
    moves to the NEXT question and that Enter silently answered it with its
    default, corrupting the form (the user's report was "I answered and it said I
    declined"). Now `confirm` inspects what Tab produced: the recap page → let
    `finishTurn` submit; a further question → `publishDialog` it so the user
    answers it. Two more rules fell out: the recap page ("Ready to submit your
    answers? · Submit answers / Cancel") is **not a real question** — it
    mis-parses as a multi-select and would flash a broken, disabled dialog — so
    `publishDialog` drops it (guarded by `SUBMIT_PAGE`) and `finishTurn`
    auto-confirms it (Enter defaults to "Submit answers"). Verified end-to-end
    against a live agent: single, standalone-multi, and multi-question forms with
    a multi-select all land the exact answers with no decline.

33. **One agent = one channel row: dedup by `sessionId` at BOTH ends, because a
    duplicate self-feeds.** A spawn-time race (the spawn's `upsertChannel` +
    the holder's) could momentarily put two rows for one session into a client's
    tab list; `mergeChannels` iterated `clientList` and pushed each without a
    within-list dedup, so both were persisted — and `syncChannels` builds
    `tabById` ONCE, so a `/channels` list carrying the same id twice created a
    second tab (createTab isn't seen mid-loop). The two tabs then re-persisted
    the duplicate: same agent, twice in the left column, surviving every reload.
    Neither layer alone was enough — the fix dedups by id in `mergeChannels` AND
    `loadChannels` (server, so a corrupted file self-heals on the next save) AND
    the `syncChannels` loop (client, so a stale/duplicate list never renders
    twice). `dedupById` is pure and tested.

## Conventions

- TypeScript, ESM, Node 20. `.js` extensions in imports (NodeNext).
- Comments explain **why**.
- **Everything written into the repo is in English**: code comments, identifiers,
  commit messages, PR titles and bodies, specs, docs, test names, log and error
  strings. The history was mixed FR/EN until a one-off pass translated it all;
  keep it that way, and never let a French comment back in. That pass is not to
  be repeated — a diff that only changes the language of untouched lines buries
  the real change.
  Chat replies to the user are **not** covered by this — they follow the user's
  language (see `context/pilot-prompt.md`). The web UI's own copy is English.
- Feature work: write a spec in `docs/superpowers/specs/`, build in a worktree,
  land reviewed.
- **Docs ship with the change that makes them wrong** — same PR, not a catch-up
  pass. `README.md` for anything user-visible (feature, flag, command, endpoint,
  WS message), `docs/architecture.md` for a new or reshaped subsystem and the
  trade-offs behind it, this file for a new module or a fresh invariant. See
  "Keeping the docs honest" in the README for the split.
  `docs/architecture.md` once drifted **48 commits**: by then it was missing whole
  subsystems and its line numbers pointed hundreds of lines off, which misleads a
  reader rather than merely leaving them uninformed. Prefer citing **symbols**
  (`finishTurn`) over line numbers, which do not survive a refactor.
- After any change with runtime surface: `npm run build`, then verify in the
  browser (not just tsc) — side by side on a free port, never by taking over
  3789. See "Running YOUR build" above.
