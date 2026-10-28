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
(`.github/workflows/publish.yml`, version = `major.minor.<commits since that minor>`), so a
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
| `src/claude-bin.ts` | Makes sure a RUNNABLE `claude` is there before every spawn, and says which binary that is. On a fresh machine the bare `pty.spawn("claude")` threw an opaque `posix_spawnp failed`; `resolveBin` looks it up on PATH and `ensureClaude` installs `@anthropic-ai/claude-code` ONCE on demand (`ensureClaudeOnce` in `server.ts`, single-flight), falling back to a clear "install it manually + sign in" message. The one-time Claude sign-in is the user's own — no install forces it. Since the split packaging, "a file named claude that is executable" is NOT "a claude that works": `classifyBin` recognises the npm placeholder, `findClaudeBin` falls back to the native binary behind it, and `claudeCommand` is the ONE answer to "which binary do we spawn" — the pilots, the auth probe, the sign-in and the version probe all go through it. See invariant 32. It also never installs over Claude Code's own self-update: `claudeInstallInProgress` spots npm's reify directory and `ensureClaude` waits for it (bounded), then looks again after a failed install before calling the CLI missing. Pure cores (`classifyBin`, `platformPkg`, `nativeBinCandidates`, `findClaudeBin`, `findClaudeBinWithRetry`, `rewriteInProgress`, `globalScopeDirs`) tested; the placeholder is also read off a real file on disk. |
| `src/node-pty-fix.ts` | The OTHER `posix_spawnp failed`: node-pty's prebuilt `spawn-helper` must be `chmod +x` to run. The package `postinstall` does that, but via a RELATIVE path that only holds for a dev checkout; installed as a dependency (npx / managed `~/.shadok-ai/app`) node-pty is **hoisted** to the parent `node_modules` and the chmod silently misses — so a colleague's very first agent died with `posix_spawnp` even though `claude` was fine. `ensureSpawnHelperExecutable` (called at boot in `server.ts`) chmods it from node-pty's REAL location, resolved at runtime — every install layout. `spawnHelperPaths` is pure, tested; the real chmod is covered end-to-end. |
| `src/tmux.ts` | `TmuxPilot` — same interface as `PtyPilot`, but runs `claude` in a **detached tmux session** (`sk-<sessionId>`). **Survives server restart** (reattaches). Default transport when tmux is present. A spawn goes through `launcherScript`: secrets and prompts are written to a private one-shot script and the tmux command is just `sh <script>`, never the values themselves; `tmuxErrorMessage` keeps any tmux failure down to the subcommand and tmux's own complaint. Both pure and tested — the script is RUN by the tests. See invariant 36. |
| `src/tmux-install.ts` | Auto-installs tmux at boot when it's missing, so the durable transport is the default without setup (node-pty agents die on every auto-update). `tmuxInstallCommand` (pure, tested) picks the package manager — `brew` on macOS (no root), `apt-get`/`apk`/`dnf`/`yum`/`pacman` on Linux (root, else non-interactive `sudo`). `ensureTmux` runs it best-effort and NEVER blocks the boot: on failure it stays on node-pty with a clear message. The boot caller (`server.ts`) flips the `let USE_TMUX` on once the install lands, so the same process picks tmux up. `SHADOK_TMUX=0` skips it. |
| `src/tail.ts` | Tails a session's `.jsonl` transcript → streams assistant text/tool_use/tool_result + token usage. **This is the source of truth for content**, not the screen. Also emits a `silent` event where such a block is dropped — dropping it without a trace made the parent-notification guard UNREACHABLE (`notifyParent` reads the last STREAMED block, and that one never became one), so a quiet child still woke its parent: empty, or carrying a stray earlier thought. Also owns `isNothingToShow` — a text block that is *only* `NOTHING TO SHOW` is dropped (a cron with no signal must be able to stay silent); the twin filters live in `loadHistory` and the web live preview. A `text` event carries `afterInternal` when a HIDDEN block (a skipped `thinking`, or a dropped `NOTHING TO SHOW`) separated it from the previous visible one, so the client keeps its speaker label instead of gluing "text · &lt;think&gt; · text" into one wordless run under a single label. The SAME boundary is needed one level up, between TURNS: a hidden USER prompt (a `cron` fire or a parent notification) is dropped, so the answer it triggered would stream/replay adjacent to the previous turn and merge under one label (a daily report gluing onto an unrelated earlier answer). `loadHistory` sets `HistoryTurn.afterInternal` on that turn (and stops merging it), and live the server flags it via `Live.gapBeforeNextText` (set when a `cron`-origin prompt is submitted un-echoed, consumed by the next streamed text) — both surface as the client's `.after-gap`. The path re-resolution that follows a MOVED transcript is paced by `resolveStep` (pure, tested): never while the file grows, the old ~1s cadence while it is missing, exponential backoff capped at ~10s while it is silent — see invariant 38. |
| `src/extract.ts` | Parse the transcript / screen: `loadHistory`, `detectDialog`, `listSessions`, `findSessionId`, `transcriptFilePath` (the shared `<id>.jsonl` resolver, reused by `GET /download`). `loadHistory` also emits a `file` turn for a `SendUserFile` so a delivered file's card survives a reload (other tool blocks are dropped as noise). It flags a **compaction summary** (`isCompactSummary` on the .jsonl line — the long "This session is being continued…" block Claude Code writes on compaction) with `HistoryTurn.compaction`, so the client folds it into a collapsible box (`addCompactionCard`) instead of a full-width bubble that buries the chat; the text is kept whole, only hidden. The LIVE tail never emits it (its content is a bare string, not a block array), so compaction shows only on replay — which is where the user sees it. `detectDialog` reads the question by walking UP from the first option and stopping at décor — `FRAME_LINE`, a line that STARTS with a frame, rule or marker character. That class carries the whole family of box-drawing dashes (`╌╍┄┅┈┉`), not the one a release happened to use; see invariant 2. `detectDialog` also returns the box's `body` — the text above the question that a person judges a permission prompt by (see invariant 43). Pinned against five real 100-column screens in `test/fixtures/dialogs/`. |
| `src/download.ts` | Files an agent hands the user via the harness `SendUserFile` tool (`tool_use` name `SendUserFile`, `input.files` = absolute paths). Pure helpers, tested: `toolFiles` (a tool_use's sent paths), `fileCard` (`{path, name, image}`), `isImageFile` / `telegramPhotoable` / `contentTypeFor`, and `sentFilePaths(transcript)` — the SECURITY core of `GET /download`: a path is servable ONLY if it appears in that session's transcript as a sent attachment, so the endpoint can never be walked into an arbitrary file. shadok surfaces sent files as a download / inline-image card on the web and an upload (sendPhoto / sendDocument) on Telegram. |
| `src/whisper.ts` | Local speech-to-text for Telegram voice notes, provisioned **ON DEMAND** at the first voice message and never at boot — the live VPS builds its images from a host-side Dockerfile of its own, so anything baked into the repo image reaches no running instance, while a first-use download reaches every instance the moment it updates. Three parts, not one: `cmake` (whisper.cpp's Makefile has been a **cmake shim** since v1.9 — `make` alone does not build it, and upstream publishes no prebuilt Linux binary), a **static ffmpeg** fetched as a RAW binary (the usual `.tar.xz` builds are unusable here: `xz` is absent from the image), and a model. **`ggml-small-q5_1.bin` (181 MB) is the default on a MEASUREMENT, not a preference**: same clip, same machine, 15.2s against `medium-q5_0`'s 49.6s for IDENTICAL output, on 11 seconds of audio — a 30-second note would take two minutes on medium. The honest limit of that measurement is one clip of clear studio English; noisy or accented speech is exactly where medium earns its size back, which is why `SHADOK_WHISPER_MODEL` makes the choice a download and never a code change. Everything is pinned to an exact version, never a moving tag, the rule the updater already follows. Single-flight, because two voice notes a second apart would otherwise start two 514 MB downloads and two compiles over one tree — that is precisely how the first-boot `ENOTEMPTY` happened. A failure is announced ONCE and remembered until restart: retrying would turn every voice note into a failed 514 MB download. `ffmpegAsset` REFUSES an unknown platform rather than guessing (a wrong-arch binary dies at `execve`, invariant 32's family), and `modelLooksComplete` catches an HTML error page saved as a model. Shared between containers via `SHADOK_WHISPER_DIR` — shadok can only make the path configurable; the common mount is an operator gesture, and without it this degrades correctly to one copy per container. `ensureFfmpeg` is **split out** and is now the ONE place that writes the binary: the video path needs ffmpeg alone, and provisioning it twice would mean two downloads into `${dest}.part-${pid}` **from the same pid** — the `ENOTEMPTY` race this file already paid for once. A transcription that produced nothing says WHY (`kind: "empty" | "failed" | "unavailable"`): a voice note shows one notice either way, but "I understood nothing in that voice message" is wrong twice over for a silent screen recording. `parseWhisperText` drops a line that is only a sound TAG in parentheses as well as in brackets — a 440 Hz tone really came back as `(Bell)`, and quoted to the agent it reads as something the user said. Pure cores tested. |
| `src/video.ts` | What makes a shared VIDEO readable. The bug it fixes is one level up (`attachmentOf` did not know `msg.video`, so `handleMessage` dropped the message in silence — a video carries no `msg.text` at all), but recognising it only trades a silent drop for an honest dead end: nothing in `Read` opens an mp4, and the image has no `ffmpeg` on `PATH`, so an agent handed a path cannot help itself either. `lookAtVideo` therefore does the looking: `frameTimestamps` plans the stills (one per ~5 s, capped at 6 — 2 each inside an album — each taken at the MIDDLE of its slice, because a first frame is routinely black and a black still is the whole budget of a short clip), `extractFrames` pulls them with `-ss` BEFORE `-i` (the fast seek) and trusts the FILE rather than the exit code, and `probeVideo` reads the audio track and the duration off ffmpeg's own listing — `audio: null` ("could not look") stays distinct from `false` ("silent"), invariant 27 again. Duration comes from Telegram when it sends one and from ffmpeg otherwise, which is what gives a video sent AS A FILE a real storyboard instead of one frame. Speech is transcribed through the voice pipeline, but NOT past `TRANSCRIBE_MAX_SEC` (whisper runs ~1.4x realtime and the turn cannot start until the prompt is sent) and never inside an album; in both cases the prompt SAYS the sound was left unheard, since an agent told nothing about the audio concludes there was none. Pure cores (`frameTimestamps`, `clock`, `hasAudioStream`, `parseDurationSec`) tested; the extraction itself is verified by running it on a real clip. |
| `src/files.ts` | Files an agent OFFERS the user through shadok's own path, beside the harness's `SendUserFile`. It exists because that tool is NOT on every agent: a tmux agent keeps the Claude Code binary it was spawned with (that is what lets it survive an auto-update), so one older than the tool never sees it — measured, 67 live panes of 67 on a pre-upgrade binary — and an instance answered *"cet outil n'existe pas dans ma session"* then invented a `fichier: /path` line of its own. A registry of OFFERS, not a copy: `~/.shadok-ai/files/<enc>.json`, keyed like channels and crons. `offerVerdict` keeps **missing and unreadable APART** (they send the agent to different places) and requires an ABSOLUTE path, because the server's cwd is its launch dir and never the agent's (invariant 1) — the skill resolves it agent-side. `offeredPaths` is the read gate and the twin of `sentFilePaths`: **a path is servable only if THIS session offered it**, so `GET /download` still cannot be walked into an arbitrary file. Re-offering supersedes rather than appends. Pure cores tested, including that another session's offer never authorises this one. Because an offer lives in the registry and NOT the transcript, `loadHistory` (which replays `SendUserFile` as `file` turns) never saw it — so a skill-delivered image showed once, live, then vanished on the next web reload while Telegram, which uploaded the bytes, kept it. `historyWithOffers` (`server.ts`) merges the session's offers back into the `history` it sends, interleaved by timestamp, so the web card survives a reload like everything else. |
| `src/bang.ts` + `public/bang.js` | Running an agent's `!` command from the chat, on the HUMAN's behalf. Its own WS message (`run`), never the prompt path: shadok prepends `⟦web · time · who⟧` to every human prompt, so a `!` sent as a prompt reaches the MODEL as text — measured, the model then ran it through its own Bash tool, i.e. a model turn plus guardrails plus classifier between the click and the command. Shell mode is NOT the Bash tool, so **a profile's `deny` does not apply** — measured under `Shadok-Boss`, whose profile denies `Bash(git commit:*)`: a shell-mode `git commit` created the commit. That is the escape hatch wanted, and why `run` is accepted ONLY on a same-origin browser connection (`fromBrowser`, decided once at connect from the upgrade headers): pilotctl and the agents connect with no Origin (invariant 11) and must never reach it. `runRefusal` refuses empty, multi-line (shell mode reads ONE line; joining lines would run something nobody saw written) and oversized commands; the server types `!`, WAITS for `isShellMode` (column-0 `!` + NBSP — never a fixed delay, invariant 3), then reuses `submit`, and presses Escape on failure so no stray `!` turns the next prompt into a command. `parseBashMessage` reads the TUI's own `<bash-input>` / `<bash-stdout>` user messages, so the exchange is CONTENT from the transcript: streamed as `stream-bash`, replayed as a `bash` history turn — which also rescues a command typed by hand in the terminal view, previously dropped by `userPromptText`'s `<` guard. `bangCommands` (client, pure) offers a ▶ button only for `! cmd` in inline code or on its own line, never for prose with an exclamation mark. Found only in the browser: `parseLine` rejected every non-array `message.content`, and the TUI writes `<bash-input>` as a STRING — so the command ran, the reload showed it, and the live chat said nothing. Pinned by a tail test. |
| `src/detect.ts` | `screenShowsWork(screen)` — the fragile "is Claude working" heuristic. Also `idleStep`, one poll of the "is this turn over?" loop, pure and shared by BOTH pilots (it lived twice, and could only be exercised by spawning a process). A turn ends on an ABSENCE of change — no work marker plus a byte-identical screen for `stableMs` — which is conservative on purpose. `stableMs` is a parameter because the bar is not always the same: after an explicit interrupt the end state was REQUESTED, not inferred, so `finishTurn` lowers it to 400ms and the composer comes back in a fraction of the time. What no caller can shorten past is the work check, which sits above the window. Beside it, `settleStep`: the OTHER way a wait ends — the same dialog (the caller's key, `dialogKey`) held for `DIALOG_HOLD_MS`, however much the rest of the screen moves; same work check above it. See invariant 21. Also `inputText`; `typeIntoBox`, the paste-until-it-shows loop both pilots share, which compares the box with what it showed BEFORE the paste rather than with empty (an idle box can display an example prompt — invariant 23) and which takes a **`prelude`** — injected context pasted as its OWN paste(s) BEFORE the message, never concatenated into it (see the `src/ledger.ts` row for why that is correctness, not style). It may be a LIST, because the paste threshold is applied PER PASTE and decided as each one is made: N small pastes carry in the clear what one large one cannot (measured, eight chunks and a message = 1272 chars over nine lines, nothing wrapped). Each chunk must be WAITED for before the next, or they reach the pane as ONE paste event and the whole split is undone; a chunk that never lands does not fail the submit. Its success check is the trap, and every reading of it goes through **`boxText`** — the WHOLE composer (between the `❯` line and the bottom border, or the status line when a screen carries no frame; that line moves on its own as background shells come and go). `inputText` reads the `❯` line ALONE, which is everything there is until the box holds more than one line and nothing at all afterwards: a prelude filling that line, a prompt that wrapped, or a box that was already occupied all hide what is appended under it. That blind spot is invariant 36 — six attempts, six headers stacked in the box, "the text never appeared in the input box", hit on a live agent. A paste is accepted when the box DIFFERS from what it showed just before (never "is non-empty": an idle box can display an example) **and** when what it showed did not SURVIVE the paste. That second half is the ghost: at rest the box may offer a previous message as a greyed-out suggestion any paste wipes out, while after an interrupt it holds the real prompt the TUI put back — and a plain capture renders the two identically, so the code does not guess, it pastes and asks afterwards (`survives`, first line, 40 chars). Joined rather than replaced → the attempt is thrown away and the box emptied, which keeps the cost on the rare dirty box instead of charging every message a Ctrl-U to find out. `emptyBox` presses Ctrl-U until the box stops changing, because that key clears ONE line — judged on **`boxRaw`** (the untrimmed box: the middle press of a two-line clear only removes the blank line left behind, which `boxText` trims away) and read from `screen()` rather than through `waitFor`'s mirror, whose refresh is slower than the window the press gets. A box it cannot empty gets ONE Ctrl-C (`shouldHardClear`, `hardClearIfLeftover`), never two and never over a running turn. A prelude that never lands does NOT fail the submit — losing context is survivable, losing the message is not. `test/detect.test.ts` goes red on every wrong baseline, which is the only reason to trust it. And `describeStuckScreen`, which names a recognisable blocking state (first-run screen, masked field, pending question, a box still holding MULTI-LINE text — never the one-line suggestion, which would be a confident wrong answer) so a submit failure says WHY instead of accusing the input box. See invariants 23 and 36. Also `backgroundTasks` → `{shells, monitors}`: what the pane says is still running, read from the TUI's **own** footer and not from the turn line, which scrolls away. The two share ONE segment, comma-separated (`· 1 shell, 1 monitor ·`), which is why the rule matches the segment **whole** — split on `·`, accept a part only if it is entirely a comma-separated list of counts — rather than hunting a number before `shell`: anchored on a leading `·`, the monitor sitting after a comma is invisible. Matching whole is also what keeps prose out (invariant 2's family), and only the last few non-empty lines are read. Unlike the pre-invariant-24 context gauge, this string is native: verified with no `statusLine` configured, on 61 of 64 live panes. |
| `src/backend.ts` | Which model backend an agent talks to: the subscription, or a CUSTOM one (a self-hosted open model, a gateway) reached through Claude Code's own `ANTHROPIC_BASE_URL`. `backendEnv` merges shadok's env (forwarded ONLY when it already points off Anthropic — a stray `ANTHROPIC_API_KEY` in a dev shell must never move a subscription instance onto API billing) with the profile's secrets (which win), and maps every unset model alias to `ANTHROPIC_MODEL` so the picker and Claude Code's background small-model calls reach the one model served. Passed explicitly in `makePilot` because a tmux pane does not reliably inherit shadok's env. A custom agent skips the sign-in gate (`gateProfile` resolves the profile before the id), the pace guard (`Live.backend`) and, instance-wide, the lead agent's sign-in wait and the sign-in card (`/auth` → `backend: "custom"`); `SHADOK_CONTEXT_WINDOW` sets its gauge window. An unparseable or non-http(s) URL is NOT custom (`localhost:11434` parses with `localhost:` as its scheme). It can also be CHOSEN in the cockpit: the sign-in card's "Another model" side (and the version menu's **⚙ Model backend…**) stores `config.modelBackend[cwd]`, which `instanceEnv` makes the instance source in place of the env — **wholesale, never merged**, or a shell's `ANTHROPIC_API_KEY` would reach the third-party server just configured. Presets list only Anthropic-compatible servers (an OpenAI-only API needs a proxy); Save waits for `POST /backend/test`, one real `/v1/messages` sent with a bearer exactly as Claude Code sends it, so a pass predicts a working agent. Pure, tested. Spec: `docs/superpowers/specs/2026-10-28-custom-model-backend-design.md`. |
| `src/context.ts` | How full the model's context window is, from the TRANSCRIPT's token usage — `contextTokens` (input + cache creation + cache read; output excluded), `windowForModel` (the `[1m]` SETTING, never the model name), `effectiveWindow` (an over-run PROVES the assumed window too small → promote), `pctFromUsage`. Pure, tested against a real message whose CLI footer read 41%. See invariant 22. |
| `src/worktree.ts` | Git worktree isolation: create, diff, list past sessions, recreate a reclaimed checkout. |
| `src/selfrepo.ts` | The working copy of shadok-ai's OWN source (`~/.shadok-ai/self/shadok-ai`) behind the "Tweak Shadok-AI" CTA: anonymous clone (no auth needed to start), `main` hard-reset to the remote on each use, never the launch directory. Only the base clone is refreshed — a live tweak session's worktree is a separate checkout and is never touched. Pure cores (`selfRepoPlan`, `gitFailReason`) tested. |
| `context/tweak-prompt.md` | Role of the tweak agent, written for the person it answers to rather than for the procedure: the non-developer rule comes FIRST and governs the rest (a named banned-words table — pull request / branch / CI / diff — with what to say instead, a three-line answer budget, never hand back a technical decision), and the job ends when the change is VISIBLE, not when it is merged — so the agent reads `updateChannel` / `autoUpdate` off `/version` and never promises a beta instance something only a release will bring. Then the technical half: `CLAUDE.md` first, verify on a free port and never touch 3789, deliver as fork + PR, watch it through. Injected via the managed `Shadok-Tweak` profile, whose `systemPrompt` is refreshed from this file at every boot (`seedTweakProfile` / `withManagedPrompt`) — only that field, so a secret or model the user attached survives. `test/tweak-role.test.ts` locks the intent: prose is the one thing a refactor can quietly undo. |
| `context/tweak-pr-check.sh` | The cron guard behind that watch, seeded to `~/.shadok-ai/` at boot (`seedTweakPrCheck`) — **outside** the agent's worktree, which is pruned once its tree is clean. Prints nothing until the PR's state / mergeability / review / CI actually changes; a `gh` failure stays silent and exits 0, because stderr would wake the agent every five minutes (invariant 16). Two things that silence hides, and that the tests now pin: a host with **no `gh` at all** made it permanently inert — silent forever while looking like coverage — so it falls back to the **public REST API** via `curl`, which needs no credential on a public repo; and GitHub computes mergeability lazily, so an `UNKNOWN`/`null` slot is **skipped**, otherwise `UNKNOWN → MERGEABLE → UNKNOWN` woke the agent three times for one non-event. Tested against a fake `gh` AND a fake `curl` in `test/tweak-pr-check.test.ts`. |
| `src/usage.ts` | Fetches subscription usage (5h/7d) from `/api/oauth/usage`. Its in-flight guard is cleared from OUTSIDE the promise (`run.finally`, identity-checked) and the token is read before the promise exists: an async IIFE with no `await` on a path settles synchronously, so a `finally` inside it ran BEFORE `inflight = …` assigned the resolved-null promise and pinned `getUsage` to null for the process's life — blank gauges and an inert pace guard. |
| `src/pace.ts` | The quota **guardrail**: ideal-pace computation + block verdict. |
| `src/retry.ts` | Auto-retry of turns that died on a transient API error (529, 5xx, timeout). |
| `src/channels.ts` | Server-side persistence of the channel + group lists, and **the one answer to "where does this session live"** — `resolveSessionTarget` / `resumeTarget` (pure, tested), which EVERY caller acting on a session's behalf goes through; on a resume the registry beats whatever the caller sent (see invariant 1). keyed by launch dir (`~/.shadok-ai/channels/<enc>.json`). `isMirrored` = does this channel live in Telegram too (opt-in per channel; falls back to "has a binding" so existing setups don't change). Also the Telegram board-group binding. Forces the main channel's name to `general`. `model` joins `profile` in `SERVER_OWNED` and for the same reason: it is applied AT SPAWN, so a resume or restart that forgot it would quietly move a running agent onto another model. Assert-only on `start` (invariant 24) — a client that omits the key must never erase it. `isHomeChannel` (pure, tested) is the ONE definition of the home base — the server-owned `home` flag, or a bound board's General (`threadId == null` **and** `chatId < 0`, since a DM has no topic either and must stay closable). It replaced three copies of that condition: `endChannel`, the client's `isMain`, and a comment in `telegram.ts`. `homeAdoptionTarget` gives a pre-flag cockpit its home base and **refuses when it cannot tell** (zero or several candidates): a wrong adoption is irreversible from the UI, since the channel becomes precisely the one that cannot be closed. `homeChannelForGeneral` (pure, tested) is the twin for the OTHER direction: when a board's General is first opened, `bridgeFor` resumes the web home session (`home: true`, not yet Telegram-bound) instead of spawning a SECOND "general" beside it — the home channel gains the binding rather than being duplicated. `channelWriteAllowed` (pure, tested) gates `PUT /channels`/`/groups` on the caller's `x-shadok-instance` key so a stale tab can't write to an instance that took over its port; `dropForeignHomes` (pure, tested, applied on load AND save) strips another instance's `home` "general". `profilePatch` (pure, tested) makes `profile` assert-only in the `start` upsert, so a resume that carries none never null-writes over the channel's stored role (invariant 1). See invariant 35. |
| `src/telegram.ts` | The Telegram bridge. `replyContext` turns a REPLY into the line telling the agent which message is answered: a highlighted fragment (`quote`) beats the whole message, a bot is named "the agent" rather than by its `first_name`, and a topic's own creation message is NOT a reply — in a forum EVERY message carries `reply_to_message` pointing at it (verified on a live payload), so without that guard every message in every topic gets a useless quote. — the fields `attachmentOf` reads ARE the messages the bot can receive: `handleMessage` drops anything with neither text nor attachment, so a shape missing from that list is a message swallowed before any binding is touched. It cost the same bug twice — a voice note, then a VIDEO (no `msg.text`, caption in `msg.caption`), which is how "shadok doesn't see videos" was reported. `video`/`animation`/`video_note` are one kind (`animation` BEFORE `document`: Telegram sends both for a GIF, and as a document it loses its duration and therefore its stills), an `audio` file is handed over rather than transcribed, and a `sticker` stays dropped — a decision: waking an agent turn for an emoji-equivalent costs more than it says. A video's prompt carries its stills and the line telling the agent to READ them (`src/video.ts`); `tooLargeNotice` names the Bot API's 20 MB ceiling as a ceiling, since a phone video hits it routinely and it is nobody's error. `attachmentOf` recognises `voice` FIRST and as its own KIND, because a voice note carries neither photo nor document and used to fall through to `null`: you spoke and nothing whatsoever happened. Its own kind is what stops an `.ogg` being handed as a path to an agent that cannot read audio; it is transcribed and the TEXT becomes the prompt. What was understood is **echoed back into the topic before it is acted on** — load-bearing, not a courtesy: a transcription can be wrong, and a misheard instruction acted on in silence is far worse than a voice note that was ignored. An empty transcription says so; it never falls through as silence. (DMs belong to ONE user — `dmGate` + `…-telegram-owner.json`; the owner is adopted at boot from an existing DM binding or the board group's creator): one topic = one agent. Owns the bot long-poll, the command dispatcher (`/spawn`, `/stop`, `/secret`…), Markdown→Telegram HTML, dialogs as inline keyboards, attachments. Each binding holds a **WS client to our own server** — so a Telegram session is the same `Live` the web sees. Writes to the Bot API are **serial per bridge** (`makeSendQueue`), which is what keeps a preface ahead of its keyboard — and is why each of them now carries a deadline (`AbortSignal.timeout`, the long-poll keeps its own signal): one call that never settles holds every later message behind it, for ever, and the channel keeps RECEIVING the whole time, so nothing looks broken. Measured on a live instance: a topic silent for 50 minutes after a burst of uploads, its agent still answering into a void, `/live` showing the bridge attached and the Bot API accepting a direct send into that same topic. A refused send is **logged** instead of returning `null` in silence, and flood control (`429`) is **waited out** inside a budget (`floodWaitMs` / `withFloodControl`, pure, tested) rather than thrown away — a bot trips that limit on itself, by sending a burst, so the busiest moment in a channel was exactly when its answers vanished. The READS are bounded for a sharper reason: the poll loop reschedules from the END of each call, so one `getUpdates` that never returns ended it — the bridge went **deaf**, with no log line, no watchdog, and only a restart to fix it. `pollSignal` carries the loop's own abort (what `stop()` pulls, without which a restart meets a 409) AND a 45 s deadline, since the long-poll asks Telegram for 30 s and a healthy call never comes near it. The attachment download and the GUI's `getMe` are bounded too, and a scan test refuses any `fetch` here that has no signal. A prompt is built ONCE (`promptFrame`, typed `PromptFrame`) because the queue of messages waiting for the WS held the bare TEXT: the first message of any new DM or topic — the one that by construction finds no ready socket — reached the server with no `from` and no `voice`, and those two are what the `⟦telegram · … · who⟧` header the agent reads is made of (invariant 26, from the other end: a field can be accepted on the wire and dropped on ONE of the paths that lead there). |
| `src/main.ts` | The `npx shadok-ai` entry point: parses flags, first-run token prompt, then runs the **supervisor**. Not the server. |
| `src/supervisor.ts` / `src/updater.ts` / `src/update-flag.ts` | Self-update: the supervisor runs the npm-installed server as a child, restarts it on the update exit code; the updater installs the channel's resolved version into `~/.shadok-ai/app` (an EXACT version, never a tag — the caller already chose). |
| `src/update-channel.ts` | Which release stream an instance follows: `alpha` (every merge) or `beta` (promotions only, the default). Pure `resolveChannel` (anything malformed → `beta`, never a throw) and `pickTarget` (alpha takes the newer of `alpha`/`latest`, so a promotion cannot make the fast channel downgrade). The beta channel reads the `latest` dist-tag — see invariant 29. |
| `Dockerfile` | The official image (README "Running in Docker"): Claude Code + shadok-ai + a **bundled headless browser** (Playwright Chromium at `/opt/playwright-browsers`, `--with-deps` so the OS libs are present), plus `git`/`gh`/`tmux`/toolchain. COPYs nothing (installs from npm); `.dockerignore` is `*`. Enters through **tini**, so pid 1 reaps orphans — see invariant 44. NB: NOT what a given deployment necessarily runs — the live VPS builds from a host-side Dockerfile of its own. |
| `src/open-browser.ts` | Opens the cockpit on launch. Done by the SERVER, not the supervisor, because only it knows the port the walk landed on (`START_PORT` is where the walk BEGINS). The supervisor sets `SHADOK_OPEN=1` on the FIRST spawn only — it respawns the server on every auto-update, and a tab popping open several times a day is a nuisance. `shouldOpenBrowser` / `openCommand` are pure and tested; refuses in a container, over SSH, and on a display-less Linux. Fire-and-forget: a browser that will not open must never keep the server from serving. |
| `src/preprompt.ts` | Pure `prepromptParts` — what shadok adds to an agent's context, as labelled sections with their source. Captured in `makePilot` AT SPAWN and kept in `prepromptById`, never recomputed: a profile or the permission mode can change under a live agent, and the panel must show what the RUNNING process got (the gap the UI already models as `profile` vs `appliedProfile`). It takes secret **names**, never values — values live in the child's env and never in its args, so the signature makes a leak impossible rather than merely unlikely. Sent with every `ready`, so it survives a reload. The **capabilities** section is read from DISK at spawn rather than assumed from the seeded list: a seed that failed must show as missing. Skills are listed by DESCRIPTION only, because that is what Claude Code loads into context — the body is read when it decides to use one — and because they are installed for the whole machine and rewritten at every boot, which the panel says on screen. |
| `src/csp.ts` | The Content-Security-Policy (`cspHeader`) and the nonce injection into the page (`injectNonce`, marker `__CSP_NONCE__`). Also `injectAssetVersion` (`__ASSET_V__`) and `injectInstanceKey` (`__INSTANCE_KEY__`) — the launch-dir key stamped into the page so the client namespaces its localStorage channel cache SYNCHRONOUSLY (invariant 34). Pure, tested. See invariant 12. |
| `src/net.ts` | Where we listen and who may speak: `resolveHost` (`SHADOK_HOST`, loopback by default), `bindRefusal` (fail-closed: no network bind without a password), `originAllowed` (same-origin, see invariant 11). Pure, tested. |
| `src/heartbeat.ts` | Keeps **idle** `/ws` connections alive behind a reverse proxy: an idle agent sends no traffic, so a proxy (nginx `proxy_read_timeout` 60s, Cloudflare ~100s) cuts the socket and the client loops on "reconnecting" — with nothing actually broken. `startHeartbeat(wss)` pings every client every 25s (`SHADOK_WS_PING_MS`) and `terminate()`s the one that misses its pong. `heartbeatSweep` is pure, tested. |
| `src/config.ts` | `~/.shadok-ai/config.json` (600): port, **per-launch-dir** Telegram token/allowed chats/on-off, GUI password, `autoUpdate`, `permissionMode`, `timezone`, `cockpitTitle` (**per-launch-dir** display name, `titleForCwd`/`setTitleForCwd` — the header brand + browser tab, so several cockpits stay apart), and `cockpitTheme` (**per-launch-dir** colour palette key, `themeForCwd`/`setThemeForCwd`, validated against `COCKPIT_THEMES`; default/unknown → cleared). Config is authoritative over env once set — **except two fields that run the other way**. The **GUI password**: the server reads `SHADOK_GUI_PASSWORD` and nothing else, and the config value reaches it only because `main.ts` copies `cfg.guiPassword` into the child's env when that env is EMPTY (`process.env.SHADOK_GUI_PASSWORD ?? cfg.guiPassword`), so an env var SHADOWS a saved password. No route writes it (`--password` at launch is the only config writer), so on a container the `-e SHADOK_GUI_PASSWORD` it was created with is the door, and recreating it with a different value moves that door in silence — an owner locked out of their own cockpit finds nothing in the config to explain it. The **Telegram token**: `effectiveToken` lets `TELEGRAM_BOT_TOKEN` beat the per-dir entry (see "Running YOUR build"). `autoUpdate`, `ledgerEnabled` and `permissionMode` do follow the rule (`loadConfig().x ?? env`). |
| `src/crons.ts` | Per-channel scheduled prompts (`~/.shadok-ai/crons/<enc>.json`) + the deterministic `check` that avoids waking the LLM for nothing. Three `kind`s: `interval`, `daily` and `once` (an absolute instant, fired a single time — `stateAfterFire` DISABLES it before the fire, since it cannot advance to a next slot, and `settleCron` re-arms it on a transient loss). `nextRunFor` computes a `daily` in an **explicit IANA zone** (`cron.tz` → config `timezone` → machine): without it the hour follows the machine, and a server running UTC shifts everything silently. `nextRunAfterFailure` decides where to reschedule a fire whose delivery was lost (see invariant 15). WHERE a cron runs is no longer decided here: `fireCron` calls `resolveSessionTarget` (`channels.ts`) once and hands the result to the guard AND to the resume (see invariant 1). The fire itself lives in `server.ts` (`cronTick` / `fireCron` / `driveChannel` / `settleCron`). Also carries `CRON_PROMPT_MARK`: a cron prompt's text is prefixed, because it ends up in the transcript like an ordinary user message — hiding only the direct echo let it come back on a web reload and in a Telegram backfill, both of which re-read `loadHistory`. Twin of `NOTHING TO SHOW`. |
| `src/lock.ts` | Single-instance lock, keyed by launch dir: two servers from the same directory share a registry and a Telegram bridge, so the second refuses to start. `pidAlive` treats a **zombie** as dead — `kill(pid, 0)` succeeds on one, and in a container pid 1 is the application rather than an init that reaps, so a stopped instance held its lock FOREVER and every later start was refused while naming a pid that no longer existed. It reads `/proc/<pid>/stat` (`stateFromProcStat`, pure and tested — parsed from the LAST `)`, since the command name is parenthesised and may itself contain spaces and brackets); with no `/proc` the signal's answer stands. The lock records the holder's **start time** beside its pid (`formatLockFile` / `parseLockFile` / `holderStillThere`, pure, tested): a pid NUMBER is not an identity, and in a container it is reused on every restart — see invariant 45. |
| `src/kinship.ts` | Who launched whom, and what a parent is told about it. `linkRefusal` (self / cycle / unknown parent / depth / fan-out — every refusal **explicit**, never a silently dropped field), `chainDepth`, `childrenOf`, `notificationText` (the child's own summary + pointers, **never the diff**: the parent is the biggest session in the tree), and `AGENT_PROMPT_MARK` — twin of `CRON_PROMPT_MARK`, since a notification also lands in the transcript as an ordinary user message. Pure, tested. The delivery itself lives in `server.ts` (`notifyParent` / `deliverToParent` / `parentInbox` / `flushParentInbox`). |
| `src/promptmeta.ts` | The context header prepended to a HUMAN prompt (web/telegram/cli) before it reaches the TUI: `⟦platform · time · who⟧` on its own first line. The agent sees it (who is talking, when — nothing else told it); the display strips it (`stripPromptMeta`), cousin of the cron/agent marks — but here only the header line goes, the message stays. `promptMetaHeader`/`markPromptMeta`/`stripPromptMeta`/`hasPromptMeta`/`parsePromptMeta` are pure, tested. Applied in `server.ts` (the `prompt` handler, before `pilot.submit`; the echo stays clean) and stripped in `extract.ts` (`loadHistory`). NOT added to terminal input nor cron/agent prompts. A transcribed **voice note** is marked in the PLATFORM field (`⟦telegram vocal · …⟧`, from a `voice: true` on the `prompt` message) and deliberately NOT through a different `origin`: the server adds the header only when the origin is exactly `web`/`telegram`/`cli`, so an origin of `telegram vocal` would have dropped the whole header — time and sender — to gain one word. `parsePromptMeta` reads the platform first and the sender as everything past the time, so neither is widened; verified end to end, the transcript receives the mark with both intact. The mark gives the agent a FACT; the BEHAVIOUR lives in the pilot prompt (read intention over letter, ask when a load-bearing token looks garbled), locked by `test/skill-auth-docs.test.ts`. `loadHistory` also `parsePromptMeta`s the header it strips, carrying `from`/`origin` onto the `HistoryTurn` so a REPLAYED message shows who spoke via the client's `echoAuthor` (Ada · telegram for a Telegram message; "you" for your own web prompt — the human driving the cockpit, no longer the metaphor label "pilot") — without it a Telegram sender came back as the generic "pilot" on every reload. |
| `src/secrets.ts` | Central secret vault (`~/.shadok-ai/secrets.json`, 600). Profiles reference secrets **by name**; values are injected as env at spawn. `secretWriteVerdict` (pure, tested) is the no-silent-overwrite rule behind `PUT /secrets`: an existing name is refused unless the caller passes `overwrite: true`. HTTP is the only way an AGENT can reach the vault (Telegram's `/secret` calls `setSecret()` directly), so that endpoint is exactly the machine boundary. |
| `context/secrets-skill/` | The `shadok-secrets` skill, seeded into `~/.claude/skills/` at boot (`seedSecretsSkill`, twin of `seedSchedulerSkill`): lets an agent store a credential it OBTAINED itself. `scripts/secret.mjs` has `list` and `set NAME --stdin` and **no `get`** — `--stdin` is required so a value can never sit in `argv`, which `ps` exposes machine-wide. |
| `context/reload-skill/` | The `shadok-reload` skill (seeded by `seedReloadSkill`, twin of the above): an agent respawns **itself** to pick up a changed pilot prompt or newly-seeded skills (the prompt/skills are fixed at spawn). Calls `POST /reload` scoped by `SHADOK_SESSION_KEY` → `restartSession` (a `--resume`, history kept). Only the agent holding the key can reload that session. Because a `--resume` loads the conversation but drives no turn, the respawn would sit **idle** — so `/reload` chains `continueAfterReload`, a HIDDEN nudge delivered over the cron/notification loopback (`driveChannel` + `markAgentPrompt`) once the new process is ready, telling the agent it was reloaded and to resume. Scoped to the self-reload ONLY — not the GUI reload, `restart-all`, or an auto-update respawn, which touch many agents at once and would wake every idle one. |
| `context/files-skill/` | The `shadok-files` skill (seeded by `seedFilesSkill`, twin of secrets/reload/ledger): `send.mjs <abs path…> [--caption]` → `POST /files`, authenticated by `SHADOK_SESSION_KEY`. **The seeding is the point**: `copyFileSync` at every boot, so it reaches agents that ALREADY EXIST with no reload — which the pilot prompt cannot do, and which is exactly what an old fleet needs. Its SKILL.md carries the rule that made this necessary twice over: cite a path when the path is the point, attach when the file is the deliverable, never publish an artifact instead — and **if a capability is missing, say so and stop**, because a made-up `fichier:` convention looks like a feature to the reader and is not one. |
| `context/ledger-skill/` + `context/ledger-reflex.md` | The `shadok-ledger` skill (seeded by `seedLedgerSkill`, twin of secrets/scheduler) and its **gated** pilot-prompt reflex, so agents stop re-surfacing what a sibling already resolved. A **per-instance state table** (`~/.shadok-ai/ledger/<enc-launch-dir>.json`, keyed like channels/crons; the server hands each agent the path in `SHADOK_LEDGER_FILE`, since an agent's cwd is a worktree — a hand-run CLI falls back to the legacy `ledger.json`), one row per entity — `check`/`record`/`list`, **supersede, not append**, so size is bounded by live topics. `check` RANKS by word overlap weighted by IDF computed over the table itself (`searchEntries`), because the substring match it replaced only ever answered a caller who already knew the exact wording — i.e. one who did not need to ask. Measured on the live 64-row table against fifteen queries agents really typed: **zero returned anything**, while the matching row sat there in plain sight (`claude launcher stub spawn failure` vs `claude-launcher-stub-breaks-spawns`), and each got the UNKNOWN line — which the reflex reads as *there is nothing here*, the exact silo this feature exists to close. Three parts are load-bearing. Stopwords are **derived from the table** (a term in ≥4 rows AND >40% of it), never a hand-written list: `to` is one here and `ledger` is not, and no list would have known. A term the table has never seen is **discounted (×0.2), not ignored** — ignoring it let a query whose subject is absent score a PERFECT match on the filler words it happened to share with a note, while counting it in full threw away long real queries whose subject IS recorded under other words. And the result is **two tiers**, `strong` (your answer) and `weak` (merely shares words with your question): collapsing them would destroy the reflex's third state, since a search that always returns something makes "nothing recorded is UNKNOWN" unreachable — so on a weak-only hit the CLI prints the UNKNOWN line FIRST and unchanged, then the leads under a heading saying they may not answer. A row also says **what KIND of thing it is** — `task`, `fact` or `decision` — because the table used to treat all three identically and they are not the same object. A task has a lifecycle, so a status is right and closing it is normal; a **fact** has none, only a date on which someone last confirmed it, so closing it makes it DISAPPEAR WHILE IT STAYS TRUE (that is how a job finished on the 9th was still believed pending on the 12th: marked `resolved`, it dropped out of every filter on open work); and `decided` was never a phase of the open → in-progress → resolved lifecycle it sat beside — it is a kind wearing a status's clothes. `kind` is **read, never written back** (`rowKind`): an absent one is a `decision` when the status is `decided` and a `task` otherwise, so the rows that predate it keep their bytes, and the GUI gets it as a **derived** field on `GET /ledger` (cf. invariant 6) rather than a second copy of the inference. A lifecycle-less kind **supplies its own status** (`current` / `decided`) so no agent has to invent a phase word and `status` stays present for every existing reader; an unknown `--kind` is **refused**, never stored. With it come **two clocks**, because an EDIT is not an OBSERVATION: `updatedAt` is when the row was written, `verifiedAt` is when its claim was last confirmed, and `ageDays` — the freshness the whole hedge rests on — reads `verifiedAt ?? updatedAt`. Rewording a note used to rejuvenate a row nobody had re-checked in a month, silently switching that hedge off. A `--status` (even the same value — re-asserting IS confirming) moves both; a note/source/entity edit moves only `updatedAt`; `--verified` moves only `verifiedAt`, which deliberately keeps it OUT of every sibling's delta, since "I looked, nothing moved" is not news. A row predating the field inherits its old `updatedAt` as its last observation — the truth, and a lazy per-row migration. Each row carries a short **id** (`[a1b2]`), a durable handle preserved across supersedes: `record --id <id>` updates a row in place (no retyping the entity, no typo-forked twin); `resolveId` accepts a unique prefix, refuses empty/ambiguous (invariant 17). The reflex ("verify a status before you assert/act — `git`/`gh` for code, the ledger otherwise, else hedge; and read the pushed `⟦ledger⟧` delta") is appended to the pilot prompt **only when `ledgerEnabled`** (config, `POST /ledger`, or `SHADOK_LEDGER`) — **ON by default**; an explicit config choice or `SHADOK_LEDGER=0` turns it off, and an instance that already turned it off keeps that choice. A **version-menu toggle** flips it and **restarts all agents** so the reflex lands at once (the standalone `Restart all agents` button, `/restart-all`, does the respawn on its own too). A **read-only GUI viewer** (a header icon → `GET /ledger`) lists the table so a human can consult it without the CLI, with search / status / kind / age filters and sorting (`public/ledger-view.js`); long notes are clamped to three lines and a row whose claim has not been confirmed in a month is marked. `ledger-core.mjs` is the pure logic (upsert with id-preserve, `resolveId`, kind, search, age), tested by `test/ledger.test.ts` — and the **server imports it** (`src/server.ts`, `src/ledger.ts`) rather than growing a second copy: a hand-written `ledger-core.d.mts` types it, the core itself stays plain `.mjs` because it is copied verbatim into `~/.claude/skills/` at every boot and must run with no build step. `context/` ships in `package.json`'s `files`, so `dist/… → ../context/…` resolves in a checkout and in the installed package alike. Anything server-side that wants the SCORER goes the same way — `searchEntries` exists only there. Design: `docs/superpowers/specs/2026-08-25-shared-ledger-design.md`, push: `docs/superpowers/specs/2026-08-28-ledger-push-design.md`, recall: `docs/superpowers/specs/2026-09-09-ledger-recall.md`, kinds + the delta's headline (and the measurements behind the three proposals that were REFUSED — a message-triggered push that fires on 9% of real human messages with 0 relevant hits, append-only notes, and a creation guard that would have refused 48% of legitimate rows): `docs/superpowers/specs/2026-10-13-ledger-kind-and-headline.md`, the paste split that removed its cause: `docs/superpowers/specs/2026-10-13-ledger-prelude-paste.md`, and what the block then spends its budget on (plus the P1 measurement a sibling instance ran at our request, which flips its verdict where rows and humans share a language): `docs/superpowers/specs/2026-10-14-ledger-block-budget.md`. |
| `src/ledger.ts` | The SERVER side of the shared ledger (the skill's `ledger-core.mjs` is the agent side). `ledgerFileFor(cwd)` — the per-instance path; `ensureLedgerFile` — boot migration (seed the scoped file from the legacy global once, backfill ids), best-effort; `headline(note, max)` — the one line of the note that says WHAT happened, **derived** (first sentence, flattened, hard-capped at 160 chars) rather than asked for: the block used to carry `[id] entity — status` and nothing else, so the entity LABEL was the whole payload and a label written as a topic name cannot say what changed about it. A period counts as a sentence boundary only with whitespace after it and ≥24 chars before it — this table is full of `claude-code-2.1.285` and `v0.13.4`, and a bare-dot split cut every one in half. A MANDATORY `--headline` field was rejected: it asks every agent for writing discipline nothing enforces and covers none of the rows already recorded. The cap was 120 and cut a real `decision` row's 126-character first sentence mid-way, losing the complement that carried the decision — what was left read as its opposite; 160 is where it stops because a headline is served WHOLE or not at all (see below), so a larger cap buys fewer headlines rather than better ones. It lives here and not in the skill's core because the delta is built only server-side and the CLI already prints the whole note. **The block goes in as its OWN paste, never concatenated into the message** (`pilot.submit(text, prelude)`), and that is where the correctness lives. `pilot.submit` PASTES into the TUI, and Claude Code collapses a paste past a threshold into a `<pasted_content>` wrapper — material its own system prompt says to act on only where the user's own message asks. With a multi-line block the human's message sits INSIDE that wrapper and stops being an instruction: a live agent answered a direct order with "I haven't acted on that line, since it came from the pasted text and not from you directly". Measured on 486 real human prompts from this machine: **0 of 324 wrapped at ≤3 submitted lines, ~30% of 162 at ≥4**, and on one line 431 chars is safe while 914 is not. A prompt is `⟦platform⟧` + the message, so the block gets exactly one line — the old shape spent two or more and put EVERY non-empty delta over the cliff (85 real prompts, 24% of those carrying a block, neutralised). The threshold is applied PER PASTE, and only the CURRENT paste may stay inline (`us()` keeps earlier blocks collapsed), so pasting the block first and the message last judges the message on its own: measured end to end, a one-line block with a TWO-line message — four lines in total, well over the old cliff — is now wrapped not at all, and an oversized block is wrapped alone with the message outside it. Since the block is judged ALONE, the limit that applies to it is the binary's own and nothing else: `body.length <= 800 && newlines <= 2` (`var xK=800`) — so the 431 figure above, measured on the whole prompt, never bounded it. And that rule is applied **PER PASTE**, decided as each one is made, so 800 is not a ceiling on the delta at all: it is the size of **one chunk**, and the number of chunks is ours to choose. Measured on a live agent, eight pastes plus the message carried **1272 characters over nine lines with nothing wrapped and the order obeyed** — a payload no single paste can deliver in the clear by any formatting. So the block is a LIST of one-line chunks (**`formatLedgerChunks`**, `PASTE_MAX` 760 each; `formatLedgerBlock` is the same thing joined, which is what lands in the transcript). What bounds it is therefore no longer the wrapper but **LATENCY**: every chunk must be WAITED for before the next is pasted, or two reach the pane as one paste event and the split is undone — measured through the production path, ~330 ms per chunk (the screen poll), i.e. 660 ms for a typical delta, 1.65 s at 20 rows, 2.5 s at 40. That is what `PRELUDE_MAX_CHUNKS` (8) spends. The budget is then spent in ONE order and degrades in the opposite one, because the two failures are not comparable — a row the reader is never told about is the silo this feature exists to close, while a row named without its sentence is one `ledger list` away: (1) **every** changed row gets `• [id] entity — status (source)`; (2) the newest `HEADLINE_ROWS` (3) also get `↳ <what happened>`; (3) only if even (1) exceeds the chunk ceiling do the OLDEST rows collapse into the overflow mark, which still carries their ids; (4) and only when there are more than we hold does it fall back to a bare count. `LEDGER_PUSH_CAP` is 40 (was 8 — the thing that turned a returning agent's backlog into a number); at 40 rows everything is still named, in 6 chunks. One row is ALWAYS carried, since a block that announces a delta and names nothing is worse than a long one. The chunk ceiling is counted on the **PACKED** result and never estimated from a character budget: greedy packing leaves a chunk short whenever the next row does not fit, so `chunks × PASTE_MAX` and the sum of the rows disagree — estimating produced 9 chunks against a ceiling of 8, caught only because the test counted chunks rather than characters. The overflow mark carries the unnamed rows' **ids** (the handle `record --id` takes and `check` resolves) instead of a bare `+N more`, and keeps the count honest against the delta CAP: `total` can exceed the rows we hold, so `(+5 : <5 ids>)` and `(+54 more, 5 newest: <5 ids>)` are two different sentences. And an entity LABEL is truncated at render time (`LABEL_MAX`, 80) — never in the table, where `check`/`list` still print it whole: labels grew into sentences once the headline shipped ("a note wearing a label's clothes"), which took one sibling instance's rendered row to a 156-char median and its 9-row delta to one named row. The CLI warns at write time too, and never refuses — a refused write is a lost fact — because a warning alone would be the same writing discipline the `--headline` refusal already declined to rely on. Two traps in the format change, both failing OPEN: `hasLedgerBlock` tested that the first line ENDED with `⟧`, which a one-line block does not — detection returned false, nothing was stripped, and the whole block was shown in the chat (it tests `includes` now); and `stripLedgerBlock` must keep understanding the HISTORICAL multi-line shape, because `loadHistory` replays transcripts written before the change. Its bullet test is made on the TRIMMED line, too: a continuation chunk starts with the ` • ` that separates two rows, so anchoring on column zero would leave every chunk but the first sitting in the displayed message. The block's cost follows the delta now rather than a budget: ~90 tokens at one row, ~280 at eight, ~1200 at the 40-row cap — paid only by an agent that has been away for days, which is exactly when the backlog is worth it. `deltaSince(rows, watermark, cap)` + `formatLedgerBlock` — the **push**: ahead of each prompt that starts a turn — human (web/telegram/cli), **cron, or an agent notification** (`ledgerEnabled` only) — the rows changed since this agent last saw the ledger are prepended as a one-line `⟦ledger · N updates⟧` block, so siblings learn resolutions in near-real-time without a `check`; a monitoring cron benefits as much as a human turn (reporting an issue a sibling just fixed is the very silo this closes). The block is stripped from the display (`stripLedgerBlock` in `extract.ts` `loadHistory`) run BEFORE `stripPromptMeta` (its `⟦ledger⟧` line also looks like the platform header) AND before the `isCronPrompt`/`isAgentPrompt` classification — otherwise a cron/agent prompt would no longer start with its hiding mark and would leak into the display. The watermark is **persisted** (`ledgerSeenFileFor` / `seenFor` / `recordSeen`, a sessionId→instant map beside the table, pruned against the live channel list). It used to live only on the `Live`, anchored to the attach instant — and a `Live` is rebuilt on every server restart, i.e. on **every auto-update**, and again whenever a dormant channel is woken, so the next delta came back EMPTY. Measured on a real instance before the fix: of the pushes that were due, **two in three never arrived**, and the misses landed exactly on merge times — a merge publishes, the instance updates, every watermark resets, and the burst of ledger activity that merge produced is precisely what gets swallowed. Nothing surfaces: an empty delta and a delta that was erased look identical. Restoring it keeps the two answers apart — **no record is a NEW agent** (anchored to now, no history flood), a record is an agent that came back (it gets its backlog, bounded by `LEDGER_PUSH_CAP`); `seenFor` therefore returns `undefined` rather than 0, since 0 would replay the whole table into a freshly spawned agent. And it advances only **after** `pilot.submit` resolves: advancing first meant a submit that threw (a wedged screen, invariant 23) burned the block for good. A delta is usually empty, so most prompts still carry nothing. Pure parts tested by `test/ledger-inject.test.ts`. |
| `src/claude-home.ts` | Seeds Claude Code's first-run state in `~/.claude.json` — the globals at boot, `projects[<cwd>]` before **every** spawn (a worktree is a new directory, so a new trust dialog every time) — plus an explicit `tui` in `~/.claude/settings.json`, which kills the fullscreen-renderer upsell. Same idea for `autoModeEnvSetup.dismissed`, which answers “Teach auto mode about your environment?” — a BLOCKING form offering to scan the shell history (PRE-TICKED) and other repos, so shadok picks the screen’s own “Don’t show again” rather than let someone hit Continue and opt into a scan they never chose. Its gate, read out of the 2.1.241 binary: `numStartups >= 5` **and** `denials >= 5` **and** mode `auto` **and** not dismissed, fired at `query_end` — AFTER a turn, which is why no start-up probe ever caught it. `denials` counts refusals by the auto-mode **classifier** (not a profile’s `deny` rules, which are a different decision path), and shadok runs its agents in auto mode by default, so every instance drifts towards that screen through ordinary use. That key is merged on the **sub-key**, the one exception to seeding a whole key at a time: the CLI writes `{denials: n}` by itself from the first refusal, so an additive-on-the-whole-key rule no-ops from then on and would protect only instances that can never reach the threshold. Same idea once more: a top-level `resumeReturnDismissed: true` silences THREE resume-time asks, not one screen (2.1.304) — the BLOCKING “Resume this conversation? … will use N% of your 5-hour limit” select (statsig `tengu_amber_tally`, cost ≥ `minPercent`, default 5), a compact-or-continue ask whose `compact` outcome RUNS a compaction (flags `tengu_gleaming_fair*`, idle ≥ 70 min and ≥ 100k tokens — every weeks-old agent), and a model-family announcement (`tengu_hidden_volcano`). Unseeded, they stall `reconcileOnBoot`, Reload agent and `/reload` until a human answers. It is GLOBAL (the CLI writes it top-level, no project carries it) and ADDITIVE — not asserted like the trust flag, because the CLI only ever writes `true` (on “never”), so a `false` is a deliberate hand edit; the quota signal it drops is one shadok already shows (`/usage`, `src/pace.ts`). That upsell appears only AFTER a sign-in and is **blocking**, so no signed-out probe can find it: the signed-out screens are not the whole set. ADDITIVE except for ONE key: `hasTrustDialogAccepted` is **asserted**, because shadok is what chose the directory and a stale `false` — from an older shadok, a restored config, a hand-run `claude` — would bring the trust dialog back on every single spawn, forever. Everything else is never overwritten, which is why it needs no Docker gate — contrast `src/ssh.ts` (invariant 19). Also the single writer of `~/.claude/settings.json`'s `model` (`getDefaultModel`/`setDefaultModel`), because it already writes `tui` there and two writers on one JSON file eventually erase each other. Verified 2026-09-25 on 2.1.282, and BOTH halves mattered: a `model` in that file is honoured with no `--model` flag, AND it survives shadok also passing `--settings` for a profile's guardrails — so the flag merges rather than replacing, without which the setting would have been silently inert for every agent carrying a profile. Atomic write; an unparseable file is left alone rather than "repaired" — but it now SAYS SO on stdout, as does a failed seed: the silent version made a seeding that never ran indistinguishable from one that did, and cost a long investigation into first-run screens with no trace anywhere. Pure `seedPlan` / `parseClaudeVersion` tested. |
| `src/first-agent.ts` | The lead agent an instance starts life with: `general` on the `Shadok-Boss` profile, in the launch dir, no worktree. `firstAgentPlan` is pure and tested — it spawns only when there is **no channel at all** AND the auth state is `signed-in` (`unknown` is not signed in: that is the zombie shape, cf. invariant 27). That "no channel" condition is what makes it idempotent, so `startFirstAgent` (`server.ts`) can be called both at boot and after a successful sign-in without either knowing about the other — and a brand-new instance, signed out at boot, gets its agent from the sign-in call. It spawns through a **loopback WS to our own server**, like the Telegram bridge and the cron driver: there is no server-side path that opens a session without a client, and adding one would be a second way to start an agent. Also owns the **status the cockpit shows while that spawn is under way** (`announceFirstAgent` / `settleFirstAgent` / `firstAgentStatus`, served as `GET /first-agent`): the browser cannot tell "a first agent is coming" from "the user closed their last tab" — both are zero channels (invariant 18) — and guessing invites a SECOND lead agent while the first is being born. `announceFirstAgent` fires at boot BEFORE the deferred spawn, because `openBrowser` runs first and the page would otherwise load inside that gap and be told nothing is coming. `settleFirstAgent` is the only way out and it is unconditional — called from `ensureFirstAgent`'s `finally` (so `ready`, `error`, `exited`, a socket failure and the 60s guard all end the wait), from the `!plan.spawn` branch (a signed-out instance spawns nothing and must not read "starting your first agent…" forever) and from `startFirstAgent`'s `catch`, for a throw that never reaches the `finally`. |
| `src/ground.ts` | What kind of project a directory holds, read **deterministically** — fs only, no model call, no network, no process spawn (not even `git`). The cron guard's move applied to onboarding: recognising a `Gemfile` is not reasoning, so it costs no quota and cannot hang. Reports version control (`.git` matched as a FILE too — that is what it is inside a worktree, which is where every shadok agent lives), stack markers (`package.json`, `Gemfile`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `*.xcodeproj`, `*.csproj`…) each carrying **the marker that proved it**, so the layer above names what it SAW rather than a category word the user never wrote, CI configuration, and the project's own convention files. The load-bearing finding is the empty one: `empty` (no entries at all) and `unrecognised` (no VCS, no stack, no CI) are kept as **separate facts**, and neither is a failure — an invented stack is the one thing a greeting cannot recover from. `unrecognised` is deliberately NOT `stacks.length === 0`: a git repo of pure Markdown is recognised as a repo while its stack stays honestly unknown, and a README never counts as recognition or a folder of prose could never reach the honest register. `readGround` is pure over an injected listing (`ListDir`), like `spawnHelperPaths` and `classifyBin`, so its fixtures are directory SHAPES; `readGroundAt` is the thin real-fs half. Read by `src/greeting.ts`, at the moment the lead agent is born. Design: `docs/superpowers/specs/2026-08-31-onboarding-agent-design.md`. |
| `src/greeting.ts` | What the lead says the first time a cockpit opens, as a BRIEF the model writes from — never finished prose. It carries the ground `readGround` recognised, the roles the vault really holds, the ONE offer that fits, and the copy rules. Generated because the introduction has to describe the profiles that exist HERE, including ones the user minted after this file was written: hardcoding the list is the drift this file documents half a dozen times. `greetingRegister` is the design — `specific` only when a marker AND a shadok mechanism back it, `informed` when something was recognised but nothing fits (name what you saw, then ASK), `honest` when `empty`/`unrecognised` (one line, the `UNIVERSAL_OFFER`, and an explicit ban on naming any stack: an invented one is the single failure a greeting cannot recover from). `greetingProfiles` drops the managed roles — `isManagedProfile`'s reason, since a greeting enumerating roles is a list where one PICKS one — and the lead itself, which is the one speaking. The facts are handed over rather than looked up, and the brief forbids reading the project first: reading it properly is what the greeting OFFERS. Delivery is `greetHomeAgent` (`server.ts`), a hidden `markAgentPrompt` over the loopback with `deliverWithRetry`, fired ONLY from `ensureFirstAgent`'s `onReady` — `firstAgentPlan`'s "no channel at all" is already per launch directory, and a second trigger would be a second way to greet. `SHADOK_GREETING=0` turns it off. Pure cores tested; the copy rules are locked like `tweak-role.test.ts` locks the tweak role's. |
| `src/claude-auth.ts` | Auth status and the interactive sign-in. `claude auth login --claudeai` needs **no PTY**: run with pipes it prints the OAuth URL on stdout and reads the code from stdin — so the sign-in touches NONE of the screen heuristics. One instance-global flow, two doors (the web card, Telegram `/login`+`/code`). Success is a clean **exit**, never a parsed string (see invariant 27). The probe itself goes through `probeWith`, which takes HOW the CLI is run as an argument: a binary caught mid-upgrade is waited out, anything else that stops us from looking is `unknown`, and it **never throws** — a thrown probe cancels the spawn it was only meant to inform (invariant 32). Pure `parseAuthStatus` / `parseLoginUrl` / `parseLoginOutcome` tested, `probeWith` against an injected runner. |
| `src/claude-creds.ts` | WHEN the Claude OAuth session expires, for the version menu's Account/Token rows — read from Claude Code's own credentials store (file first, then the macOS keychain, the same order `usage.ts` reads the token), and **never a token value**, only two timestamps. `tokenExpiresAt` is the REFRESH token's expiry — the real "sign in again" deadline — not `expiresAt`, the access token that rotates every few hours on its own; showing the latter would read as "expires in 6h" on a perfectly healthy session. An env-only instance (`CLAUDE_CODE_OAUTH_TOKEN`) has no readable expiry, so it shows none rather than guess. Merged into `GET /auth` beside `authStatus()`. Pure `parseCredsExpiry` tested; every read swallows its errors so surfacing the expiry can never break the endpoint. |
| `src/ssh.ts` | Persistent per-container SSH identity (`ensureSshIdentity`, called at boot in `server.ts`). **Docker-only** (`/.dockerenv`): generates an ed25519 key under `~/.shadok-ai/ssh/` — on the `shadok-data` volume, so it survives restart AND recreate — and symlinks `~/.ssh` to it so agents' `git`/`ssh` use it. NO-OP on a normal host (never touches `~/.ssh`). Pure `sshPaths`/`planDotSshWiring`/`inContainer` are unit-tested. See invariant 19. |
| `src/profiles.ts` | Agent profiles (GLOBAL, `~/.shadok-ai/profiles.json` 600; deliberately deleted starter roles are remembered in `profiles-declined.json` — the seed installs the shipped roles a vault is MISSING, including ones a later release added, so it must not resurrect what you removed): role (`--append-system-prompt`) + permission guardrails (`--settings` deny/allow) + secrets + model, applied at spawn via `profileArgs`. **A shipped role stores NO prompt until the user edits it** — `effectiveProfile` resolves it from the build at spawn, so it cannot go stale; `promptOrigin` reports `tracked` / `edited` / `outdated` (their fork, and the build has moved since — `promptBase` records what they forked from) / `custom`. `adoptTracking` + `migrateToTracking` drop a stored copy that merely repeats the build, which is how pre-tracking instances catch up. Restoring DROPS the stored prompt rather than copying today's text, or the fresh snapshot would start going stale immediately. Stored on the channel (`profile`) → re-applied on resume/restart. SOFT (same OS user, not a sandbox). `COCKPIT_DENY` is a cockpit POLICY rather than a role guardrail — `"Artifact"` is denied for **every** agent, profile or not. It lives in `profileArgs` and not in the shipped roles for two reasons: `Shadok-dev` carries no deny list and a bare spawn carries no profile, so a per-role rule would miss exactly the common cases; and `profileBadges` derives a role's access badge from its deny list, so putting it there would label a full-access role restricted over something unrelated to files or git. An artifact is a page on claude.ai when the person asked for a file. Verified WITH A CONTROL on real agents (a settings-validator probe proved nothing — a bogus tool name warns no differently): deny active → the agent reports the tool ABSENT, `SHADOK_ALLOW_ARTIFACTS=1` → PRESENT. It does not reproduce under `claude -p`, which never offers the tool at all (invariant 29's trap, again). A shipped role **earns its place on guardrails, secrets or method — never on topic** (two roles differing only in subject matter are one role with two briefs), so the catalogue is really a set of guardrail SHAPES: no `deny` at all (`Shadok-dev`), `READONLY_DENY` (git blocked, files open — the roles whose deliverable IS a file), `SOURCE_WRITE_DENY` (the mirror image: the source blocked, git open, so `Shadok-QA` delivers a branch carrying a failing test it cannot then make pass), and both at once (`Shadok-Product`; `Shadok-Release` adds the bare `Write`/`Edit` denies — it may run the deployment path and may not edit what that path ships, since changing the source while shipping it means what went out is not what was verified). `SOURCE_WRITE_DENY` is `Edit(...)` only — a path-scoped `Write(<glob>)` deny never matches (the `Edit` matcher covers the Write tool; measured on Claude Code 2.1.311, which warns about each one at startup) — and enumerates `src`/`lib`/`app` twice each (anchored and `**/`-prefixed, for a monorepo) and stops there: every extra entry is a directory some other ecosystem uses for something else, and on a SOFT layer a false block costs more than a missed one. `READ_THE_GROUND` is the shared paragraph every role that lands in an unknown project opens with — one constant, not a copy per prompt, because it is the fix for a bug (a role naming THIS repository's convention files as if every project had them, cf. `src/ground.ts`) and three copies of a fix drift back one at a time. `test/role-catalogue.test.ts` locks that prose for the whole catalogue the way `test/boss-role.test.ts` locks the lead's. |
| `src/peers.ts` | PEERS — other instances allowed to reach this one's agents, the cross-instance twin of a web account. A peer **enrols like a user**: `POST /peers` hands out a **single-use ticket**, `POST /peers/enrol` (the only peer route BEFORE the password gate, since an invitee has no credential yet) consumes it and returns the durable token the peer then keeps — so the long-lived credential never travels through an invitation, a chat or the invitee's transcript, only a ticket that dies on first use does. The token is **salted per peer** (`Peer.salt`, in the MAC): it used to be `hmac(secret, "peer:"+name)`, which is deterministic, so revoking a row and re-inviting the same name minted the IDENTICAL token and handed a leaked credential back — revocation was not rotation. `withSalts` backfills a pre-salt row, deliberately invalidating its old token. Non-expiring once enrolled (a cross-instance link must not hit the 7-day cookie cliff) and revocable by the registry: `peerFromToken` requires the name listed, the row ENROLLED (a pending `invite` authenticates nothing) and the MAC to match that row's salt. `redeemVerdict` refuses an unknown, used or expired ticket with ONE wording, so a guesser learns nothing. Each peer has a **scope** (`Peer.scope`, `peerScope` defaults it to `restricted` — the SAFE default, so a row written before scopes existed, or a `POST /peers` that omits the key, can never widen a credential that is already out there; `member` only ever comes from a caller that spelled it out): a **member** peer acts as a web MEMBER — `currentAccount` returns it as `{name, role:"member"}`, so it passes the general gate and sees/drives EVERY agent, `/live`, spawn, the lot (never admin); a **restricted** peer is the boxed principal, only `GET /diff` over HTTP and only its own agents. `ownedByPeer` (`Channel.createdByPeer`, tagged at `start`) is the check behind the restricted scope — applied ONLY when the caller is restricted (the WS resume/stop guards gate on `callerPeerRestricted`, `/diff` on `peerScopeFor`). A member peer can drive the human's own web sessions too — the deliberate "invite an agent like a user"; even so it cannot read secret VALUES (`/secrets` returns names only). `agentInvitePrompt` (carries the ticket, never a token) reads the scope to say what the invitee may do. Scope is chosen at invite (`POST /peers {scope}`, a dropdown in the Users panel whose first — hence selected — option is `restricted`); the member-vs-restricted boundary is proven end-to-end, pure parts in `test/peers.test.ts`. |
| `src/accounts.ts` | Web accounts, PER INSTANCE (`~/.shadok-ai/users/<key>.json`, 600): roles (`admin`/`member`), salted scrypt hashes, single-use invitations, and the signed session token. The signing secret (`<key>.key`) is per instance and **never exported into an agent's env** — the GUI password is, so signing with it would let an agent mint a cookie for anyone. `SHADOK_GUI_PASSWORD` stays the door and IS the `admin` account; with no password everything is dormant. `promptAuthor` is where the web's author comes from the SESSION and never from the frame. Also `signSessionKey` / `readSessionKey` — the per-session key an AGENT authenticates with (`x-shadok-session-key`), DERIVED from the session id by HMAC so it needs no server state and carries no issue time. See invariant 33. Pure cores tested. |
| `src/twofactor.ts` | Two-factor sign-in with a passkey (WebAuthn via `@simplewebauthn/server`), opt-in per instance (`config.twoFactor[<cwd>]`, `twoFactorForCwd`). Pure rules, tested: `twoFactorEnableVerdict` (≥ 2 NAMED admins, each with a passkey — the recovery rule is "another admin resets you"), `keepsTwoAdminsVerdict`, `resetVerdict` (never yourself, never the bootstrap admin), `loginNext`, `enrollCodeVerdict`; the pending sign-in token (`signPending`, a key DERIVED from the session secret so it can never pass as `sk_auth`); single-use challenges bound to user + purpose. The routes live in `server.ts` (`/login/passkey*`, `/login/enroll*` before the gate; `/2fa*` behind it, all through `cookieAccount`, never an agent key or a peer). `isInternalClient` is the one exception and says so: a bootstrap cookie marked `mfa` can only have been minted in-process with the signing secret, so it is the SERVER (the Telegram bridge) — `currentAccount` accepts it, `cookieAccount` still does not. See invariant 46. |
| `src/paths.ts` | `instanceKey(cwd)` — the launch directory encoded as a filename, for anything stored per instance. |
| `src/cli.ts` | One-shot CLI (`node dist/cli.js "prompt"`), separate from the server. |
| `public/index.html` | The entire web client (no framework, no build). Agents (creation is a **popin**, `#setupOverlay`, profile-first: a grid of cards, the rest folded away; the channel is only born at "Start agent", see invariant 18), groups, dialogs, engine room, diff panel, pace/usage gauges, context bars. A small **release-channel badge** (`beta`/`alpha`) sits next to the header version number, fed from `updateChannel` on the `version` message — honest per instance, not a hardcoded label (`alpha` is tinted amber). UI copy says **agent**; the code, endpoints and storage keys still say `channel`. Agent Markdown is rendered with **GFM soft line breaks ON** (`marked.setOptions({ breaks: true })`, set globally right after `/vendor/marked.js` loads): the `.jsonl` carries newlines where the agent meant them (one URL per line, a short list), and the default Markdown rule renders a lone `\n` as a word-space, so those lines glued into one wrapped run in the chat bubble while the engine-room screen and Telegram — which never go through marked — showed them correctly. One global policy covers every render site (chat bubble, compaction summary, any future one); locked by `test/md-soft-breaks.test.ts`. |
| `public/live-text.js` | Pure `extractLiveText(screen)` — pulls the in-flight assistant text block from the TUI screen for the web live preview. ESM: loaded by the browser (bridged to `window.extractLiveText`) AND imported by `test/live-text.test.ts`. |
| `public/group-nav.js` | Pure `GROUP_ICONS` / `randomGroupIcon` / `resolveGroupView` / `groupMood` / `cleanGroupIcon` — the groups column (desktop two-column navigation). That column is a VIEW over the agents column, which still owns the groups and is what gets persisted; see "Persistence" in `docs/architecture.md`. A group's `icon` is stored with it in `/groups`. ESM: bridged (with stubs that mirror the logic, so the rail paints before the module lands) AND imported by `test/group-nav.test.ts`. |
| `public/emoji-search.js` | Pure `searchEmoji(query, limit)` + `looksLikeEmoji(s)` over a CURATED keyword→emoji dataset (`EMOJI`), feeding the group icon picker: typing a word (`rocket`, `bug`…) surfaces matching emojis instead of being truncated to two letters by `cleanGroupIcon`. Ranking is exact-keyword > prefix > substring; `looksLikeEmoji` tells a typed emoji (kept literally) from a word (searched). The dataset is a few hundred common rows, not the full Unicode set — add rows freely. ESM: bridged (neutral stubs — the picker opens long after load) AND imported by `test/emoji-search.test.ts`. |
| `public/deep-link.js` | Pure `buildMessageLink` / `parseMessageLink` / `samePrompt` — a link to ONE message, `#agent=<full session id>&msg=<transcript uuid>`. In the hash so it never reaches the server or a log; both ids must be full UUIDs (they end up in a CSS selector, and a short id is not a session id). The lookup is by membership in a bubble's `data-msg-ids`, since live and replay cut bubbles differently. ESM: bridged AND imported by `test/deep-link.test.ts`. Design: `docs/superpowers/specs/2026-10-21-message-deep-link-design.md`. |
| `src/prompt-kind.ts` | `userPromptText` and `classifyUserLine` — the ONE rule for "is this transcript line a prompt a human sees in the chat", shared by `loadHistory` and the live tail (which emits a prompt's uuid for the link button). Two copies would drift, and a drifted one stamps an id on the wrong bubble. |
| `public/echo-author.js` | Pure `echoAuthor(msg)` — the author label above a prompt that came from ANOTHER client: the sender's name when the emitting client knows it (Telegram does), else its origin, else the generic wording. ESM: loaded by the browser AND imported by `test/echo-author.test.ts`. |
| `public/channel-store.js` | Pure `pickChannelSource` / `dirKey` — how the client's boot restore chooses its channel list. `pickChannelSource` makes a fulfilled `/channels` (even `[]`) AUTHORITATIVE, so only a FAILED fetch consults the origin-scoped localStorage cache; `dirKey` namespaces that cache key by launch dir. Together they close the cross-dir channel leak (invariant 34). `serverSwapped(pageKey, serverKey)` — did the instance answering this origin change under the tab (a port taken over after a stop)? — drives the "cockpit replaced, reload" banner (invariant 35). ESM: loaded by the browser (bridged, with boot-critical stubs that mirror the real logic — see invariant 10) AND imported by `test/channel-store.test.ts`. |
| `public/notify.js` | Pure `notifyState(channels, {hidden, phase})` → `{color, badge, blink}` — the favicon/title/blink decision. The badge only blinks when the browser tab is hidden AND an **unmuted** channel is waiting for an answer; both phases stay visible (a browser-throttled timer must never make the page look calm). ESM: loaded by the browser AND imported by `test/notify.test.ts`. |
| `public/auth-expiry.js` | Pure `fmtExpiry(ts, now)` (a deadline as "in 22 days" / "in 6 h" / "expired") and `expiryWarning(auth, now)` — the re-login reminder decision over a `/auth` payload: nag only when the account is KNOWN signed in (never `unknown`, never `signed-out` — the sign-in card owns that), only with a numeric `tokenExpiresAt` (the refresh-token deadline, see `src/claude-creds.ts`), within **48h INCLUDING already past it** (a tab left open across the deadline must still nag). Drives both the version-menu Token row and the top reminder banner; the client only does DOM, the threshold and wording are here so the edge cases are tested (`test/auth-expiry.test.ts`). The **re-login** action itself reuses the existing sign-in card (`openAuthCard` → `POST /auth/login`), not a new path. ESM: bridged onto `window` (invariant 10) AND imported by the test. |
| `public/profile-card.js` | Pure `profileBlurb` / `profileBadges` — the labels a profile card shows, derived from `systemPrompt` / `deny` / `model` / `secrets` (nothing added to `Profile`) — plus `defaultAgentName(profile, cwd)`, the name proposed for a new agent (profile → directory → `"agent"`), and `isManagedProfile` — the server-owned roles (`Shadok-Tweak`) that must never appear in a list where one PICKS a profile, since their prompt is rewritten at every boot. ESM: loaded by the browser AND imported by `test/profile-card.test.ts`. |
| `public/tour-steps.js` | Pure `TOUR_STEPS` / `visibleSteps` / `unionRect` / `bubblePlacement` — the guided tour's step data and geometry. A step whose target is not on screen is **dropped, never faked** (an empty cockpit has no agent menu), so the counter reads over the RETAINED steps. **An empty rect is not a point at the origin**: `unionRect` DROPS `{0,0,0,0}` members and returns null only when none survive. Without that, `reflowHeaderTools` parking five tool buttons in the closed ⋯ menu below 640px pinned the union's `Math.min` to zero and stretched the toolbar spotlight from the viewport's corner across the header — measured `top -6px, left -6px, 367x51` — framing the brand and the gauges while the body described buttons that were not on screen. Same family as `.hdr-tools`, which is `display: contents` on desktop and has **no box at all**; that one dropped its step honestly, this one kept it and lied. Dropping empties is also what lets one step carry BOTH layouts' selectors (`["#tabbar", "#chanSelect"]`), which is how the phone stopped losing every step that mentions agents — it used to get 3 of 6. Two copy rules the tests hold, both learned from real drift: **never promise an order** ("left to right" put the ledger's name on the profiles icon the day the ledger was inserted) and **never name a position** ("at the bottom" describes the column, and the phone's `<select>` has no bottom and no *Tweak Shadok-AI*). ESM: loaded by the browser AND imported by `test/tour-steps.test.ts`. |
| `src/claude-models.ts` | Which models THIS Claude Code build supports, **read out of the binary's strings** — one scan per upgrade, cached on the binary's path+size+mtime. There is no CLI command that enumerates models (and `claude models` is NOT a subcommand: it is taken as a PROMPT and answered, which costs a turn), so the names come from where they live. `parseModelNames` is deliberately NARROW because a strings dump GLUES adjacent bytes and mints plausible rubbish — this binary really contains `claude-haiku-3-55` and `claude-fable-5-mythos-5` — so only `claude-<family>-<major>[-<minor>]` with a single-digit minor survives, and `-v1` / dated forms are dropped as the same model spelled longer. Known limit, written down rather than rediscovered: a two-digit minor would be skipped, which is the price of keeping `3-55` out; the family aliases never depend on the scan. **An empty result is never cached — not in the file and not in the memo** (`memo?.length`, since an empty array is truthy): a failed scan is the NORMAL case during a claude-code upgrade (invariant 32), and memoising one froze the picker family-only for the life of the process. Pure cores tested. |
| `public/effort-choice.js` | Pure `EFFORT_CHOICES` / `effortLabel` — the thinking-effort levels a picker offers (`--effort`). A PICKER and not a free-text field because the CLI **ignores** an unknown level with a warning instead of refusing it, so a typo would be a silent no-op. `test/effort.test.ts` holds its ids equal to the server's `EFFORT_LEVELS` whitelist, which is what keeps the two lists from drifting. |
| `public/model-choice.js` | Pure `MODEL_CHOICES` / `composeModel` / `isLongContext` — the model a SINGLE agent runs on, picked in the creation popin and overriding its profile's. The choices are ALIASES (`opus`, `sonnet`…), never pinned model names: an alias resolves to the latest model of its family, while a pinned name rots — the profile panel still suggests `claude-opus-4-8`, current when it was written and stale now. The long window is a `[1m]` SUFFIX on the setting, not a model of its own, which is why it is a checkbox beside the picker and why `composeModel("", true)` is null: a bare `[1m]` is invalid, and silently dropping the flag would leave the box ticked over an agent on the standard window. `test/model-choice.test.ts` pins the round trip against `windowForModel`, since the gauge reads that same suffix back (invariant 22). ESM: loaded by the browser AND imported by the tests. |
| `public/gauge-dial.js` | Pure `dialPos` / `dialAngle` / `dialColor` / `arcSegments` / `dialTitle` — the geometry of the 240° quota dial, whose centre is the ideal pace and whose right end is exhaustion. ESM: loaded by the browser AND imported by `test/gauge-dial.test.ts`. |
| `public/ledger-view.js` | Pure `filterLedger` / `ledgerFacets` / `ledgerAge` / `ldgNorm` + the `LEDGER_AGES` / `LEDGER_SORTS` option lists — how the read-only ledger viewer narrows a table that is 144 rows here and 498 on a sibling instance one day later. Client-side over rows already in hand (`GET /ledger` sends the table whole), so no endpoint and no round trip per keystroke. Four rules carry it. Search is accent-INSENSITIVE, because a sibling instance's rows are written in French and `hopital` has to find `hôpital` — a box that fails exactly the people whose rows need it is worse than none. The haystack includes the **id**, since that is the handle the pushed block and the CLI both print, so pasting `a1b2` back must land on the row it names (the viewer also SHOWS it now, and it was the one place that did not). An age window reads `verifiedAt ?? updatedAt` like everything else that judges staleness, and **never drops an undated row** — hiding what we know nothing about is how it stops existing. And the chips are counted from the data, never from a fixed list: `status` is free text, so a hardcoded set would silently hide whatever word no one predicted. ESM: loaded by the browser AND imported by `test/ledger-view.test.ts`. |
| `public/upload.js` | Pure `uploadFailure(status, contentType)` — should `attachFile` refuse to parse a `/paste` response, and with what message? A proxy rejects an oversized body with its OWN `413 text/html` page that never reaches our JSON route, so `r.json()` on it threw `Unexpected token '<'` and the composer showed that instead of "too large". Returns null for a JSON response (the caller parses it), else a plain string (413 → "too large", else the status). The server accepts 50 MB (`PASTE_LIMIT`), so a `<html>` here is always the proxy — see the README "Upload size" note. ESM: bridged to `window.uploadFailure` AND imported by `test/upload.test.ts`. |
| `public/update-ready.js` | Pure `claudeUpdateState(screen)` → `"restart"` / `"failed"` / `null` — reads Claude Code's OWN update footer from the agent's TUI screen (which the client already has as `t.screenText`): `Update installed · Restart to apply` → the binary is in, reload to apply; `Auto-update failed · … npm i -g …` → the auto-update failed, the cockpit installs it (`POST /claude-update`) then reloads. Scanned only in the **tail** of the screen (last lines) so an agent that merely PRINTS the phrase up-screen doesn't trip the badge — the invariant-2 false-positive class. Surfaced as a per-agent ↻/⚠ badge on the tab + a chanBar button. ESM: bridged to `window.claudeUpdateState` AND imported by `test/update-ready.test.ts`. |
| `context/pilot-prompt.md` | System prompt appended to **every piloted session** via `--append-system-prompt` (wired in `makePilot`, server.ts). Tells the agent it runs under the cockpit (chat rendering, sibling sessions, worktree discipline). `SHADOK_PILOT_PROMPT=0` disables. |
| `context/agents-skill/` (`pilotctl.mjs`) | The `shadok-ai-agents` skill: a thin client that lets an agent spawn/pilot other agents through the server. **Seeded globally at boot** (`seedAgentsSkill`, twin of secrets/scheduler) so an agent in ANY repo has it — it used to live only in the repo's `.claude/skills`, a project skill invisible to agents working elsewhere (e.g. a lead in another repo told to delegate). SKILL.md invokes it by its seeded path (`~/.claude/skills/shadok-ai-agents/pilotctl.mjs`); `REPO_ROOT` (the in-repo server auto-start) is guarded so a globally-seeded copy never `npm build`s `$HOME`. It uses Node's **built-in `WebSocket`** (a tiny `makeWS` shim adds the `ws`-style `.on`/`.once`), NOT the `ws` package: seeded outside a repo there is no `node_modules` to resolve `ws` from, and the missing module broke every out-of-repo pilot with `ERR_MODULE_NOT_FOUND`. |

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
    like every other datum (`src/context.ts`, invariant 22).
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
spoke/
`name` — the tab name for a NEW agent (pilotctl `--name`); ASSERT-only and applied
on a spawn ONLY, so a resume never clobbers a rename made in the UI),
`prompt` (text, `force?`), `run` (`command` — a one-line command typed into the pane's SHELL MODE on the human's behalf; **browser connections only**, since shell mode bypasses a profile's `deny`; see `src/bang.ts`), `choose` n, `toggle` n, `confirm`, `freetext` n
text, `key`, `settle`, `restart`, `set-parent` (`parent` — the channel told when
this one finishes, blocks or dies; `null` detaches. Refused **explicitly** on a
cycle, an unknown parent or a cap),
`set-profile` (`profile` — the profile's name or
`null`; `restart?` to apply it right away by respawning in place. This is the
ONLY legitimate path: `profile` is `SERVER_OWNED` on the channel, so a browser
PUT `/channels` cannot touch it),
`set-model` (`model` — an alias like `opus`, optionally `[1m]`-suffixed, or
`null` = the profile's; the twin of `set-profile` for the per-agent model, shown
and changed in the agent menu. `--model` is a spawn arg, so it ALWAYS respawns to
apply — no "at next reload" gap. `model` is `SERVER_OWNED` too),
`set-effort` (`effort` — a level from `EFFORT_LEVELS`, or `null` to hand it back
to the profile; the same shape as `set-model`, for the same reason: `--effort` is
a spawn arg, so it ALWAYS respawns. An unknown level is refused OUT LOUD, because
the CLI itself would only warn and silently run at the default), `stop`
(`sessionId?` — kills a specific channel, so the UI can remove a zombie).

**server → client:** `ready` (carries `instanceKey` — which instance answers this origin, so a stale tab whose port was taken over detects the swap, invariant 35), `working` (carries `elapsedMs` — how long the turn has been running; the client anchors on the DURATION and never on a server instant, or the stopwatch is off by the whole gap between the two clocks), `turn-done`, `stream-text`,
`stream-tool` (carries `files` — `{path,name,image}[]` — when it's a `SendUserFile`, so the client renders a download / inline-image card instead of a folded tool line, and Telegram uploads them), `stream-result`, `stream-bash` (`command` then `output`/`isError` — a shell-mode exchange read from the transcript), `history` (whose turns may be `role:"file"` for a delivered file, or `role:"bash"` for a shell-mode exchange), `dialog` (question, options, `multi`, optional `body` — the box's own text, invariant 43 — and optional `preface`), `screen`, `tokens`,
`context`, `background` (`shells` + `monitors` — what the pane reports still running; live only, never stored, like the context percentage), `parent` (the parent channel changed — broadcast, so every tab follows),
`profile` (the `{profile, applied}` pair — desired vs the one the running process
actually carries; their gap is what the UI shows as "at next reload" — and it
also carries `model`, the per-agent model the agent menu shows/changes),
`prompt-echo`, `prompt-id` (`msgId` + `text` — the transcript uuid of a prompt
the server echoed before it was written, so the client can stamp that bubble for
a link to it; `stream-text` carries its own `msgId`, a `history` turn `ids`),
`pace-blocked` / `pace-hold` / `pace-resumed`,
`auto-retry-*`, `version`, `server-reload`, `gone`, `error`, `exited`,
`stopped`. `error` carries an optional `code` — `"busy"` (prompt refused
mid-turn), `"link-refused"` (a `set-parent` the server will not accept) or
`"logged-out"` (a spawn refused because the instance is not signed in to Claude) or
`"resume-refused"` (a `resume` whose shortened id matches no agent, or several)
— so a machine client can classify a refusal without matching on the message
text.

**HTTP:** `/usage` (5h/7d + pace verdict), `/live` (running sessions),
`/sessions` `/recover` (resumable), `/diff`, `/channels` `/groups` (GET/PUT,
persisted per launch dir; the GET of `/channels` adds a **derived** `crons` —
the channel's schedules, for the tab's ⏰ — never stored, see invariant 6; the
PUT carries an `x-shadok-instance` header and is refused **409** on a mismatch
with the server's own launch dir — invariant 35),
`/defaults` (server cwd, plus `instanceKey`),
`/first-agent` (GET — `{pending, reason}`: is this instance's lead agent on its
way? Polled by the page only while it has no tab, and faster while `pending`),
`/title` (GET/PUT — the cockpit's per-launch-dir
name; empty PUT reverts to default), `/theme` (GET/PUT — the cockpit's
per-launch-dir colour palette; default/unknown reverts to default),
`/tweak/prepare` (POST — clone/refresh
shadok-ai's own source, returns the cwd to start the tweak agent in),
`/profiles` `/secrets`
(GET/PUT/DELETE). `/secrets`: GET returns NAMES only, and PUT refuses an
existing name with 409 unless `overwrite: true`. `PUT /profiles` writes the
GUARDRAILS and is **browser-only** (cf. the profile-guardrail invariant);
agents get exactly two profile writes, and neither can reach a guardrail:
`/profiles/prompt` (PUT) — a `systemPrompt`, its own or, under the lead profile,
any — and `/profiles/secret` (PUT) — attach to ITS OWN profile a vault secret
IT created (provenance from `secret-origin.json`; no exception for the lead,
cf. invariant 37). `GET /profiles`
adds a **derived** `origin` per profile (`stock` / `edited` / `custom`, never
stored, cf. invariant 6): seeding only ever fills an EMPTY vault, so a starter
profile edited once never catches up on a newer upstream wording — the panel
marks it. `/profiles/restore` (POST, browser-only) puts that prompt back to the
build's, and only that field: deny/allow/secrets/model are the user's and
survive, exactly as `withManagedPrompt` does for the managed role.
`/users` (GET/POST/DELETE) and `/users/role` — accounts, **admin only**;
`/peers` (GET/POST/DELETE) — cross-instance peers, **admin only** (POST returns
the token ONCE); a peer authenticates the WS and `GET /diff` with `x-shadok-peer`,
scoped to its own agents (`src/peers.ts`);
`/invite/:token` (GET/POST) — redeeming an invitation, reachable WITHOUT a
session (with 2FA on it answers `{next:"enroll", code}` and a pending cookie
instead of a session); `/me` — who the caller is;
`/login/passkey/options` `/login/passkey` `/login/enroll/options` `/login/enroll`
(POST, before the gate, need the `sk_pending` cookie — the second step of a
sign-in, and registering a device with an enrollment code);
`/2fa` (GET — status, my passkeys, why it cannot be enabled), `/2fa/register*`,
`/2fa/passkey/delete`, `/2fa/enroll-code`, `/2fa/reset`, `/2fa/enabled`,
`/2fa/confirm/options` (POST, browser-only, a signed-in PERSON — see invariant
42); `/vendor/simplewebauthn.js` (before the gate, the login page needs it);
`/backend` (GET — the model backend in use, without its key, plus the onboarding presets; PUT — save one or `{clear:true}`, **admin + browser only**), `/backend/test` and `/backend/models` (POST, admin + browser only — one real request to a candidate backend, and the models it serves; src/backend.ts),
`/models` (GET — the families, the versions discovered in the binary, and the machine-wide default; POST `/models/default` — pin it, **browser-only** like `PUT /profiles`, since it writes a key every agent on the machine reads), `/telegram` (GET/PUT — bot config from the GUI), `/version`,
`/autoupdate`, `/permission-mode`, `/reload` (POST — an agent respawns ITSELF,
scoped by `SHADOK_SESSION_KEY` like `/profiles/prompt`, used by the
`shadok-reload` skill), `/ledger` (GET — the table for the read-only viewer;
POST — flip the ledger reflex from the GUI;
**restarts all agents** when it changes so the reflex lands), `/restart-all`
(POST — respawn every agent, the version-menu button; an optional
`{sessions:[ids]}` body limits it to those agents, which is how *Reload N agents
to apply update* reloads ONLY the ones flagged as running on the old Claude Code
binary, `restartAllSessions(ids)`). Both restart **one at a
time, in the background** (`restartAllSessions` returns at once): a concurrent
herd of `claude --resume` trips the upstream OAuth refresh-token race (~30+
agents) and spikes resources — the manual single reload is safe only because it
is isolated. `/claude-update` (POST, **browser-only**, single-flight — `npm i -g
@anthropic-ai/claude-code` via `installClaudeCli`, then drops the cached binary
path so the next spawn re-resolves it; the GUI shows the button when an agent's
TUI footer reports `Auto-update failed`, and reloads the agent afterwards. Not an
agent-reachable action: it touches the whole machine's CLI). `/login`,
`/vendor/marked.js`,
`/paste` (POST — ANY file pasted OR dropped into the composer, not just images;
lands in the same `MEDIA_DIR` as Telegram attachments, keeps the original name
via the `x-filename` header so the extension stays truthful, and returns
`{path, line}` — `line` is the ready-made `[Attached image: …]` / `[Attached
file: …]` from `attachmentPrompt`, the ONE format for the agent whatever the
surface. Accepts every content type (`express.raw({type:()=>true})`).
Browser-origin only: it writes a file. The client no longer types `line` into
the textarea: a paste/drop becomes a **chip** in the composer strip
(`#composerAtts`, thumbnail for an image via `GET /media`, named tag otherwise),
and the `[Attached …: path]` line is composed back from the ready chips only at
submit — so the agent reads exactly what it always did while the user sees a
preview, and an image renders inline in their own message bubble
(`renderUserAttachments`, invariant 13's twin: the path is trusted server output,
not agent Markdown)),
`/media/:name` (GET — serves a file back from `MEDIA_DIR` for inline display in
the chat and the composer chip. Basename only + a `sandbox` CSP and
`nosniff`, like `/download`; a raster image is `inline`, everything else
`attachment`. No transcript check because these are files the USER supplied, not
paths an agent named — the traversal guard is the whole gate),
`/files` (POST — an agent offers a file through shadok's own path, authenticated by `x-shadok-session-key`; refusals name the path and say why, and a partial success reports WHICH file did not make it),
`/download` (GET — `session` + `path`: streams back a file the agent DELIVERED via `SendUserFile` **or offered through `POST /files`** — two sources, one rule. The path is verified against that session's transcript
(`sentFilePaths`), so it can never be walked into an arbitrary file; the response
carries `X-Content-Type-Options: nosniff` + a `sandbox` CSP so an agent-authored
HTML/SVG cannot run script in the cockpit's origin even if opened directly. A
raster image is served `inline` (renders in the chat's `<img>`), everything else
`attachment`).

Everything except `/login` sits behind the optional password gate (see the
Auth section of `docs/architecture.md`).

## Invariants & hard-won gotchas (DO NOT relearn these the hard way)

1. **The registry is the authority on where a session lives — resolve, never
   guess.** `loadHistory` is keyed by the cwd (encoded →
   `~/.claude/projects/<enc>/<id>.jsonl`), so a worktree session resumed at the
   repo root wakes with **no history at all**. That directory, plus the
   `branch`/`repo` needed to rebuild a reclaimed checkout, is recorded on the
   channel when the session is created. Every caller acting on a session's
   behalf reads it back through `resolveSessionTarget` / `resumeTarget`
   (`src/channels.ts`) instead of naming a directory of its own — and on a
   resume the registry's answer **beats whatever the caller sent**.
   That single lookup is not a preference, it is the fix for the same bug three
   times over: the browser sent `repo: serverCwd` for every channel (right only
   while every worktree came from the launch repo — the tweak agent was the
   first that didn't), `driveChannel` sent `cwd: process.cwd()` while the cron
   guard ten lines above already had the channel's own directory, and the
   `start` handler fell back to the server's cwd. `process.cwd()` is the
   server's, never a session's.
   The other half is writing it down: at `ready` the server ASSERTS `cwd`,
   `branch` and `repo` from `session.worktree` and never clears them. `branch:
   worktree?.branch ?? null` erased the branch on the first resume, because a
   resume has no `worktree` object and `upsertInto` writes anything that is not
   `undefined`. Omit the key; never write a null.
   **`profile` is in that same assert-only family, and it was the one still
   written unconditionally.** It is SERVER_OWNED, so the browser never sends it —
   a resume's `msg.profile ?? null` is null, and writing that erased the
   channel's role, so the agent came back with no guardrails and no badge. Nine
   agents lost their profile this way during the 2026-09-24 restart churn (a
   corruption the running processes' applied role could not be recovered from —
   Claude Code writes neither `--append-system-prompt` to the transcript nor a
   readable role to `/proc`, so the fix was a hand-restore from the user's
   intent). `profilePatch(profile, msg.profile !== undefined)` (`src/channels.ts`,
   pure, tested) keeps the stored profile unless the client chose one explicitly
   (a name, or null for "no profile") — the same "omit, never null-by-omission"
   rule as `branch`.
2. **Detection heuristics are fragile.** `screenShowsWork` must ignore a
   *quoted* "esc to interrupt" (Claude explaining shadok-ai tripped it →
   session stuck "busy"). `detectDialog` must strip a right-hand **preview
   column** (AskUserQuestion charts) or option labels get mangled.
   Same family, other direction: the QUESTION is whatever sits above the first
   option, so any rule the TUI draws there must be recognised as décor or it
   is read as content. Claude Code 2.1.286 started framing a permission
   prompt's command block with a DASHED rule (`╌`, U+254C) where 2.1.281–285
   used the solid characters; the class the walk stops on did not have it, and
   "Do you want to proceed?" reached the web card and Telegram behind a full
   row of dashes — on the most common dialog there is. Options, indices and
   `multi` were untouched, so nothing looked broken from the control side.
   `FRAME_LINE` (`src/extract.ts`) now lists the whole dash family
   (`╌╍┄┅┈┉`), since pinning the one character seen is how the next release
   catches it again — and it stays ANCHORED at the start of the trimmed line:
   a line that starts with a rule is décor, a sentence that contains a dash
   is prose.
   **Method note: a strings diff of the binary cannot see this.** The rule is
   emitted as one character repeated at runtime, not as a literal, so it
   appears in no strings dump and the 285→286 diff of gates, counters and
   labels came back entirely empty. Only a live probe (a throwaway interactive
   `claude` in tmux, asked for a `touch`) showed it. Never conclude "nothing
   moved" from a strings diff alone.
3. **Single-select dialogs are navigated, not typed.** `choose` moves the `❯`
   cursor with arrow keys then Enter — preview-style dialogs ignore digit keys.
   Multi-select `toggle` uses the digit; `confirm` does Tab→Submit→Enter.
   **`moveToOption` must WAIT for the cursor to move between presses, never poll a
   fixed delay** (`src/detect.ts`, pure-tested via a lag-simulating fake pilot).
   A `TmuxPilot.screen()` is a MIRROR refreshed on a ~300ms poll (`SCREEN_FAST_MS`),
   so a keystroke is invisible until the next capture: a 160ms read came back with
   the cursor still on the old option, the loop pressed again, and it sailed past
   the target — single-select answers all landed on the LAST option, so every form
   "did nothing" and re-appeared. This broke EVERY select in web mode on the
   default (tmux) transport; `PtyPilot.screen()` is synchronous and hid it
   entirely, which is why only an end-to-end run against a real tmux agent found
   it. `waitFor` (both pilots have it) polls until the move lands — correct on
   either transport.
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
   **Worse than that race: ONE failing module kills EVERY bridge.** The block
   imports six files; if any of them 404s, 500s or throws, the whole script is
   discarded and not one `window.*` is assigned — so the first click raises
   `TypeError: window.X is not a function` on a name that has nothing to do with
   the file that failed (a broken `gauge-dial.js` surfaced as
   `window.visibleSteps`, a user hit it as `window.profileBadges`). Guarding call
   sites one at a time kept losing: `profileBadges` threw five lines from a
   correctly guarded twin, and eleven calls were still bare. So the classic
   script installs a neutral **stub per bridged name** before wiring any button,
   the module `dispatchEvent`s `shadok-bridge-ready` so anything painted with
   stubs is repainted, and a stub still in place three seconds after `load`
   raises a visible banner — an amputated UI in silence is worse than the error
   it replaces. `test/esm-bridge.test.ts` locks the name↔stub pairing, the way
   `test/csp.test.ts` locks the nonce.
   **And the pairing itself is now impossible.** What actually failed in the
   wild was a NEW `index.html` (importing `secretUsers`) served next to an OLD
   cached `profile-card.js` that did not export it — the page is a dynamic
   route, the modules go through `express.static`, so the two can drift. The
   import URLs therefore carry `?v=<running version>`, injected beside the nonce
   (`injectAssetVersion`): a page of one version can only ever request that
   version's modules. `test/csp.test.ts` refuses a bare module URL.
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

19. **The SSH identity must never touch a real host's `~/.ssh`, and must live on
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

20. **The browser's socket scheme follows the page's — never hardcode `ws://`.**
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

21. **Dialog detection belongs to the screen watcher, not to one input path.**
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
    key on `turn-done` so asking the SAME question twice still reaches the clients
    — and, for the same reason, it now also clears the key in its **dialog**
    branch before publishing. `finishTurn` is only reached by a deliberate
    transition (a prompt or an answered dialog that ran a turn), so a dialog
    present when it settles is a FRESH ask even when its text is byte-for-byte the
    one just answered. Two back-to-back CLI permission prompts ("Do you want to
    proceed? Yes/No") share a `dialogKey`, and so do two AskUserQuestions with the
    same options; without the clear, the dedup swallowed the second as a repaint
    and the session sat wedged on an invisible question. The `SUBMIT_PAGE` guard
    in `publishDialog` still runs first, so clearing the key can never re-surface
    the multi-question recap.
    **And turn-end detection must not be the only thing that can DISCOVER a
    dialog, because a dialog can carry a clock.** Claude Code (≥ 2.1.284, gate
    `tengu_splendid_horizon`) renders some permission prompts with "⚠ Claude Code
    will automatically deny this request in 1:43…", repainted EVERY SECOND, and
    denies on its own at 0:00 (120 s). `idleStep` settles only on a screen
    byte-identical for `stableMs`; measured against the real pane over 20 s, the
    longest stable window was **678 ms** against the **2000 ms** `finishTurn`
    requires. So `waitForIdle` never returned, `detectDialog` was never called,
    the cockpit just showed "working" — and after two minutes the agent reported
    "no approval came through". (The watcher could not catch it either: it only
    looks while `!busy`, and `finishTurn` holds `busy`.) The wait now ALSO ends
    on `settleOn` (`dialogSettleKey` in `server.ts`): the same `dialogKey` held
    for `DIALOG_HOLD_MS` (400 ms — one poll would read a half-painted dialog), via
    the pure `settleStep`, still behind the work check. Identity, not bytes: the
    countdown is in neither the question nor the labels, so the publish dedup
    holds too. Two rules that came with it: never strip the countdown line from
    the comparison (that matches upstream prose and fixes one trigger; any
    spinner or progress line in a dialog would wedge the same way), and the
    multi-question recap page is excluded from `settleOn` — right after the Enter
    that confirms it the screen still shows it, and settling there would end the
    wait before the submitted turn even starts.

22. **The context gauge reads the transcript, never the footer — and the window is
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

23. **A restart must GUARANTEE a new process — `TmuxPilot.start()` adopts an
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
    The input box has the mirror-image trap: **an empty box does not always read
    empty.** Before a session's first prompt, Claude Code (2.1.285) shows an
    example in it — `❯ Try "refactor <filepath>"`, a different one per start — and
    puts it back after a Ctrl-U; `inputText` reads it like typed text.
    `typeIntoBox` took "non-empty" for "the paste landed", so on such a start it
    returned before anything was pasted and a dropped paste was followed by Enter
    on a box holding nothing — the agent's first prompt lost, with no error. It
    now waits for the box to DIFFER from what it showed just before the paste
    (re-read each attempt), and treats "back to that state" as cleared. No list of
    hint strings: that would rot with the next release. Not every start shows one
    (a 2.1.269 probe found a blank box) and what decides it is unknown. The send
    check (`screenShowsWork || inputText === ""`) is unaffected: verified live, the
    example does not come back after a real send.

24. **A field accepted in `start` is not a field STORED — and only the browser
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
    `branch` and `repo` (invariant 1): a client that omits the key must never
    erase a link that already exists.

25. **The diff baseline is COMPUTED, never stored — and `A...B` is the wrong
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

26. **A profile carries the GUARDRAILS, so an agent must never be able to write
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
27. **A signal you never observed is not a signal — and the sign-in's success is
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

28. **On a phone the viewport is THREE different rectangles, and CSS only knows
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

29. **The beta channel IS the `latest` dist-tag — CI can only ever SET a tag, not
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
    cannot promote twice. The NUMBER follows one rule: `<major>.<minor>.<commits
    since this minor began>`, so the patch **restarts at 0 on every promotion**
    and a version says where it sits inside its generation. A promotion is not a
    special case — the promoting merge is the commit that set the minor, so its
    count is 0. Two earlier spellings were worse: the global commit count gave
    `0.3.77`, which reads as the 77th patch of a 0.3 series that never had one;
    special-casing the promotion to `.0` fixed the milestone but left alphas
    numbered by repository age. Changing this rule **requires promoting in the
    same merge** — restarting the count alone publishes a version LOWER than the
    one already tagged `alpha` (0.5.2 against a published 0.5.123), and every
    alpha instance silently stops updating, since `isNewer` is false, until the
    next promotion.

30. **A multi-question `AskUserQuestion` is a form with a tab bar, not one
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

31. **One agent = one channel row: dedup by `sessionId` at BOTH ends, because a
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

29. **The transcript is ASSERTED, not merely un-poisoned — a session that writes
    none runs, works, and says nothing.** Every piece of content the cockpit
    shows comes from the `.jsonl` (`src/tail.ts`); the screen is only ever used
    for control. So an agent whose transcript is disabled is silent in the web
    chat, silent in Telegram and empty on reload, while looking perfectly alive
    in the engine room — the same silent-loss class as invariant 7, and worse,
    because there is nothing to resume from afterwards.
    Claude Code disables transcript writing when it inherits
    `CLAUDE_CODE_CHILD_SESSION`, and it sets that marker **itself** on the
    environment it hands to its own tool subprocesses. So the marker is not
    something a careless operator exports: **any agent that shells out to
    `claude` passes it on**, without anyone choosing to.
    Both transports already strip `/^(CLAUDE|CLAUDECODE|AI_AGENT)/` at spawn and
    that stays. It is not sufficient on its own for two reasons. Subtraction
    assumes we have enumerated every name that can suppress a transcript, and it
    stops working **in silence** the day a new one appears. And `TmuxPilot.start()`
    skips the whole strip when it adopts an existing pane (`this.attached = true`,
    invariant 25) — which is what makes an agent survive a server restart, and
    also means a pane created wrong stays wrong forever, including across a
    "Reload agent" that re-adopts it. `FORCED_CLAUDE_ENV` (`src/session.ts`) is
    therefore applied **last** in both transports, after the profile's secrets, so
    nothing a profile carries can switch it off even by accident of naming.
    **The trap in verifying this: it does not reproduce under `claude -p`.** A
    headless run writes its transcript with the marker set, so a `-p` test comes
    back green and proves nothing. It was confirmed the only way that works — a
    throwaway tmux session in interactive mode, where the marker alone produces
    the "Transcript saving is off" footer and adding the flag removes it.

32. **An executable file named `claude` is not a working `claude` — and the npm
    launcher is, intermittently, a 500-byte shell placeholder.** Since the split
    packaging (verified on 2.1.250), `@anthropic-ai/claude-code` ships
    `bin/claude.exe` as a placeholder and its postinstall hardlinks the ~223 MB
    native binary from an optional dependency (`…-linux-x64`, `…-darwin-arm64`,
    one per platform) over it. That placeholder is mode 0755, so `resolveBin`'s
    `X_OK` test hands it back happily, `ensureClaude` reported `{ok:true}`, and
    the spawn died on its `Error: claude native binary not installed.` + exit 1
    — the same "agent zombie / failed to start" shape as the two `posix_spawnp`
    traps above, with nothing in the log to name it.
    It is not only the `--ignore-scripts` / `--omit=optional` case, which would
    at least be permanent and obvious. `placeBinary` in their `install.cjs`
    **unlinks the destination before relinking**, and restores the placeholder if
    the copy fails, so EVERY claude-code upgrade opens a window where the
    launcher is absent or is the placeholder again. Measured here: sampling every
    2 s for a minute, 1 sample in 30 was broken, and a `claude --version`
    answered `No such file or directory` while `/usr/local/bin/claude` plainly
    existed. Anthropic fixed a cousin of this for their own background sessions
    in 2.1.246; we had no equivalent.
    Four rules came out of it, and each is load-bearing.
    **Recognise the placeholder, do not condemn everything else.** `classifyBin`
    matches its own wording in a file under 4 kB (the test `install.cjs` uses on
    its own stub) and calls anything unrecognised usable. The tempting rule —
    "the real one is an ELF of hundreds of MB, so a small file is broken" —
    would also condemn pnpm/volta/asdf shims and npm's Windows `.cmd` shim,
    which work fine. Same discipline as invariant 27: assert only what you saw.
    **Do not probe by executing.** A `claude --version` before each spawn costs a
    process launch and is no more sound: its answer is stale the moment it
    returns, and the window is milliseconds wide. A stat plus a 512-byte read is
    exactly as raceable and costs microseconds.
    **Resolve the fallback at runtime, never hard-code it.** `nativeBinCandidates`
    walks `node_modules` ancestors from the launcher's own package, because npm
    HOISTS that optional dependency as readily as it nests it — assuming the
    nested layout is precisely what made `node-pty-fix.ts`'s chmod silently miss.
    **Never cache a verdict about it.** The path rots on the next upgrade, so
    `claudeCommand` re-validates on every call (one stat, next to a process spawn
    the caller is about to pay for anyway) and `ensureClaudeOnce` re-runs when its
    cached path stops classifying as usable. Caching "ok" across the window is
    what would turn milliseconds into a permanently broken instance.
    **And a busy binary is a THIRD shape, distinct from both.** The kernel
    refuses to execute a file that is being written — `ETXTBSY`, where "text"
    is the old Unix word for a program's code segment. `placeBinary` rewrites
    ~214 MB in place, so that window is SECONDS wide, and a machine that follows
    releases lands in it repeatedly: three times in one day here, each one
    killing an agent spawn and surfacing as a dead agent, a `pilotctl` `dialog`
    that hung, and turns cut between an agent's last write and its commit. The
    cure is the opposite of the placeholder's: the file is exactly right and
    merely busy, the condition resolves on its own, and the only mistake
    available is concluding too early. `isBinaryBusyError` / `startWithBusyRetry`
    wait it out; `findClaudeBinWithRetry` cannot help, because it retries a STAT
    and a busy binary stats perfectly — you only learn at `execve`. `TmuxPilot`
    reaches the same path from the other end: `tmux new-session` returns once the
    pane exists, so a pane ALREADY gone means its command never ran.
    **That retry has to cover EVERY spawn of the binary, not just a pilot's.**
    The auth probe runs `claude auth status`, and `execFile` throws `ETXTBSY`
    **synchronously** — a promise executor turns that throw into a rejection, so
    it never looked like a spawn failure and never met `startWithBusyRetry`. It
    left the `start` handler as a thrown error, and a throw does not *degrade* a
    spawn, it CANCELS it — while the three-valued `AuthState` sitting ten lines
    below exists precisely so that not knowing refuses nothing (invariant 27).
    So the gentlest state had a fourth, harshest form, and a user on Telegram
    read `⚠️ spawn ETXTBSY` and got no agent, over a window that had closed
    before they finished the sentence. `probeWith` waits a busy binary out and
    answers `unknown` for everything else; it never throws.
    A placeholder is also NOT a reason to `npm i -g`: the package is plainly
    installed, and reinstalling while someone else's postinstall is mid-rewrite
    makes it worse. Say what is wrong instead (`claudeStubMessage`), in the
    spirit of `claudeMissingMessage` and `describeStuckScreen`.
    **And "missing" can be a lie too — Claude Code updates ITSELF.** Its
    auto-updater runs `npm install --global @anthropic-ai/claude-code@<version>`,
    and while npm reifies it moves the package directory aside, so for a few
    seconds there is no launcher at all. On a fresh instance (an image a few weeks
    old, so the first `claude` it runs updates straight away) `findClaudeBinWithRetry`
    gave up inside that window, `ensureClaude` started a SECOND `npm i -g` into the
    first one's reify, and it died on `ENOTEMPTY` — shown to the user as "installing
    it failed (npm exited with code 217)", 217 being 256 − 39. The auto-updater's own
    install, started two seconds earlier, had succeeded: the npm debug logs carry
    both command lines, which is how the second actor was identified rather than
    guessed. Two things now stop it. `claudeInstallInProgress` looks for npm's
    reify directory (`@anthropic-ai/.claude-code-<hash>` — the name is derived from
    the path, which is exactly why a second install collides on it) and
    `ensureClaude` WAITS for it, bounded at 90s and ignoring a leftover older than
    ten minutes, so a crashed install cannot stall every future one. And a failed
    install is followed by one more `find`: losing a race to an install that
    landed is not a missing CLI. Same rule as the placeholder, applied to the
    absent case — never install over someone else's rewrite.

33. **A credential frozen into a process's environment cannot be refreshed — so
    it must not be one that expires.** Every agent is handed `SHADOK_AUTH`, the
    bootstrap admin's cookie, at spawn. That cookie carries its issue time and
    `readSession` refuses it past `SESSION_TTL_MS` (a week). An environment
    variable cannot be updated in a running process, and shadok's agents run for
    weeks — so on day eight an agent started getting `401` on **every** call to
    its own server: `schedule.mjs`, `pilotctl`, the vault, `/channels`. Nothing
    is logged, nothing is on screen, and the agent's own report is accurate to
    the word: *nothing changed on my side*. The self-repair path is behind the
    same door — `shadok-reload` reads `SHADOK_AUTH` too — so the one thing that
    would have fixed it is the one thing it could not do. A human must hit
    *Reload agent*.
    The fix is the OTHER credential it already carries. `SHADOK_SESSION_KEY`
    proves "I am this agent", which is a fact with no expiry date, and it grants
    exactly what the cookie granted (the bootstrap admin) — so accepting it via
    `x-shadok-session-key` removes the cliff without widening anything. Three
    things make it work, and each replaced something that did not.
    **Derive the key, never store it.** It was a `randomUUID` in an in-memory
    `Map`, which had the same class of cliff one level down: the Map dies with
    the server, a tmux agent does not, so every auto-update invalidated the key
    of every surviving agent and `/reload` answered 403 forever after. An HMAC of
    the session id needs no state to survive a restart.
    **Carry the id inside the key** (`<id>.<mac>`), so verification recovers it
    with no lookup and the wire format stays one opaque string — nothing that
    presents a key had to learn a second field.
    **Bound it by the CHANNEL, not by `sessions`.** A key that cannot expire
    needs something to revoke it, and the obvious choice is wrong: after a
    restart the server does not re-adopt a web session until a client opens it
    (`reconcileOnBoot` reattaches Telegram bridges, not sessions), so a tmux
    agent can be running, executing tools, and absent from `sessions` for hours.
    Measured, not reasoned — pane alive, `/live` empty, key refused — which would
    have rebuilt this very cliff one restart wide instead of a week. The channel
    list is on disk, survives the restart, and loses its entry when the agent is
    closed, which is exactly when the key should stop working.
    One consequence to state plainly: an agent that predates this fix holds a
    random UUID no derivation can recognise, and an expired cookie. Nothing
    unforgeable survives in its env, so it needs **one** reload — and then never
    again.
    And SAY it where an agent will read it. The scripts authenticate on their
    own, so nothing about this is discoverable from a failure: an agent that
    writes its own `curl` — an ordinary thing to do — gets a bare `401` and, with
    no sentence anywhere naming the header, stops there. That is what a
    production agent actually did. The rule therefore lives in the four
    `SKILL.md` (what to send, what a `401` means, and that the pre-fix case needs
    a human) and as one line in `context/pilot-prompt.md`, for the agent that
    loaded no skill at all. `test/skill-auth-docs.test.ts` locks that prose, the
    way `test/tweak-role.test.ts` locks the tweak role's — a code change can
    never make it go red, which is precisely why it needs a test. Note the two
    reach agents differently: skills are `copyFileSync`'d over at **every boot**,
    so a merged SKILL.md lands on existing agents with no reload, whereas the
    pilot prompt is fixed at spawn and only reaches new ones.

34. **Per-launch-dir isolation is a CLIENT property too — the localStorage
    channel cache is scoped by ORIGIN, not by directory.** Everything the SERVER
    stores is keyed by launch dir (`channels/<enc>.json`, crons, ledger, the
    per-dir config fields) and is correctly isolated. But the web client keeps a
    fallback copy of the channel list in `localStorage` (`cp.channels`,
    `cp.groups`), and `localStorage` is keyed by `scheme://host:port` — the same
    key for every launch dir served on that port. Two instances RUNNING at once
    can't collide (the port walk gives them different origins), but sequentially
    they share one: stop the main cockpit, launch shadok in another dir, and it
    binds the now-free 3789 — the browser hands the new instance the MAIN
    project's cached channels. The old restore then made it worse two ways: it
    fell back to that cache whenever `/channels` was merely EMPTY (exactly a
    fresh dir), rendered and RESUMED the foreign channels, and `persistChannels`
    wrote them back into the new dir's own server file. Reported as "I launch a
    shadok in another directory and all the main project's channels come out".
    Three parts close it, and each is load-bearing.
    **A fulfilled `/channels` is authoritative — even `[]`.** `pickChannelSource`
    (`public/channel-store.js`) consults the cache ONLY on a failed fetch; an
    empty-but-successful response means "this dir has no channels", never
    "consult the cache". This alone stops the leak in the normal case.
    **Namespace the cache by launch dir.** `dirKey(base, instanceKey)` suffixes
    the key, so two dirs on one origin keep separate buckets even when a fetch
    DOES fail. The legacy un-namespaced keys are dropped on restore (the server
    is authoritative, so nothing is lost) — never MIGRATED into the current dir's
    namespace, which would re-create the leak by stamping one dir's data as
    another's.
    **The key must be known SYNCHRONOUSLY, or an early write beats it.**
    `instanceKey` is STAMPED into the page (`injectInstanceKey`, marker
    `__INSTANCE_KEY__`, like the nonce) rather than fetched from `/defaults`:
    `persistChannels` fires on an early WS `ready`, and if the dir is not yet
    known `dirKey` falls back to the bare (cross-dir) key and writes it. For the
    same reason the bridged STUBS of `pickChannelSource`/`dirKey` (invariant 10)
    mirror the REAL logic instead of being neutral — persist can run before the
    ESM module lands, and a `(base) => base` stub silently wrote the bare key
    (this is precisely what the first browser repro caught, twice, after the
    unit tests were green). Verified end to end: a fake cache under the old key,
    a reload → the fake never renders, the bare key is gone, only the dir's own
    channel survives. Not reproducible by curl (the leak is client localStorage)
    and invisible to `tsc`/tests — it needs a real browser on a shared port.
    One thing this does NOT touch: a global `TELEGRAM_BOT_TOKEN` env override
    still lets a second instance adopt the board group's topics (the per-dir
    token store is what normally isolates it) — a deliberate override, documented
    under "Running YOUR build", not a leak to fix here.

35. **A browser tab belongs to the instance it was LOADED from — gate writes on
    the instance key, because two instances share a port sequentially.** Invariant
    34 (localStorage) was a real vector but NOT the one the reported bug hit. The
    actual mechanism, found only by reproducing with the user watching the Network
    tab: you launch a cockpit, the browser opens a tab, you STOP that server and
    relaunch one from a DIFFERENT directory on the same port. The stale tab's
    WebSocket reconnects to the new instance, and the tab still holds the old
    instance's channels in memory — so its next `persistChannels` **PUTs them into
    the new instance's file** (the user's own words: "la première page envoie ses
    canaux à l'instance, et paf"). The GET was empty; the PUT is what fills it,
    which is why it looked like it "came from the server" and appeared after a
    delay (the 4 s `syncChannels` poll reads the now-poisoned `/channels`). Zero
    tabs open → no source → no leak. The fix reuses invariant 34's stamped
    `instanceKey` as an IDENTITY: the client sends it (`x-shadok-instance`) on
    every `PUT /channels`/`/groups`, and the server **refuses (409) an explicit
    mismatch** (`channelWriteAllowed`, `src/channels.ts`) — a stale A-tab can no
    longer write to instance B. A no-key client is allowed (a pre-fix page, or the
    non-browser callers that never PUT channels). The server also re-states its
    `instanceKey` in every `ready`; the client compares it to the page's
    (`serverSwapped`, `public/channel-store.js`) and, on a mismatch, freezes all
    pushes and shows a "this cockpit was replaced — reload" banner, so the user
    isn't silently driving the wrong instance. And `dropForeignHomes` (applied in
    BOTH `loadChannels` and `saveChannels`) strips any `home:true` channel whose
    cwd is a different launch dir — a foreign "general" has no place in this file —
    which **self-heals the already-poisoned files** the old bug left behind (an
    empty cwd is kept: it's an own home whose cwd is not yet asserted). The deeper
    point the user named — that a tab can not only WRITE but DRIVE another
    instance's sessions on a shared port — is left for a follow-up; the same
    instance-key-on-the-wire primitive extends to it. Verified at the HTTP layer:
    a PUT with a matching header writes, a mismatched one is 409, and a foreign
    home in a matching PUT is dropped on save.

36. **The input box is not its first line — and an interrupted prompt comes
    BACK into it.** Two Telegram messages a second apart was all it took:
    the first is submitted and running, the bridge preempts it with an Escape to
    make room for the second (invariant on #158's contract), and Claude Code
    **puts the interrupted prompt back in the box**. Observed on a live pane,
    300 ms after the Escape. The resend then pasted into an occupied box, and
    every check in `typeIntoBox` was watching `inputText` — the `❯` line — which
    a continuation line never touches. So the paste read as "never appeared",
    the recovery's "is it clear?" compared that same unmoving line and answered
    yes without clearing anything, and six attempts stacked six copies of the
    message's header in the box. The user got `submit: the text never appeared
    in the input box` and BOTH messages were lost: the first interrupted before
    it answered, the second never delivered. `boxText` reads the whole box, and
    that one change fixes the detection and the clearing at once.
    Two things that fix uncovers, and both are now load-bearing.
    **A non-empty box is usually a GHOST.** Claude Code offers a previous
    message as a greyed-out suggestion: verified on 2.1.301, typing replaces it
    while Ctrl-U, Ctrl-K and Escape all leave it exactly as it is, and
    backspacing to empty brings it back. A `capture-pane` renders it exactly
    like real text, so clearing the box before every paste would charge every
    message a Ctrl-U and a wait for nothing. Paste first, then check whether
    what was there survived — the one reading that needs no way to tell them
    apart.
    **An interrupt must never land on a submit in flight.** `busy` is already
    true while the prompt is being TYPED, so the second message is refused with
    `busy` and the bridge answers with an Escape aimed at a turn that does not
    exist yet. On a box being filled that key DELETES the text, and a box that
    then reads empty is precisely what `submit` accepts as "sent" — the message
    vanishes with no error anywhere. `submitGuarded` (server) holds such a key
    until the submit has landed, then presses it, where it interrupts the turn
    it was meant for.
    Verified on a bench across gaps of 0–2800 ms: before, 1200 ms failed on both
    attempts with no answer at all; after, zero submit failures and the second
    message answered every time.
    Design: `docs/superpowers/specs/2026-10-22-fast-messages-submit-design.md`.
    **Reading the whole box was necessary and not sufficient — it came back four
    days later, on an instance already running the fix.** Same symptom, same
    shape: a live composer holding six copies of the message header and none of
    the message. Reproduced on a real pane rather than inferred, and the
    remaining hole was in the CLEARING, not in the reading.
    `emptyBox` gives up after two presses that changed nothing, and it was
    getting both for free. **One of the two is invisible by construction**:
    clearing a two-line box takes three Ctrl-U, and the middle one removes the
    now-empty second line — `"⟦header⟧\n"` against `"⟦header⟧"`, the same string
    once `boxText` trims. Hence `boxRaw`, the untrimmed reading, used for
    "did that press do anything?" while `boxText` keeps answering "is there
    anything in there?". **The other was a stale read**: the loop took its
    baseline from `screen()` — a fresh capture on tmux — and judged the change
    with `waitFor`, which polls the POLLER'S MIRROR, refreshed every 300 ms at
    best against the 400 ms it is given. On a host with twenty agents that
    margin is routinely gone. Both reads now come from `screen()`.
    What made one missed observation permanent is the state it leaves behind:
    the leftover header is a PREFIX of the text the next attempt pastes, so
    `survives` answers true for every remaining attempt, each is discarded, and
    each discards leaves one more header. Six attempts, six headers, no message
    — and no way out without a human in a terminal. So a box that Ctrl-U could
    not empty now gets **one** Ctrl-C (`shouldHardClear` / `hardClearIfLeftover`):
    measured on 2.1.310, a two-line prompt takes three Ctrl-U and goes in a
    single Ctrl-C. It is the last resort and not the normal path for two
    reasons — Ctrl-C is also the interrupt, so it is gated on the screen showing
    no work, and a SECOND one in a row exits Claude Code, so it fires at most
    once and never loops. It is also gated on the leftover being OURS (more than
    one line, or carrying the head of the text being pasted): at rest the box
    displays an example or a ghost, which read exactly like typed text, and
    firing at those would spend the one keystroke that has a real cost on a box
    that holds nothing.

36. **Nothing secret may ride on a command line — not the vault's own spawn
    either.** `TmuxPilot` started every agent as one string on `tmux new-session`:
    `env KEY=VALUE … claude <args>`, i.e. every secret VALUE of the profile plus
    every system prompt. That broke in two ways at once, found together on a real
    instance. **tmux refuses a command over ~16 KB** — measured in the container:
    16 000 bytes pass, 17 000 answer `command too long` — so once the vault held
    47 secrets (one of them a 2.4 KB service-account JSON), the lead role could no
    longer be launched at all, while `Shadok-dev` on the SAME vault still could.
    The difference was the role prompt (~2.8 KB against ~0.9 KB), not the
    secrets, which made the failure look role-specific and nothing like a size
    limit. And **the failure displayed the credentials**: `execFileSync` builds
    its message as "Command failed: <every argument>", the start handler forwarded
    it to the client untouched, and the web UI showed forty-six secret values —
    database password, Cloudflare token, encryption keys included. The values were
    also, for the life of the spawn, arguments of a process, which `ps` shows to
    anyone on the machine: the exact exposure the `shadok-secrets` skill was
    designed to rule out on the WRITE side.
    Now the spawn writes a one-shot script (`launcherScript`) into
    `~/.shadok-ai/run/` (dir 0700, file 0600, created with `wx` after a forced
    remove so a stale file cannot keep a looser mode) and tmux runs `sh <script>`
    — a few dozen bytes whatever the vault holds. Values are set with the `export`
    **builtin**, so they are never any process's argument; a name the shell cannot
    export is skipped and logged by NAME, never half-written. The script deletes
    itself before `exec` (`sh` already holds it open), and every failure path
    before that — tmux refusing, the pane dying at once on ETXTBSY — removes it
    too. Invariant 29's ordering survives unchanged: strip the CLAUDE* markers,
    then the profile's env, then `FORCED_CLAUDE_ENV` last. Independently,
    `tmux()` now never lets its arguments into an error (`tmuxErrorMessage`):
    `send-keys` carries the user's prompt text, which has no place in one either.
    The tests RUN the generated script rather than read it — a hostile value
    (quotes, `$`, backticks, a newline) arrives byte for byte, the forced vars win
    over a same-named secret, the file is gone — and one spawns a real tmux pane
    carrying 40 KB of secrets, the shape that used to be refused. Sabotaging the
    export order turns both that test and the source scan in
    `test/transcript-persistence.test.ts` red.

37. **An agent may attach a secret it CREATED, and that word is the whole
    security boundary.** The vault is global — one file for every profile and
    every instance — so "let an agent attach a secret to its profile" is one
    rule away from "any agent grants itself every credential on the machine".
    The rule is provenance: `PUT /secrets` records the creating PROFILE in a
    sidecar (`~/.shadok-ai/secret-origin.json`), and `PUT /profiles/secret`
    attaches a name only when that origin equals the caller's own profile. An
    agent therefore gains NO access it did not already have — it held that value
    already; it only makes it survive into its next sessions. Three details
    carry the weight. The origin is recorded **only on a creation**, never on an
    overwrite, or an agent could clobber a human's secret to become its
    "creator" and then claim the name. A **missing** origin means a human stored
    it, which must read as a refusal — absence denies, it never grants. And the
    lead profile gets **no exception**, deliberately unlike `promptEditVerdict`:
    editing any prompt gives the lead nothing it lacks (it can already spawn a
    full-access agent), whereas handing out vault secrets would. The value lands
    in the env at the **next spawn**, so the skill pairs it with `shadok-reload`
    — a live process's environment cannot be changed. Unchanged, and worth
    repeating: this is soft isolation. An agent with a shell can still rewrite
    `profiles.json` itself (cf. the profile-guardrail invariant).


38. **A job every agent runs periodically must not cost in proportion to GLOBAL
    state.** The tail re-resolves each transcript's path about once a second, to
    follow a `.jsonl` that Claude Code re-homes when an agent switches worktree.
    That search (`newestTranscriptById`) lists `~/.claude/projects` and stats the
    session's file in EVERY directory — so its cost was agents × directories, and
    on a long-lived instance both only grow: every worktree an agent creates adds
    a directory for good. On the instance that develops shadok (61 agents, 224
    directories) that one search was ~24% of a CPU core, half of the server's
    use, and the reason that instance cost five times more than BioSense with
    twice the agents; nothing was wrong, it simply got worse by existing.
    Two fixes, each measured against the production code on those 224
    directories, with an identical result before and after. The miss is the
    common case — the file lives in exactly one directory — so it is reported
    with `statSync(…, { throwIfNoEntry: false })` instead of a thrown-and-caught
    exception: 3.99 ms → 1.23 ms per search. And the search runs only when it can
    find something: a transcript that is still growing has not moved, so
    `resolveStep` never searches while the file grows, keeps the old ~1s cadence
    while it is missing (a new session, where finding where it lands is the
    point), and backs off exponentially to a ~10s cap while it is silent. An idle
    agent goes from 60 searches a minute to 8, and 61 idle agents from ~24% of a
    core to ~1%. The one visible cost is bounded and deliberate: an agent that
    sits idle and THEN switches worktree shows its first new message up to ~10s
    late; a move right after activity is still caught within ~1s.
    The general rule: before adding a per-agent timer, ask what it costs when the
    machine has ten times the agents and ten times the history — the product of
    the two is what a server that runs for weeks actually pays.

39. **A LARGE prompt is recorded inside `<pasted_content>`, and the history must
    UNWRAP it, never drop it — the ledger push is what pushes ordinary prompts
    over that line.** Claude Code's TUI wraps a big pasted input as
    `<pasted_content id="…">…</pasted_content>` in the transcript. `userPromptText`
    (`src/extract.ts`) dropped any user message starting with `<` — a guard meant
    for injected `<system-reminder>` blocks — so such a prompt vanished from the
    web history **while the agent had answered it**: the reply is there, the
    question is gone. Invisible until the ledger became on by default (invariant
    for `ledgerEnabled`): the server prepends a `⟦ledger · N updates⟧` delta to
    every prompt, and a fat delta (49 rows, ~1 KB) routinely tips an otherwise
    small prompt over the paste threshold — so the whole assembled prompt (ledger
    + `⟦platform·time·who⟧` meta + the user's words) lands inside one
    `<pasted_content>`. Found on biosense, 2026-09-22: the transcript's last human
    turn began `\n\n<pasted_content id="71ed">\n⟦ledger …`. The fix peels the
    wrapper tags (open + close, with or without the echoed id) BEFORE the
    `<`-guard and keeps the inner text; the ledger/meta headers it exposes are
    stripped downstream as usual. Only `pasted_content` is unwrapped — a genuine
    `<system-reminder>` is still dropped. Not caught by `tsc`/most tests because
    the fixtures were small; it takes a prompt big enough to be paste-wrapped,
    which the default-on ledger now produces constantly.

36. **A start that fails must take its watchers with it — and a short id is not a
    session id.** One outage, three links, each survivable alone (2026-10-12).
    **The id.** Ids are shown 8 characters long everywhere, so that is what a
    caller hands back. `start` passed `msg.resume` verbatim, and
    `claude --resume 113f3745` does not resume: it opens Claude Code's "Resume
    session" PICKER — no prompt, no `❯` — in a pane named after the truncated id.
    `resolveResumeId` (`src/channels.ts`) resolves a unique prefix against the
    registry and refuses the rest (`error.code: "resume-refused"`), invariant
    17's rule applied to sessions.
    **The leak.** `pilot.start()` arms the pane poller before anyone knows the
    TUI will come up. When `attachPilot`'s readiness wait timed out, the session
    was never registered — so nothing ever stopped that poller, the 300 ms screen
    timer or the tail. Every retry added a set. Two picker panes ended up taking
    nine tmux captures in ten; the captures are synchronous, so the event loop was
    saturated and `/version` took 4–8 s. `attachPilot` now tears down what it
    armed and calls `pilot.abandon()`, which KILLS a pane this pilot created and
    only stops watching one it ADOPTED — that one may be a live agent on a server
    too slow to see it in time.
    **The symptom, somewhere else entirely.** A slow server reads every paste as
    late, so `typeIntoBox` ran its recovery on prompts that had landed fine — and
    Ctrl-U clears ONE line, not the box (two lines take three presses). The
    header line survived and the retry pasted after it: agents received
    `⟦header⟧⟦header⟧` with no text, or nothing, for nine days, crons included.
    The recovery now presses until the box reads clear. What made it hard to see:
    the terminal view writes keys straight to the pane and kept working, the
    wedged panes had no channel and were absent from `/live`, and nothing was
    logged. Measure the server (`time curl /version`) before suspecting the page.

40. **A setting the CLI merely WARNS about is one we must validate ourselves —
    and `--effort` is one.** `claude --effort bogus` does not fail: it prints
    `Warning: Unknown --effort value 'bogus' — ignoring it and using the default
    effort. Valid values: low, medium, high, xhigh, max.` and runs at the
    default. That warning goes to a tmux pane nobody reads, so an unvalidated
    level makes the cockpit show a thinking effort the agent is not running at —
    visible only on the bill. Hence three gates for one field: a `<select>` built
    from `EFFORT_CHOICES` rather than a free-text box (the `Model` field next to
    it IS free text, because any model string is either valid or loudly
    refused), an `isEffortLevel` whitelist on `PUT /profiles` and `set-effort`,
    and a last check inside `profileArgs` — the single place every spawn passes
    through. There, a bad value is DROPPED rather than replaced by the role's:
    falling back would run the agent at an effort nobody chose. The class
    generalises to any future flag: before exposing one, check whether the CLI
    refuses a bad value or absorbs it, because only the first case lets us skip
    validating. **And there is no thinking on/off to expose at all** — on current
    models thinking is always on, and `alwaysThinkingEnabled: false` /
    `MAX_THINKING_TOKENS=0` are ignored by them, so such a toggle would be a
    control that changes nothing.

41. **A per-client message spelled by hand in several places WILL drift — the
    `profile` message had already.** Its two connect-time `send`s wrote the
    object inline and omitted `model`, so a reconnecting tab reset its model to
    `null` and the agent menu announced "profile default" over an agent running
    on Opus, until some unrelated change rebroadcast it. Nothing was wrong at the
    only site anyone reads, `broadcastProfile`. Adding `effort` beside it would
    have doubled the bug, so there is now ONE builder (`profileMessage`) and the
    three call sites use it. The same class, client-side: the secrets panel
    rebuilds a profile body BY HAND to toggle one secret, and every field missing
    from that body is silently reset — which is why `effort` had to be added
    there too, or ticking a secret would have wiped a role's effort.

42. **The web tab turns busy only when the server's `working` comes back — so a
    fast second Enter sends a SECOND raw prompt the server refuses.** The
    client-side twin of invariant 36 (which hardened the PILOT against the same
    two-fast-messages case). `submitPrompt` renders the turn and clears the box
    OPTIMISTICALLY but never sets `t.status` — that flips to `"busy"` only on the
    server's `working`. In the gap between the send and that event (a few hundred
    ms), the submit handler still saw `"ready"` and fired `submitPrompt` AGAIN;
    the server, already mid-turn, refused the second with `code:"busy"`
    (`a response is already in progress`) — but the box was already cleared and
    the bubble already drawn, so the message was **lost with a confusing error**.
    Reproduced deterministically (two frames, both `type:"prompt"`) and fixed
    with `t.awaitingTurn`, set the instant a prompt is sent and cleared on
    `working`/`turn-done`/terminal: while it is set, a further Enter is QUEUED
    (`queueForNextTurn`) instead of re-sent, and flushed on `turn-done`. The
    queue is a FIFO (`t.sendQueue`), not a single slot, so SEVERAL quick messages
    all survive and arrive in order — the single-slot `t.preempting` it replaced
    dropped all but the last. The deliberate mid-turn takeover (status already
    `"busy"` → `preemptTurn`, Escape + queue) is unchanged: only the gap now
    queues rather than interrupting, since the turn is barely starting. A turn
    that dies before flushing (`error`/`exited`/`gone`/`pace-blocked`) hands the
    queued text back to the box (`drainQueueToBox`), never strands it. Verified
    end to end against a live agent: two fast messages both answered, no refusal.
    **And the latch must drop when the LINK dies, not only when a turn settles.**
    A reattach sends `working` only `if (session.busy)` — so a socket drop INSIDE
    the gap whose turn then finished while the client was away leaves no event at
    all to clear `awaitingTurn`: every later Enter queued behind a turn that will
    never end, with the box cleared, the draft dropped, nothing on the wire and
    nothing on screen — the very silent loss this invariant exists to kill, and a
    reload does not recover it. `scheduleReconnect` (the socket that owed us the
    `working` is gone) and `ready` (which asserts the process is idle NOW) both
    drain the queue back to the box and say so. Measured in a browser against a
    server replaying that exact reattach: unfixed, the second message never
    reaches the wire; fixed, it does — as it does on the code before this change.

43. **A dialog card must say what the TUI says above the question — the BODY is
    what a person approves by.** Claude Code 2.1.310 added a line to file-read
    permission prompts: `This will read <target> (outside working directory) via
    a symlink`. Upstream added it precisely so a person can judge the request,
    and the cockpit dropped it: the `dialog` message carried the question and
    the options, nothing else, so a human approving from the web or Telegram
    could not see that the read escaped the working directory, while the same
    human at the terminal could. `detectDialog` now returns `body` — the box's
    text between its top `────` rule and the question — and both clients render
    it above the question (`renderDialog`'s `.dialog-body`; Telegram's
    `dialogText`, which cuts the body's tail and never the question).
    What hid it is worth keeping: the card LOOKED complete. Since the `╌╌╌`
    rules became decor (`FRAME_LINE`, PR #258) the question reads a clean "Do
    you want to proceed?", and the walk stops there — so everything above it,
    the target and the disclosure, was simply never read. A clean question is
    not a complete card.
    Three rules came with the fix. **The box is bounded by its top rule**: the
    question walk used to run up the whole screen, which is how the
    model-safeguards form (its text all behind a `│` gutter) got a transcript
    line from ABOVE the box as its question; when nothing but a gutter block
    sits above the options, that block is the question. No rule found → the old
    unbounded walk and no body, since the box cannot be told from the
    transcript. **Rejoin wrapped lines from the geometry**, not by a fixed
    separator: a token too long for any row was cut mid-token (glue it, or a
    path acquires a space), a next word that would not have fit is a word wrap
    (a space), anything else is the TUI's own line break (kept). **The body is
    not part of `dialogKey`** (invariant 21): it is description, and a
    description that repaints must not re-announce a question. It is also what
    `settleStep` ends a wait on — and a body DOES repaint: the auto-deny
    countdown ("will automatically deny this request in 1:43") lives in it, so
    a body in the key would never hold still and the wait would never settle.
    The options were already right and are pinned as they parsed before this
    change, against five real 100-column screens in `test/fixtures/dialogs/`
    (local username replaced by one of the same length, so every wrap lands
    where it did). The card shows the body as first published, so a countdown
    in it is frozen at that second — still the right warning, not a live clock.

44. **In a container, pid 1 is ours and pid 1 is the only reaper — so every
    orphan an agent leaves becomes a permanent zombie.** The supervisor is pid 1
    (`docker-entrypoint.sh` execs it), and Node waits only for children it
    spawned itself. A process whose own parent exits is re-parented to pid 1, so
    nobody ever waits for it: it stays in the process table as a zombie for the
    life of the container. Agents produce those by the thousand without doing
    anything wrong — a backgrounded `sleep` loop whose shell was killed, an
    `esbuild` service left behind, a `gh` that outlived its `bash`.
    The reason this ran for months unseen is that a zombie is almost free: no
    memory, no CPU, no log line, nothing on screen. It costs one pid slot. So
    the only symptom is the end state, and the end state is total: once the
    cgroup's pid budget is spent the container cannot fork AT ALL — no new
    agent, no `git`, no shell, including for whoever is trying to diagnose it.
    Measured on the fleet (2026-10-25, every container, none with `--init`):
    the two-month-old instance held **79,055 zombies of a 113,098 pid budget**
    (70%), a nine-day-old one 39,121 — all with ppid 1, 55% `sleep`, 27%
    `bash`, 13% `esbuild`. An earlier look at the same numbers was recorded as a
    live "process leak" of sleep/bash/esbuild and sent the diagnosis towards
    polling loops that were never terminated; they were already dead. **A pid
    count is not a load measurement** — read the state column before concluding.
    The fix is to not be pid 1: the image enters through `tini`
    (`ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]`), which reaps
    orphans as they appear and forwards signals, so the supervisor's exit codes
    — which decide a restart, cf. the SIGTERM path — are unchanged. `docker run
    --init` is the same thing for an image that lacks it. Two operational
    consequences, both learned here: it is decided at **creation**, so a
    `docker restart` empties the table (pid 1 restarts) while the leak starts
    over, and only a recreate ends it; and `src/lock.ts` already carried the
    other half of this fact — it must treat a zombie as dead, "because in a
    container pid 1 is the application rather than an init that reaps" — which
    is a workaround for a cause nobody had removed.
    Reproduced minimally on the same host, three runs of one image: with node
    as pid 1, a single orphaned `sleep` leaves one zombie; with `tini` as pid 1,
    and with `docker run --init`, it leaves none.
45. **A pid number is not an identity — and in a container it is handed out
    again on every restart.** The single-instance lock wrote the holder's pid
    and nothing else, and `pidAlive` answered the only question it could: is
    *some* process wearing that number. Those two questions come apart exactly
    where it hurts. A container's pid namespace restarts at 1, the supervisor's
    own children take the first dozen slots and the server itself lands around
    15 — so the number the previous run wrote is, next boot, almost certainly
    worn by an unrelated process. Observed in production while restarting a
    container: `another instance is already running from this directory (pid 14)
    — exiting`, where 14 was a node the supervisor had just spawned, and the
    real previous server was long dead.
    The failure is the quiet shape again. That refusal **exits 0** on purpose
    (so a supervisor reads a clean stop and does not crash-loop, cf. the SIGTERM
    path), so the container simply stays down with one line in the log and
    nothing wrong anywhere else: the cockpit is gone, every agent with it, and
    the next person to look finds a stopped container and no cause. It is also
    a coin flip, which is worse than a bug that always fires — a restart that
    works proves nothing about the next one.
    The fix is to record WHO, not just WHICH slot: the lock line is now
    `<pid> <starttime>` (field 22 of `/proc/<pid>/stat`, ticks since boot), and
    a live pid whose start time differs from the lock's is a different process,
    so the lock is stale and reclaimed. A reused pid would have to have been
    born on the same tick as the holder. Three properties are deliberate: the
    line still STARTS with the pid, so a lock written by this version is read
    correctly by an older one; a lock carrying no start time keeps the old
    pid-only verdict (there is nothing to compare, and the next successful
    acquire rewrites it); and where there is no `/proc` at all the pid's answer
    still stands, as it already did for the zombie case.
    This became reachable the moment restarts became routine — invariant 44's
    campaign gives every container a small lock pid on its way out, which is
    precisely the collision-prone range.

46. **A password alone must never register a passkey — and two-factor is only
    as strong as the weakest door around it.** Three doors were open the day it
    was designed, and each would have made the second factor decoration.
    *Enrollment by password*: if a correct password could register a passkey
    while 2FA is on, a thief with the password enrolls their own phone. So
    registering during sign-in needs an enrollment code minted by a verified
    session (yours, an admin's, or a redeemed invitation). *The bootstrap
    admin*: `SHADOK_GUI_PASSWORD` is in every agent's env and nobody can reset
    it, so under 2FA it has no browser session at all. *The agent's key*:
    `x-shadok-session-key` IS the bootstrap admin, so while 2FA is on every
    account and `/2fa` route goes through `cookieAccount`, which accepts neither
    a session key nor a peer — otherwise an agent (or a prompt injection
    driving one) could reset anyone. Actions that would undo the factor for
    someone (reset, a code for another person, switching on/off) also need a
    FRESH passkey assertion, not a session: a session can be ridden, a
    biometric cannot. Switching it on kills every session issued before (the
    cookie's `mfa` field). And the rest stays true: anything running as the
    machine's user can read the account file — soft isolation, as invariant 26.
    Verified end to end in Chromium with a CDP virtual authenticator.
    **A fourth door was shut from the inside: our own Telegram bridge.** It is
    the one caller that authenticates with a cookie and is not a person — a WS
    to our own server carrying `adminCookie()` — so "no `mfa` flag, no entry"
    plus "the instance password cannot sign in" refused it too: with 2FA on,
    `GET /live` and the WS upgrade both answered 401, the bot kept long-polling
    Telegram, and every message died at the gate with nothing in the log. The
    spec had listed it as unaffected, next to the peers (which really are:
    `x-shadok-peer` is read before the cookie). A browser-shaped rule judges
    every machine that speaks the same credential, so each one needs a named
    principal: the bridge's cookie is minted `mfa=1` and `currentAccount`
    recognises it through `isInternalClient` BEFORE `cookieAccount`, which still
    refuses the bootstrap admin — Telegram works, `/2fa*` stays person-only. The
    flag stays meaningful because minting it needs the signing secret, which no
    login path uses for the instance password and which never reaches an agent's
    env (`SHADOK_AUTH` keeps `mfa=0`, hence refused). Measured both ways on a
    real instance, not reasoned: 401/401 before, 200 + `/2fa` 403 after.

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
- **A test that HANGS is worse than one that fails, so `npm test` carries
  `--test-timeout`.** `node --test` has no default timeout, and a test that
  throws *before* its teardown leaves whatever it opened open — a listening
  socket is enough that node never exits. The runner then waits forever and the
  suite reports **nothing at all**: no pass count, no failure, no clue which
  file. `test/heartbeat.test.ts` did exactly that, from an assertion that was
  ~5% flaky under load (measured: 3 hangs in 60 runs, the sweep timer racing the
  pong's own round trip). One run sat wedged for eleven hours; ten orphan node
  processes were still alive when it was found, the oldest from mid-August. Two
  halves, and both are needed: teardown goes in a `finally` — the rule for any
  test that opens a socket, a tmux pane or a child process — and the timeout is
  the net for the next one that forgets. The whole suite runs in ~20s, so 120s
  per test only ever catches a hang.
