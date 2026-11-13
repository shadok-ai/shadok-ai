# CLAUDE.md — shadok-ai

Read this first. It exists so you can evolve shadok-ai **without re-scanning
the whole codebase** and **without repeating the mistakes already made**.
Keep it up to date when you change architecture, invariants, or the protocol.

This file is the **map and the rules**, kept small on purpose so it costs
little context. The **detail** lives one hop away and is load-bearing, not
optional: the full war stories behind each rule in
**[`docs/invariants.md`](docs/invariants.md)**, the per-file and per-subsystem
deep dive (and the full `/ws` + HTTP reference) in
**[`docs/architecture.md`](docs/architecture.md)**. The invariant NUMBERS here
are stable cross-reference handles ("see invariant 32") into that file — do not
renumber them. **Before you change a subsystem, read its architecture section
and the invariants it cites.**

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
PORT=3899 SHADOK_VERSION_CHECK_MIN=0 SHADOK_SEED_SKILLS=0 node dist/server.js
```

Four properties make that safe, and all four are load-bearing — change one and
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
- `SHADOK_SEED_SKILLS=0` stops the boot from rewriting the **machine-wide** skill
  scripts (the server HOME's `~/.claude/skills`, plus `/etc/claude-code/.claude/skills`
  in multi-tenant). Those live OUTSIDE your tree and are refreshed at every boot,
  so without this your build hands every agent on the host — the production
  server's included — scripts newer than the server they call. Measured: the
  ledger skill began posting a route the running build did not serve, so `record`
  answered 404 host-wide while `check` kept working. See invariant 57.
- When your shell exports `SHADOK_GUI_PASSWORD` / `SHADOK_HOST` (an agent's does),
  launch with `env -i HOME=$HOME PATH=$PATH PORT=3899 SHADOK_VERSION_CHECK_MIN=0 node dist/server.js`
  — otherwise the side-by-side build silently becomes a password-gated (and, on a
  capable host, multi-tenant) instance.

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

A quick per-file index. The FULL responsibility of each file — the war stories, the invariants it owns, the traps — is in **[`docs/architecture.md`](docs/architecture.md)** (per-subsystem deep dive) and its module table there. Read that before changing a file here.

| File | Responsibility (one line) |
|---|---|
| `src/server.ts` | HTTP + WebSocket server. Session registry (`sessions` Map), the `Live` object, the WS message handlers, all endpoints. |
| `src/live-handover.ts` | `supersedeSession(old, next)` — the ONE-`Live`-per-agent rule (invariant 55). |
| `src/session.ts` | `PtyPilot` — drives `claude` in a node-pty PTY + `@xterm/headless`. |
| `src/claude-bin.ts` | Makes sure a RUNNABLE `claude` is there before every spawn, and says which binary that is. |
| `src/node-pty-fix.ts` | The OTHER `posix_spawnp failed`: node-pty's prebuilt `spawn-helper` must be `chmod +x` to run. |
| `src/tmux.ts` | `TmuxPilot` — same interface as `PtyPilot`, but runs `claude` in a detached tmux session (`sk-<sessionId>`). |
| `src/tmux-install.ts` | Auto-installs tmux at boot when it's missing, so the durable transport is the default without setup (node-pty agents die on every auto-update). |
| `src/tail.ts` | Tails a session's `.jsonl` transcript → streams assistant text/tool_use/tool_result + token usage. |
| `src/extract.ts` | Parse the transcript / screen: `loadHistory`, `detectDialog`, `listSessions`, `findSessionId`, `transcriptFilePath` (the shared `<id>.jsonl` resolver, reused by `GET /download`). |
| `src/download.ts` | Files an agent hands the user via the harness `SendUserFile` tool (`tool_use` name `SendUserFile`, `input.files` = absolute paths). |
| `src/whisper.ts` | Local speech-to-text for Telegram voice notes, provisioned ON DEMAND at the first voice message and never at boot — the live VPS builds its images from a host-side Dockerfile of its own, so anything baked into the repo image reaches no running instance, while a first-use download reaches every instance the moment it updates. Every artifact is pinned by SHA-256 (ffmpeg per asset, the whisper.cpp tarball, the model at a fixed HF commit) and verified on the temp file BEFORE the rename (`downloadVerified`); a cached file is hashed once (`verifyCached`, marker void on size/mtime change); a non-pinned `SHADOK_WHISPER_MODEL` needs `SHADOK_WHISPER_MODEL_SHA256` or is refused. |
| `src/video.ts` | What makes a shared VIDEO readable. The bug it fixes is one level up (`attachmentOf` did not know `msg.video`, so `handleMessage` dropped the message in silence — a video carries no `msg.text` at all), but recognising it only trades a silent drop for an honest dead end: nothing in `Read` opens an mp4, and the image has no `ffmpeg` on `PATH`, so an agent handed a path cannot help itself either. |
| `src/files.ts` | Files an agent OFFERS the user through shadok's own path, beside the harness's `SendUserFile`. |
| `src/bang.ts` + `public/bang.js` | Running an agent's `!` command from the chat, on the HUMAN's behalf. |
| `src/detect.ts` | `screenShowsWork(screen)` — the fragile "is Claude working" heuristic. |
| `src/backend.ts` | Which model backend an agent talks to: the subscription, or a CUSTOM one (a self-hosted open model, a gateway) reached through Claude Code's own `ANTHROPIC_BASE_URL`. |
| `src/glance.ts` | A row's "xxx ago" + context % from the transcript's TAIL — `GET /channels/glance`, so the list fills at boot before the agents resume. |
| `src/context.ts` | How full the model's context window is, from the TRANSCRIPT's token usage — `contextTokens` (input + cache creation + cache read; output excluded), `windowForModel` (the `[1m]` SETTING, never the model name), `effectiveWindow` (an over-run PROVES the assumed window too small → promote), `pctFromUsage`. |
| `src/worktree.ts` | Git worktree isolation: create, diff, list past sessions, recreate a reclaimed checkout. |
| `src/worktree-relocate.ts` | Pure `strandedWorktreePlan` — which agents' worktrees are stranded under the server tree after an INTERRUPTED multi-tenant migration (unreachable by their drop user → "stuck on root"), and the canonical home each belongs in. Drives `healStrandedWorktrees` (`server.ts`, in `ensureGroupsProvisioned`, marker-independent): copy the checkout to the drop user's home, `git worktree repair`, chown, carry the transcript, repoint the channel, then drop the stale source — fail-safe (copy before delete) and idempotent. Companion to `reassertCommonsRepoOwnership`, which completes the launch-repo `chown` on the same boot. Tested. |
| `src/git-exec.ts` | `gitIn` — the server running git in a checkout ANOTHER user owns. Under multi-tenant the server is root and the Tweak self-clone / an agent's worktree belong to a drop user, which git refuses as "detected dubious ownership" (the second *Tweak Shadok-AI* click died on it, and `isGitRepo` silently read the refusal as "not a repo"). On that refusal ONLY, the command is re-run as the directory's owner (`setpriv` to its uid/gid, its HOME) — never whitelisted with `safe.directory`, because the repo's `.git/config` is agent-writable and can name `core.fsmonitor`, a filter or a hook that git EXECUTES: whitelisting it would run an agent's command as root. Every invocation that works today runs unchanged. `createWorktree` hands the parent dirs it creates to that owner, or `worktree add` (now running as them) cannot write there. Pure cores tested; the root-vs-owner path is exercised for real when the suite runs as root. |
| `src/selfrepo.ts` | The working copy of shadok-ai's OWN source (`<stateHome>/.shadok-ai/self/shadok-ai`) behind the "Tweak Shadok-AI" CTA: anonymous clone (no auth needed to start), `main` hard-reset to the remote on each use, never the launch directory. |
| `context/tweak-prompt.md` | Role of the tweak agent, written for the person it answers to rather than for the procedure: the non-developer rule comes FIRST and governs the rest (a named banned-words table — pull request / branch / CI / diff — with what to say instead, a three-line answer budget, never hand back a technical decision), and the job ends when the change is VISIBLE, not when it is merged — so the agent reads `updateChannel` / `autoUpdate` off `/version` and never promises a beta instance something only a release will bring. |
| `context/tweak-pr-check.sh` | The cron guard behind that watch, seeded to `~/.shadok-ai/` at boot (`seedTweakPrCheck`) — outside the agent's worktree, which is pruned once its tree is clean. |
| `src/connect-crypto.ts` | Instance half of the connected-accounts hand-back: `newAttempt` (ephemeral ECDH key + nonce), `decryptPayload` (HKDF-SHA256 + AES-256-GCM, nonce as AAD), `PendingAttempts` (10 min, single-use). Pure, tested. |
| `src/connect-routes.ts` | Pure helpers for `/connect/*`: broker URL (`brokerBase`, `brokerStartUrl`), the fragment parser (`parseConnectHash`), outcome mapping, and the gates `connectedMember` / `connectReadAllowed`. |
| `src/connected-accounts.ts` | The connected-account store, `publicView` (the ONLY projection that leaves it — never a token), `accountVisible` (share = a union of Personal / groups / Everyone + an optional profile filter, `normalizeShare` reads the v1 single-choice form; Everyone deliberately does NOT reach other people's private groups), `accountEditVerdict`. Mono-tenant = soft layer, and `agentsUnwalled` (passed at EVERY call site as `DEPLOYMENT_MODE !== "multi-tenant"`) lets every agent use every account there — without it a fresh `private` account was invisible to all agents. |
| `src/linkedin.ts` | LinkedIn API calls; `LINKEDIN_VERSION` must be bumped about yearly (LinkedIn sunsets versions). |
| `src/google.ts` | Google client (twin of `linkedin.ts`): `GoogleTokens` refreshes through the broker (< 5 min left, one in flight per account, `invalid_grant` → expired), plain-`fetch` Calendar / Drive (`drive.file`) / Docs / Sheets / Gmail calls, and the server-side RFC 2822 builder (CR/LF refused in header fields, RFC 2047). A Google account's `expiresAt` is the HOURLY access token's — the reconnect deadline is `accountDeadline` (`refreshExpiresAt`); never read `expiresAt` as "expired". |
| `src/google-actions.ts` | The action class table (`GOOGLE_ACTIONS`: read / own-write / mail / calendar) — the CLASS decides which of the account's two settings (`policies.mail`, `policies.calendar`) applies; `runGoogleAction`, and the Gmail approval cycle (`approveGoogleDraft`: the Gmail draft IS the draft — unchanged → sent, edited in Gmail → card refreshed and asks again, deleted → `gone`). Reading mail (`gmail.search`, `gmail.read`, area `gmail_read`) is a read that IS logged (`actionLogged`: query / message id + subject, never a body) and whose output the skill fences as untrusted content; `gmail.draft --update` only rewrites drafts recorded in `ownGmailDrafts`. |
| `src/social-drafts.ts` | Drafts of ACTIONS (`{provider, action, payload}` — a LinkedIn post, an email, a calendar change) + publication log; a Google entry logs a summary, never a mail body. Drafts + log (`accountLog` reads it back for `GET /connected-accounts/:id/log`). `publishing` is saved BEFORE LinkedIn is called. A draft's image is SNAPSHOTTED at draft time (`<key>.media/<draftId>.<ext>` + sha256) and both the card and the publish read the snapshot — re-reading the agent's path would let it swap the file after approval. |
| `src/account-expiry.ts` | Hourly no-LLM expiry watch (`setInterval` in `server.ts`): warns the owner 7 days before expiry and re-warns at most once a day (`REWARN_AFTER_MS`, 24h), expired drafts. `stalePublishing` sweeps a dead process's leftover `publishing` drafts to `failed`, never retries. The DM goes to the operator only and is stamped `warned` only once sent; every owner gets the page banner via `ownerExpiryFlags`. |
| `public/social-card.js` | Pure helpers for the approval card and the Connected accounts panel. ESM, browser + tests. |
| `context/social-skill/` | The `shadok-social` skill (`social.mjs accounts` / `post --stdin`), seeded like the others; authenticates with `x-shadok-session-key`. |
| `context/google-skill/` | The `shadok-google` skill (`google.mjs accounts` / `calendar` / `drive` / `doc` / `sheet` / `gmail`), twin of `shadok-social`: `x-shadok-session-key`, content on stdin never argv. |
| `context/connect-done.html` | The page the broker returns the browser to; outside `public/` on purpose (it carries the nonce marker). |
| `broker/` | The stateless Cloudflare Worker that holds the LinkedIn client secret (`broker/README.md`). Deployed separately, not part of the npm package. |
| `src/usage.ts` | Fetches subscription usage (5h/7d) from `/api/oauth/usage`. The Bearer should be the account the AGENTS run on, which is NOT always the live CLI store: on a multi-tenant instance the agents authenticate with the vault's long-lived `MT_CLAUDE_OAUTH_TOKEN` (injected as each agent's `CLAUDE_CODE_OAUTH_TOKEN` at spawn), while `readOAuthToken` only ever saw the credentials file / keychain / the server's own frozen env token — a DIFFERENT account. But preferring the vault token UNCONDITIONALLY blanked the gauge: a long-lived `setup-token` authenticates agents yet is not scoped for `/api/oauth/usage`, so it answers 200 with empty windows → `null/null`. So `getUsage` takes an ORDERED list of candidate Bearers (`server.ts`'s `usageToken` = vault long-lived token FIRST, then `readOAuthToken`) and `pickUsage` keeps the first that actually reports a window (`hasWindow`) — the gauge follows the agents' account when that token can report usage, and falls back to the live store / env (keeping a number on screen) when it cannot, e.g. a setup-token. `instanceLongLivedToken` reads the vault live, so a re-mint reaches the gauge within the 60s cache. `pickUsage`/`hasWindow` pure+tested; the one resolver feeds the `/usage` endpoint and both pace-guard checks. NB: a setup-token's own usage is thus not shown — only a claude.ai login token reports to this endpoint. |
| `src/gauge-login.ts` | The OPTIONAL dedicated claude.ai login that feeds ONLY the 5h/7d gauge. A multi-tenant instance's agents run on a `setup-token` (`user:inference` only), which cannot read `/api/oauth/usage` (needs `user:profile`); an interactive `claude auth login --claudeai` can. The credential lives in its OWN `CLAUDE_CONFIG_DIR` (`~/.shadok-ai/gauge/<instanceKey>/.claude`, 0700) with exactly one owner, because the refresh token ROTATES. The login reuses `createLoginFlow` (`claude-auth.ts`, parameterised by env) — no OAuth client of our own. Keep-fresh: **there is no `claude auth refresh`** (2.1.322: unknown command); the CLI refreshes lazily before a request, so `refreshOnce` runs one minimal `claude -p` on the smallest model and judges success on the credentials FILE (access expiry advanced), never on output. The refresh token has a FIXED ~1-month window (`Math.min(old,new)`: refreshing never extends it), so a manual re-login is inherent; `gaugeState`/`gaugeWarning` remind 5 days ahead. `usageCandidates` puts its token FIRST, before the vault long-lived token and the live store; `getUsage` keeps the first that reports a window, so an absent or lapsed gauge login falls through to the old behaviour. File store only (macOS keychain unsupported → row hidden). Opt-in: no credential, nothing runs. Pure cores tested in `test/gauge-login.test.ts`; spec `docs/superpowers/specs/2026-11-10-usage-gauge-login.md`. |
| `src/pace.ts` | The quota guardrail: ideal-pace computation + block verdict. |
| `src/retry.ts` | Auto-retry of turns that died on a transient API error (529, 5xx, timeout). |
| `src/channels.ts` | Server-side persistence of the channel + group lists, and the one answer to "where does this session live" — `resolveSessionTarget` / `resumeTarget` (pure, tested), which EVERY caller acting on a session's behalf goes through; on a resume the registry beats whatever the caller sent (see invariant 1). |
| `src/rooms.ts` | ROOMS — channels with NO agent, where people talk (web, optionally a Telegram topic). Its OWN registry (`~/.shadok-ai/rooms/<key>.json`, messages append-only in `<key>/<roomId>.jsonl`), never a row of the channel registry: see invariant 64. `RoomStore` + pure rules (`visibleRooms` = `visibleChannels`' group rule, `postRefusal`, `roomGroupFor`, `unreadCount`, `roomForTopic`), tested. Server: `/rooms*` routes, `room-join`/`room-post` on `/ws`, `postRoomMessage` (the one write path), `roomHooks` (what the Telegram bridge may do). People only: `roomPerson` refuses an agent key, a peer and the internal Telegram client. Spec: `docs/superpowers/specs/2026-11-02-human-rooms-design.md`. |
| `src/telegram.ts` | The Telegram bridge. `replyContext` turns a REPLY into the line telling the agent which message is answered: a highlighted fragment (`quote`) beats the whole message, a bot is named "the agent" rather than by its `first_name`, and a topic's own creation message is NOT a reply — in a forum EVERY message carries `reply_to_message` pointing at it (verified on a live payload), so without that guard every message in every topic gets a useless quote. Attachments land in `mediaDir()` (runtime-resolved, shared with `/paste`): multi-tenant relocates it under the shared pot so a privilege-dropped agent can actually open the file — `~/.shadok-ai/media` is `/root/…`, un-reachable (invariant 54's family). |
| `src/tg-guests.ts` | **Where the bot works, and the bot's door for people who are not its owner.** `TgMode` is the one choice — `group` (the classic instance and the default: a board group, DMs for their one owner), `group+dm`, `dm-only` (no board, `/setup` refused everywhere, no owner at all) — with `normalizeTgMode` reading anything unrecognised as `group`, `guestsOpen`/`dmOnly` as the only two predicates derived from it, and `groupChatRefusal` as what a group chat hears on a DM-only instance. See invariant 66 for why `dm-only` must ignore a board and an owner that already exist. The rest is **open DMs**. Pure and dependency-free, so the whole decision is unit-tested with no server: `guestEnableRefusal` (why a setup may not be saved — a PUBLIC group is no wall, a PRIVATE one is an account's sealed Personal space the bridge could never be a member of, and outside multi-tenant no non-public group exists at all), `guestPatchFlow` (the whole `PUT /telegram` decision, twin of `createGroupFlow`; a refusal carries no group list so it cannot half-write, and a change of group MOVES the instance's membership), `withInstanceMember` (how the bridge gets in — it drives as `BOOTSTRAP_ADMIN`, so the instance is written into the chosen group's members, reusing `memberOf` instead of carving an exemption; it does NOT widen the group to other agents, which are judged on their own `agentGroup`; and since that name is also the human admin's account, only a membership the flow ADDED — `GuestSetup.joined` — is ever taken back, and never the last one: `lastMemberRefusal` in `groups.ts`), `guestSpawnPlan` (the trust decision: an unproven marker is IGNORED rather than refused, a marker on a resume likewise, and only a bridge-proved marker against a shut door gets a named refusal), `guestCommandRefusal` (every command, `/start` excepted — Telegram sends it by itself) and `guestOpeningPrompt` (what that `/start` becomes instead: the opening prompt of that person's own agent, carrying Telegram's `language_code`, so the welcome is written by the profile and never by the bridge — it used to reach the command dispatcher and print the cockpit's help page to strangers), `guestCallbackAllowed`, `guestNotice`, `guestWorkDirName` (the folder that belongs to ONE guest, `tg-<telegram id>`, under the group's home — every guest shares that home, so they shared the working directory too, and with it Claude Code's per-directory memory: one person's notes were loaded by the next person's agent. Rebuilt from a plain positive integer rather than sanitised, since it is joined to a path) and `ownerAdoptionCandidate`. See invariant 65 and `docs/superpowers/specs/2026-11-11-telegram-open-dm-design.md`. |
| `src/tg-pairing.ts` | The Telegram pairing code — the only way a Telegram account binds the board group (`/setup <code>`) or becomes the DM owner. |
| `src/tg-operators.ts` | Telegram **operators** — the user ids that redeemed a pairing code (`/setup <code>` in the board, `/start <code>` via the deep link, or the DM pairing; the DM owner always counts), persisted in `…-telegram-operators.json` beside the owner file and cleared with the board's unbind. Before it, being IN the bound group was being root on the host: every member could `/secret` over any vault name, `/unsecret`, `/login` the instance into their own account, `/update` (a process exit) at will, `/mtcode`, or `/spawn` the lead profile and ask it for its env. `commandRequiresOperator` names the host-wide commands, plus `/spawn` with an EXPLICIT profile (a profile carries secrets and guardrails; a bare `/spawn` carries none); `isOperator` fails closed (no record and no owner = nobody); `/setup <code>` in an already-bound board registers the sender, which is how a legacy board gets one. Chat-driving stays open to members — messages, dialog buttons, `/stop`, `/cron` on their own topic (`cronsInScope`: a prefix used to resolve against every cron of the instance). `callbackChatAllowed` gives a keyboard click the same chat gate as a message (allowlist + bound board). `parseSecretArg` makes `/secret` refuse an existing name without a trailing `--overwrite` (`secretWriteVerdict`). Pure, tested. |
| `src/main.ts` | The `npx shadok-ai` entry point: parses flags, first-run token prompt, then runs the supervisor. |
| `src/supervisor.ts` / `src/updater.ts` / `src/update-flag.ts` | Self-update: the supervisor runs the npm-installed server as a child, restarts it on the update exit code; the updater installs the channel's resolved version into `~/.shadok-ai/app` (an EXACT version, never a tag — the caller already chose). Installs with `--ignore-scripts`; only `SCRIPT_ALLOWLIST` (node-pty) is rebuilt explicitly, in a STAGING copy swapped in once complete (`installInto`). Transitive versions are pinned by the `npm-shrinkwrap.json` that `prepublishOnly` generates (and must be in `files`). `npm i -g @anthropic-ai/claude-code` stays unpinned on purpose. |
| `src/update-channel.ts` | Which release stream an instance follows: `alpha` (every merge) or `beta` (promotions only, the default). |
| `Dockerfile` | The official image (README "Running in Docker"): Claude Code + shadok-ai + a bundled headless browser (Playwright Chromium at `/opt/playwright-browsers`, `--with-deps` so the OS libs are present), plus `git`/`gh`/`tmux`/toolchain. |
| `src/open-browser.ts` | Opens the cockpit on launch. Done by the SERVER, not the supervisor, because only it knows the port the walk landed on (`START_PORT` is where the walk BEGINS). |
| `src/instance-context.ts` | The instance context: one short text per launch dir every agent gets at spawn BEFORE its role — general before specific (`instanceContextArgs`). Humans edit it (`PUT /instance-context`, browser + admin); the lead writes it ONCE while empty (`firstWriteVerdict`, `PUT /instance-context/first`, skill `shadok-instance-context`). Excluded from the staleness fingerprint. |
| `src/prompt-args.ts` | `mergeAppendedPrompts` — the spawn passes ONE `--append-system-prompt`: Claude Code keeps only the LAST of several (measured, 2.1.319), so the role, env note, pilot prompt and ledger reflex are joined into one value. Never add a second flag elsewhere. |
| `src/preprompt.ts` | Pure `prepromptParts` — what shadok adds to an agent's context, as labelled sections with their source. |
| `src/auto-reload.ts` | Pure `autoReloadVerdict` — applies a pending "reload to apply" by itself, only when the respawn would cut nothing (idle, no dialog, empty input box, no background task/queued notification, quiet 2 min, 30-min backoff). |
| `src/submit-recovery.ts` | What happens when an agent's TUI stops taking input while its process stays alive (an upstream bug class a restart cures). Pure `submitRecoveryVerdict` + `submitWithRecovery`: on a `SubmitError` from the `prompt` path — restart through `restartSession` and re-deliver ONCE; never while a turn runs, a question is up, or the transcript shows the prompt landed; 10-min per-agent cooldown. Unrecoverable → an agent report filed by the server (admins + Telegram owner) and `error` `code: "unresponsive"` with a true message, incl. the guest wording. `SHADOK_SUBMIT_RECOVERY=0` disables. See invariant 68. |
| `src/csp.ts` | The Content-Security-Policy (`cspHeader`) and the nonce injection into the page (`injectNonce`, marker `__CSP_NONCE__`). |
| `src/net.ts` | Where we listen and who may speak: `resolveHost` (`SHADOK_HOST`, loopback by default), `bindRefusal` (fail-closed: no network bind without a password), `originAllowed` (same-origin, see invariant 11), `hostHeaderAllowed` (the DNS-rebinding Host allowlist, strict only without a password or with `SHADOK_ALLOWED_HOSTS` — invariant 62), `clientAddress` / `requestIsHttps` (forwarding headers believed only from a loopback/private hop). |
| `src/login-limit.ts` | `AttemptLimiter` — failed `POST /login` and enrollment-code attempts per address and per account, in memory, refused with 429 BEFORE hashing. Pure over a clock, tested. |
| `src/heartbeat.ts` | Keeps idle `/ws` connections alive behind a reverse proxy: an idle agent sends no traffic, so a proxy (nginx `proxy_read_timeout` 60s, Cloudflare ~100s) cuts the socket and the client loops on "reconnecting" — with nothing actually broken. |
| `src/config.ts` | `~/.shadok-ai/config.json` (600): port, per-launch-dir Telegram token/allowed chats/on-off, GUI password, `autoUpdate`, `permissionMode`, `timezone`, `cockpitTitle` (per-launch-dir display name, `titleForCwd`/`setTitleForCwd` — the header brand + browser tab, so several cockpits stay apart), `cockpitTheme` (per-launch-dir colour palette key, `themeForCwd`/`setThemeForCwd`, validated against `COCKPIT_THEMES`; default/unknown → cleared), and `cockpitMuted` (per-launch-dir instance-wide mute, `mutedForCwd`/`setMutedForCwd` — `true` = no web attention signal for ANY agent, the shared twin of `Channel.muted`; false stored as absent). Written ATOMICALLY (`writeConfigFile`: temp file + rename) and never over a file that exists but does not parse (`readConfigFile` tells *unreadable* from *absent*): the old in-place write could be read half-done, `loadConfig` turned that into `{}`, and the next ordinary save wiped every token and setting. |
| `src/webhooks.ts` | Webhooks: `POST /hooks/<id>` + per-hook bearer token (SHA-256 stored, one 404 for every refusal) wakes an agent through the cron path (`driveChannel`), body fenced as untrusted. Management (`/webhooks`) is browser-person only. |
| `src/channel-triggers.ts` | What goes away WITH a closed channel: pure `splitBySession` / `triggerCount` / `triggerSummary` over anything keyed by `sessionId` (schedules, webhooks). They take an id and nothing else, so they cannot ask whether a process is running — the delete is decided by `endChannel` (`forgetChannelTriggers`, `server.ts`), on an explicit close only. See invariant 67. |
| `src/crons.ts` | Per-channel scheduled prompts (`~/.shadok-ai/crons/<enc>.json`) + the deterministic `check` that avoids waking the LLM for nothing. |
| `src/lock.ts` | Single-instance lock, keyed by launch dir: two servers from the same directory share a registry and a Telegram bridge, so the second refuses to start. |
| `src/kinship.ts` | Who launched whom, and what a parent is told about it. |
| `src/promptmeta.ts` | The context header prepended to a HUMAN prompt (web/telegram/cli/agent/peer) before it reaches the TUI: `⟦platform · time · who⟧` on its own first line — ALWAYS the server's, the person's text neutralised beneath it (`markHumanPrompt` in `src/prompt-kind.ts`). Also `connectionOrigin`: a connection's origin is derived from what it proved at connect, never from the `start` frame. See invariant 61. |
| `src/secrets.ts` | Central secret vault (`~/.shadok-ai/secrets.json`, 600). |
| `src/secret-audit.ts` | The secret AUDIT log — who wrote, attached and RECEIVED which vault secret (`~/.shadok-ai/secret-audit.jsonl`, 600, global like the vault, launch dir on each row). |
| `context/secrets-skill/` | The `shadok-secrets` skill, seeded into `~/.claude/skills/` at boot (`seedSecretsSkill`, twin of `seedSchedulerSkill`): lets an agent store a credential it OBTAINED itself. |
| `context/reload-skill/` | The `shadok-reload` skill (seeded by `seedReloadSkill`, twin of the above): an agent respawns itself to pick up a changed pilot prompt or newly-seeded skills (the prompt/skills are fixed at spawn). |
| `context/files-skill/` | The `shadok-files` skill (seeded by `seedFilesSkill`, twin of secrets/reload/ledger): `send.mjs <abs path…> [--caption]` → `POST /files`, authenticated by `SHADOK_SESSION_KEY`. |
| `src/factory.ts` + `src/factory-scan.ts` + `src/factory-routes.ts` | The Skill Factory: skills written together (one bare git repo per skill, the server is the origin), scanned for secrets on every save/push, saved as a draft or **Save**d (release + accept, hidden), shared with only me / some groups / everyone — and the share IS where it runs: every agent it covers loads it as `--plugin-dir` (`availableAttachments`, derived, never given agent by agent). |
| `src/skill-usage.ts` | Pure `cronUsers` — which agents run a skill ON A SCHEDULE: crons whose prompt names it (`cronMentionsSkill`) ∪ runs recorded during a cron fire (`via: "cron"` in `usage.jsonl`). Feeds the skill card's "Used by schedules" and the agent info panel (`#infopanel`). |
| `context/factory-skill/` + `context/skillsmith-prompt.md` | The agent side of the factory: the `shadok-factory` skill (`factory.mjs pull/push/scan`) and the managed `Shadok-Skillsmith` role. |
| `context/ledger-skill/` + `context/ledger-reflex.md` | The `shadok-ledger` skill (seeded by `seedLedgerSkill`, twin of secrets/scheduler) and its gated pilot-prompt reflex, so agents stop re-surfacing what a sibling already resolved. `record`/`check` go through the server, and a **404 degrades to the local table** (announced, never silent): a seeded copy can be NEWER than the server that answers it — see invariant 57. A 401 stays loud, it means a human action (invariant 33). |
| `src/ledger.ts` | The SERVER side of the shared ledger (the skill's `ledger-core.mjs` is the agent side). |
| `src/claude-home.ts` | Seeds Claude Code's first-run state in `~/.claude.json` — the globals at boot, `projects[<cwd>]` before every spawn (a worktree is a new directory, so a new trust dialog every time) — plus an explicit `tui` in `~/.claude/settings.json`, which kills the fullscreen-renderer upsell. `seedPlanForCwds` folds the globals + MANY cwds into one object, so a shared group HOME is seeded in a single atomic write (not one racy write per spawn): the server's `preseedGroupHomes` uses it to fill every drop user's HOME before the boot resume storm, closing the shared-`/home/main/.claude.json` trust-dialog race (invariant 23's group-HOME extension). |
| `src/agent-folders.ts` + `public/agent-folders.js` | Folders of the agents INSIDE a group (nested, depth 8) — a VISUAL arrangement, never an ACL; a folder belongs to one group and is seen exactly where that group is; `/agent-folders` read and write are both filtered by the groups the viewer can see (invariant 58); an agent's `folder` rides `/channels`. |
| `src/groups.ts` | The group model and its ACL — the ONE concept the isolation feature turns on: a group is both the unit of isolation and the unit of visibility, in three `Nature`s (`private` — one person, sealed even from an admin; `restricted` — a member list; `public` — everyone, `Main` (`MAIN_GROUP_ID`) the default). |
| `src/capability.ts` | Decided ONCE at boot: is this process able to build a real wall? `probeCanProvision` (root, or passwordless `sudo -n`; `SHADOK_FORCE_MULTITENANT=1/0` overrides) AND `accountsEnabled` (a GUI password exists — accounts are what a wall is FOR) → `deploymentMode` `multi-tenant` or `mono-tenant`. |
| `src/osusers.ts` | The privileged orchestrator's OS-user lifecycle. `dropEnv` is also where the SERVER's own paths are taken back off a dropped spawn — `HOME`, `GH_CONFIG_DIR` and `GIT_SSH_COMMAND` all named something under `/root` that the drop user cannot traverse, so auth, `gh` and every `git` over SSH died there in silence. See invariant 60. |
| `src/group-exec.ts` | What the server does FOR a group, with that group's rights: who may act on a session (`mayActOnSession`), the cron guard's drop + allow-listed env (plus the one credential a dropped guard is handed, `ghToken` — without it every `gh` call in a guard failed and looked exactly like a calm repository), stat/read a file as the agent's user. See invariant 60. |
| `src/media-scope.ts` | Per-group media directories (`g-<group>`, root:<group user> 2750) and the `/media` serving rules. See invariant 60. |
| `src/privileged.ts` | Running the migration/provisioning's privileged commands (`useradd`, `chown`, `cp`). `runPrivileged(cmd, argv, {timeoutMs?})` — root runs directly, non-root goes through `sudo -n` (`privilegedInvocation`, pure). The timeout is now PER-CALL because it broke a real migration: every command shared one fixed 60s, which is ample for an account command but NOT for the CORE `chown -R <commons> <whole data tree>` — on a busy instance (28 agents' worktrees + `~/.claude/projects`) that ran past 60s and was SIGTERM'd, exiting with a NULL code (`chown exited with code null`). Because that chown is a core step, the marker was withheld and the red "isolation did NOT complete" banner stuck — and it never self-heals, the tree only grows. The unbounded recursive ops now pass `TREE_OP_TIMEOUT_MS` (20min); the short commands keep the 60s default. Safe because the migration is fire-and-forget off the boot path. `runWithTimeout` is extracted so the timeout→null-code behaviour is unit-tested with a real harmless command (`test/privileged.test.ts`). |
| `src/talk.ts` | `talkVerdict` — the cross-group letter ACL behind `POST /talk`, decided by the RECIPIENT's nature and whether the sender holds a handle (public: free; restricted: only with a handle; private: sealed inbound, no break-glass — a handle does not open it). |
| `src/migrate-groups.ts` | The automatic one-shot migration of a running single-tenant instance into groups, on the first boot of a CAPABLE one. |
| `src/first-agent.ts` | The lead agent an instance starts life with: `general` on the `Shadok-Boss` profile, in the launch dir, no worktree. |
| `src/ground.ts` | What kind of project a directory holds, read deterministically — fs only, no model call, no network, no process spawn (not even `git`). |
| `src/greeting.ts` | What the lead says the first time a cockpit opens, as a BRIEF the model writes from — never finished prose. |
| `src/claude-auth.ts` | Auth status and the interactive sign-in. `claude auth login --claudeai` needs no PTY: run with pipes it prints the OAuth URL on stdout and reads the code from stdin — so the sign-in touches NONE of the screen heuristics. |
| `src/connect-gate.ts` | `connectVerdict` / `connectedState` — can THIS agent authenticate? Root sign-in for the server's own user, the token or the space's own login for a dropped multi-tenant agent; only an observed absence refuses (invariant 27). Feeds the spawn gate, the first-agent plan and `/auth` → `connect`. |
| `src/token-paste.ts` | `normalizePastedToken` — a `setup-token` token pasted on the Connect card: trimmed, shape-checked (`sk-ant-oat01-…`, never an API key), the error never echoes the input. |
| `src/setup-token.ts` | In-cockpit provisioning of the long-lived subscription token (`MT_CLAUDE_OAUTH_TOKEN`) a multi-tenant instance injects into its privilege-dropped agents — so an instance is autonomous (obtain + rotate from the cockpit, no hand-run shell). |
| `src/agent-login.ts` | In-cockpit `claude auth login --claudeai` for a SINGLE OS user — the `login` auth mode (`config.agentAuth`), the alternative to `setup-token` that gives agents the account's **claude.ai connectors**. Drives the OAuth in a per-user tmux pane (reusing setup-token's URL/invalid-code parsers; success = the credential FILE appearing, never read for its value), so the login lands in that user's OWN home. Per-user because a refreshable credential is single-owner (invariant 56) — never shared across users, and no token is injected in this mode. Routes `/agent-login/*`; `agentLoginInfo` feeds the per-user status/expiry row. |
| `src/claude-creds.ts` | WHEN the Claude OAuth session expires, for the version menu's Account/Token rows — read from Claude Code's own credentials store (file first, then the macOS keychain, the same order `usage.ts` reads the token), and never a token value, only two timestamps. |
| `src/ssh.ts` | Persistent per-container SSH identity (`ensureSshIdentity`, called at boot in `server.ts`). |
| `src/profiles.ts` | Agent profiles (GLOBAL, `~/.shadok-ai/profiles.json` 600; deliberately deleted starter roles are remembered in `profiles-declined.json` — the seed installs the shipped roles a vault is MISSING, including ones a later release added, so it must not resurrect what you removed): role (`--append-system-prompt`) + permission guardrails (`--settings` deny/allow) + secrets + model, applied at spawn via `profileArgs`. `resolveSpawnModel` is the model precedence (agent's choice → profile's pinned → instance default) — the instance default is passed EXPLICITLY only for a privilege-DROPPED agent, which reads its own home's `settings.json` (no model seeded there) and would otherwise fall back to the CLI's Sonnet default; a root/mono agent reads the server `settings.json` itself and gets no forced flag. |
| `src/oauth-relay.ts` | Finish an OAuth sign-in whose redirect lands on an agent's `localhost:PORT` from a browser on another machine: `POST /oauth-relay` (browser-only) GETs the pasted address from the cockpit. |
| `src/peers.ts` | PEERS — other instances allowed to reach this one's agents, the cross-instance twin of a web account. |
| `src/route-guards.ts` | Per-route AUTHORIZATION verdicts, pure: who may write profiles (`profileWriteRefusal` — admin-only in multi-tenant), delete one, change an agent's profile (`setProfileRefusal` — a person, never an agent), restart every agent (`restartAllPlan`), overwrite/delete a mono-tenant secret; and the MCP value masking of `GET /profiles`. See invariant 58. |
| `src/accounts.ts` | Web accounts, PER INSTANCE (`~/.shadok-ai/users/<key>.json`, 600): roles (`admin`/`member`), salted scrypt hashes, single-use invitations, and the signed session token. The request path hashes with ASYNC scrypt (`verifyPasswordAsync`, `hashPasswordAsync`) — `scryptSync` froze every agent's I/O per attempt — and an unknown account pays the same hash (`burnPasswordCheck`). |
| `src/agent-principal.ts` | An agent's session key resolves to THE AGENT (a `member`, its own channel's group, the restricted-peer box it inherits), never the bootstrap admin; `isBrowserPerson` is what "browser-only" means (a person's cookie, no agent key / peer token, same-origin); `AGENT_CREDENTIAL_VARS` never reach an agent's env. Server helpers: `agentPrincipal(req)`, `restrictedBoxOf(req)`. See invariant 59. |
| `src/twofactor.ts` | Two-factor sign-in with a passkey (WebAuthn via `@simplewebauthn/server`), opt-in per instance (`config.twoFactor[<cwd>]`, `twoFactorForCwd`). |
| `src/agent-reports.ts` + `context/report-skill/` | Agent reports: a STUCK agent (expired/refused token, missing access, bug) asks the admins for help via the `shadok-report` skill → `POST /reports` (agent key only). Admins: Reports panel + badge + live `agent-report` frame (admin sockets only, `broadcastAdmins`), and a Telegram DM to the owner. Same title from the same agent merges (`×N`), 10 new/agent/hour, `--secret NAME` (never a value) opens the vault on it. |
| `src/security-events.ts` | The Security panel's event log — 2FA v2's notification channel while no mail sender exists. |
| `src/admin-requests.ts` | 2FA v2's two-admin requests — `passkey-reset` (level 2), `full-reset` (level 3, effective after `FULL_RESET_DELAY_MS` or a second admin), `promote` / `demote`. |
| `src/paths.ts` | `instanceKey(cwd)` — the launch directory encoded as a filename, for anything stored per instance. |
| `src/skill-paths.ts` | Pure `rewriteSkillsBase` — retargets the shipped `~/.claude/skills/<skill>/x.mjs` script paths to where the skills ACTUALLY live for this instance. Every SKILL.md, the ledger reflex and the pilot prompt invoke scripts by the HOME-tier path, correct mono-tenant. But multi-tenant installs the skills ONCE in the machine-wide Enterprise tier (`/etc/claude-code/.claude/skills`, `seedSystemSkills`) and drops agents to HOMEs with NO personal copy — so the Skill tool finds the skill (it reads /etc), yet the literal command the agent then runs hits a path that does not exist and the script silently fails. `server.ts` picks the base off the SAME `DEPLOYMENT_MODE` that decides where they are installed (`SKILLS_BASE`), so the path named can never diverge from the one on disk, and applies the rewrite at the three injection points: the copied SKILL.md (`seedSystemSkills`), the pilot prompt, and the ledger reflex. Identity (no-op) in mono-tenant and for a falsy base. **Two things that rewrite cannot reach, both measured on a live instance.** A command written RELATIVE (`node scripts/x.mjs`) names no base, so there is nothing to retarget and the agent invents the conventional absolute path — shadok-scheduler was the only one of the ten written that way, and a group agent got a bare `MODULE_NOT_FOUND` from it; every SKILL.md now spells the full path and `test/skill-paths.test.ts` refuses the next relative one. And rewriting fixes what an agent READS, never what it KNOWS: `~/.claude/skills` is where skills live everywhere else, so an agent writing a command from habit or from a memory it carries lands there whatever the doc said. `missingHomeSkillLinks` + `linkSystemSkills` (`server.ts`) therefore make that guess TRUE — each machine-wide skill is symlinked into the group HOME's `~/.claude/skills`, as the group user, at provisioning AND at boot. A directory of links, never a symlinked directory, because that path is also where an agent keeps the skills it AUTHORS; `ln -s` without `-f`, so a name already there always wins. |
| `src/cli.ts` | One-shot CLI (`node dist/cli.js "prompt"`), separate from the server. |
| `public/index.html` | The entire web client (no framework, no build). |
| `public/live-text.js` | Pure `extractLiveText(screen)` — pulls the in-flight assistant text block from the TUI screen for the web live preview. |
| `public/group-nav.js` | Pure `GROUP_ICONS` / `randomGroupIcon` / `resolveGroupView` / `groupMood` / `cleanGroupIcon` — the groups column (desktop two-column navigation: the rail lists the groups, the agents column shows the selected one). |
| `public/emoji-search.js` | Pure `searchEmoji(query, limit)` + `looksLikeEmoji(s)` over a CURATED keyword→emoji dataset (`EMOJI`), feeding the group icon picker: typing a word (`rocket`, `bug`…) surfaces matching emojis instead of being truncated to two letters by `cleanGroupIcon`. |
| `public/deep-link.js` | Pure `buildMessageLink` / `buildRoomMessageLink` / `parseMessageLink` / `samePrompt` — a link to ONE message: `#agent=<full session id>&msg=<transcript uuid>` for an agent, `#room=<r_… id>&msg=<message uuid>` for a room (`parseMessageLink` returns `{agent,msg}` or `{room,msg}`; a room id is never UUID-shaped, so the two can't be confused). |
| `src/slash-commands.ts` | The `/` commands the composer offers (`GET /commands`): only the factory skills the agent has (shared with it). A `/command` prompt goes in bare (`isSlashCommand`), with no header or ledger paste. |
| `src/prompt-kind.ts` | `userPromptText` and `classifyUserLine` — the ONE rule for "is this transcript line a prompt a human sees in the chat", shared by `loadHistory` and the live tail (which emits a prompt's uuid for the link button). |
| `public/env-ask.js` | Pure `envVarAsks(text)` / `isEnvAsk(name)` — the env var names an agent's message asks the human to provide, feeding the + beside them (`decorateEnvAsks` → `openSecretFor`, which opens the vault on that name with the asking agent's profile pre-ticked; the ordinary submit then writes it and offers the reload). |
| `public/echo-author.js` | Pure `echoAuthor(msg)` — the author label above a prompt that came from ANOTHER client: the sender's name when the emitting client knows it (Telegram does), else its origin, else the generic wording. |
| `public/channel-store.js` | Pure `pickChannelSource` / `dirKey` — how the client's boot restore chooses its channel list. |
| `public/shadok-soul.js` | Pure `MAXIMS` / `pumpLine` / `gabuzomeu` / `pickMaxim` / `mascotSay` — the Shadok's VOICE (its body is `shadokInner` in `index.html`): what the header mark says when clicked, the thinking indicator's rotating pump lines, the empty states' maxim, counting in base 4 (GA BU ZO MEU). Randomness injected, so tested. |
| `public/notify.js` | Pure `notifyState(channels, {hidden, phase})` → `{color, badge, blink}` — the favicon/title/blink decision. |
| `public/connect-card.js` | Pure `connectCardPlan` — which step of the one Connect Claude card to show (choose / authorise / ask-admin) from `/auth` → `connect`, a spawn refusal and the viewer's role. Members never get an OAuth flow. |
| `public/spawn-steps.js` + `src/spawn-steps.ts` | The birth loader: a fresh spawn announces real steps (`starting`: connect → workspace → claude) and the page shows the pumping Shadok + those steps instead of a black pane, in a tab and in `#startingState`. |
| `public/auth-expiry.js` | Pure `fmtExpiry(ts, now)` (a deadline as "in 22 days" / "in 6 h" / "expired") and `expiryWarning(auth, now)` — the re-login reminder decision over a `/auth` payload: nag only when the account is KNOWN signed in (never `unknown`, never `signed-out` — the sign-in card owns that), only with a numeric `tokenExpiresAt` (the refresh-token deadline, see `src/claude-creds.ts`), within 48h INCLUDING already past it (a tab left open across the deadline must still nag). |
| `public/profile-card.js` | Pure `profileBlurb` / `profileBadges` — the labels a profile card shows, derived from `systemPrompt` / `deny` / `model` / `secrets` (nothing added to `Profile`) — plus `defaultAgentName(profile, cwd)`, the name proposed for a new agent (profile → directory → `"agent"`), and `isManagedProfile` — the server-owned roles (`Shadok-Tweak`) that must never appear in a list where one PICKS a profile, since their prompt is rewritten at every boot. |
| `public/tour-steps.js` | Pure `TOUR_STEPS` / `visibleSteps` / `unionRect` / `bubblePlacement` — the guided tour's step data and geometry. |
| `src/claude-models.ts` | Which models THIS Claude Code build supports, read out of the binary's strings — one scan per upgrade, cached on the binary's path+size+mtime. |
| `public/effort-choice.js` | Pure `EFFORT_CHOICES` / `effortLabel` — the thinking-effort levels a picker offers (`--effort`). |
| `public/model-choice.js` | Pure `MODEL_CHOICES` / `composeModel` / `isLongContext` — the model a SINGLE agent runs on, picked in the creation popin and overriding its profile's. |
| `public/gauge-dial.js` | Pure `dialPos` / `dialColor` / `dialTitle` — the pure core of the quota meters (5h / 7d). |
| `public/ledger-view.js` | Pure `filterLedger` / `ledgerFacets` / `ledgerAge` / `ldgNorm` + the `LEDGER_AGES` / `LEDGER_SORTS` option lists — how the read-only ledger viewer narrows a table that is 144 rows here and 498 on a sibling instance one day later. |
| `public/upload.js` | Pure `uploadFailure(status, contentType)` — should `attachFile` refuse to parse a `/paste` response, and with what message? A proxy rejects an oversized body with its OWN `413 text/html` page that never reaches our JSON route, so `r.json()` on it threw `Unexpected token '<'` and the composer showed that instead of "too large". |
| `public/update-ready.js` | Pure `claudeUpdateState(screen)` → `"restart"` / `"failed"` / `null` — reads Claude Code's OWN update footer from the agent's TUI screen (which the client already has as `t.screenText`): `Update installed · Restart to apply` → the binary is in, reload to apply; `Auto-update failed · … npm i -g …` → the auto-update failed, the cockpit installs it (`POST /claude-update`) then reloads. |
| `context/pilot-prompt.md` | System prompt appended to every piloted session via `--append-system-prompt` (wired in `makePilot`, server.ts). |
| `context/agents-skill/` (`pilotctl.mjs`) | The `shadok-ai-agents` skill: a thin client that lets an agent spawn/pilot other agents through the server. |

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
  the session from the registry and archives its Telegram topic. The
  schedules and webhooks that targeted it are deleted with it (invariant 67).

## WebSocket protocol (`/ws`) and HTTP

The full message + endpoint reference — every field, every refusal `code`, the reason each exists and the guard behind it — is in **[`docs/architecture.md`](docs/architecture.md)** (§ WebSocket protocol). This is the quick list.

**client → server:** `start`, `prompt`, `run`, `choose`, `toggle`, `confirm`, `freetext`, `key`, `settle`, `restart`, `set-parent`, `set-profile`, `set-model`, `set-effort`, `stop`; for a ROOM link only (never mixed with an agent link on one socket): `room-join`, `room-post`.

**server → client:** `agent-report` (admins only), `starting`, `ready`, `working`, `turn-done`, `stream-text`, `stream-tool`, `stream-result`, `stream-bash`, `history`, `dialog`, `screen`, `tokens`, `context`, `background`, `parent`, `profile`, `prompt-echo`, `prompt-id`, `pace-blocked`/`pace-hold`/`pace-resumed`, `auto-retry-*`, `version`, `server-reload`, `gone`, `error` (optional `code`: `unresponsive`/`busy`/`link-refused`/`logged-out`/`resume-refused`), `exited`, `stopped`; rooms: `room-history`, `room-message`, `room-error` (with `code`), `room-closed`.

**HTTP** (everything but `/login` sits behind the optional password gate):

- usage/sessions: `/usage`, `/live`, `/sessions`, `/recover`, `/diff`
- schedules: `/crons` (+ `/crons/:id/run` — fire now), `/timezone`
- rooms (people only, src/rooms.ts): `/rooms` (GET/POST), `/rooms/:id` (PATCH), `/rooms/:id/{archive,read}` (POST), `/rooms/:id/messages` (GET); `/paste` takes `x-shadok-room`
- per-dir cockpit: `/channels` (+ `/glance`), `/groups`, `/agent-folders`, `/defaults`, `/first-agent`, `/title`, `/theme`, `/mute`
- agents & roles: `/tweak/prepare`, `/profiles` (+ `/prompt`, `/secret`, `/restore`), `/secrets`, `/reload`, `/restart-all`, `/models`, `/backend`
- accounts & 2FA: `/users`, `/users/role`, `/peers`, `/invite/:token`, `/me`, `/login*`, `/2fa*`
- media & voice: `/paste`, `/media/:name`, `/files`, `/reports` (+ `/seen`, `/resolve`), `/download`, `/transcribe`
- webhooks: `/hooks/:id` (BEFORE the gate, token-authenticated), `/webhooks` (+ `/:id`, `/:id/rotate`) — writes browser person only
- ops: `/version`, `/autoupdate`, `/permission-mode`, `/ledger`, `/claude-update`, `/telegram`
- connected accounts: `/connect/status`, `/connect/<provider>/{start,complete,done}` (`linkedin`, `google`), `/connected-accounts` (+ `/:id`, `/:id/log`) — browser person only; `/social/accounts`, `/social/posts`, `/google/actions` — the agent side (`x-shadok-session-key`); `/social/drafts/:id/{publish,discard}` — browser person only. WS: `social-draft`
- skills: `/factory/*` (the Skill Factory, `src/factory-routes.ts`), `/commands`

Browser-only writes, `SERVER_OWNED` fields, the `x-shadok-instance` / `x-shadok-session-key` / `x-shadok-peer` gates, and which routes an agent may call are all spelled out in architecture.md — read it before adding or moving an endpoint.

## Invariants & hard-won gotchas (DO NOT relearn these the hard way)

The FULL text — every war story, every "measured on …", the reason each rule exists and the fix it encodes — lives in **[`docs/invariants.md`](docs/invariants.md)**. It is load-bearing, not optional reading: a short version is exactly what let several of these bugs come back. **Before you touch a subsystem, open that file and read the invariants its module row cites.** Below is only the index — the number (a stable cross-reference handle; 29/36/40 are reused on purpose) and the one-line thesis.

- **1.** The registry is the authority on where a session lives — resolve, never guess. · [detail](docs/invariants.md#inv-1)
- **2.** Detection heuristics are fragile. · [detail](docs/invariants.md#inv-2)
- **3.** Single-select dialogs are navigated, not typed. · [detail](docs/invariants.md#inv-3)
- **4.** The resume-from-summary prompt is auto-answered · [detail](docs/invariants.md#inv-4)
- **5.** Worktrees never lose work — but an empty one is pruned on close. · [detail](docs/invariants.md#inv-5)
- **6.** Persistence must never save a partial/empty list. · [detail](docs/invariants.md#inv-6)
- **7.** A restart must not eat content. · [detail](docs/invariants.md#inv-7)
- **8.** Don't let an agent restart the server. · [detail](docs/invariants.md#inv-8)
- **9.** Never `git merge` blind in the shared repo. · [detail](docs/invariants.md#inv-9)
- **10.** The ESM bridge in `index.html` isn't ready at parse time. · [detail](docs/invariants.md#inv-10)
- **11.** The origin guard must let `Origin`-less clients through. · [detail](docs/invariants.md#inv-11)
- **12.** Every inline `<script>` in `index.html` must carry `__CSP_NONCE__`. · [detail](docs/invariants.md#inv-12)
- **13.** The agent's Markdown is always sanitised before `innerHTML` — with the shared `AGENT_MD_PURIFY` config (no forms, no style), behind `form-action 'none'`. · [detail](docs/invariants.md#inv-13)
- **14.** Pace guard · [detail](docs/invariants.md#inv-14)
- **15.** A cron fire must say what it did, and a lost one must be replayed. · [detail](docs/invariants.md#inv-15)
- **16.** A guard's exit code is not a failure signal. · [detail](docs/invariants.md#inv-16)
- **17.** A cron id is never displayed in full — so every API that takes one must accept a PREFIX. · [detail](docs/invariants.md#inv-17)
- **18.** `active` (the current channel, web side) CAN be null. · [detail](docs/invariants.md#inv-18)
- **19.** The SSH identity must never touch a real host's `~/.ssh`, and must live on the mounted volume — not `/root/.ssh`. · [detail](docs/invariants.md#inv-19)
- **20.** The browser's socket scheme follows the page's — never hardcode `ws://`. · [detail](docs/invariants.md#inv-20)
- **21.** Dialog detection belongs to the screen watcher, not to one input path. · [detail](docs/invariants.md#inv-21)
- **22.** The context gauge reads the transcript, never the footer — and the window is a SETTING, not a model. · [detail](docs/invariants.md#inv-22)
- **23.** A restart must GUARANTEE a new process — `TmuxPilot.start()` adopts an existing pane by design. · [detail](docs/invariants.md#inv-23)
- **24.** A field accepted in `start` is not a field STORED — and only the browser tells you. · [detail](docs/invariants.md#inv-24)
- **25.** The diff baseline is COMPUTED, never stored — and `A...B` is the wrong way to compute it. · [detail](docs/invariants.md#inv-25)
- **26.** A profile carries the GUARDRAILS, so an agent must never be able to write one. · [detail](docs/invariants.md#inv-26)
- **27.** A signal you never observed is not a signal — and the sign-in's success is one of them. · [detail](docs/invariants.md#inv-27)
- **28.** On a phone the viewport is THREE different rectangles, and CSS only knows two of them. · [detail](docs/invariants.md#inv-28)
- **29.** The beta channel IS the `latest` dist-tag — CI can only ever SET a tag, not move one. · [detail](docs/invariants.md#inv-29)
- **30.** A multi-question `AskUserQuestion` is a form with a tab bar, not one dialog — answer each question, never auto-drive past it. · [detail](docs/invariants.md#inv-30)
- **31.** One agent = one channel row: dedup by `sessionId` at BOTH ends, because a duplicate self-feeds. · [detail](docs/invariants.md#inv-31)
- **29.** The transcript is ASSERTED, not merely un-poisoned — a session that writes none runs, works, and says nothing. · [detail](docs/invariants.md#inv-32)
- **32.** An executable file named `claude` is not a working `claude` — and the npm launcher is, intermittently, a 500-byte shell placeholder. · [detail](docs/invariants.md#inv-33)
- **33.** A credential frozen into a process's environment cannot be refreshed — so it must not be one that expires. · [detail](docs/invariants.md#inv-34)
- **34.** Per-launch-dir isolation is a CLIENT property too — the localStorage channel cache is scoped by ORIGIN, not by directory. · [detail](docs/invariants.md#inv-35)
- **35.** A browser tab belongs to the instance it was LOADED from — gate writes on the instance key, because two instances share a port sequentially. · [detail](docs/invariants.md#inv-36)
- **36.** The input box is not its first line — and an interrupted prompt comes BACK into it. · [detail](docs/invariants.md#inv-37)
- **36.** Nothing secret may ride on a command line — not the vault's own spawn either. · [detail](docs/invariants.md#inv-38)
- **37.** An agent may attach a secret it CREATED, and that word is the whole security boundary. · [detail](docs/invariants.md#inv-39)
- **38.** A job every agent runs periodically must not cost in proportion to GLOBAL state. · [detail](docs/invariants.md#inv-40)
- **39.** A LARGE prompt is recorded inside `<pasted_content>`, and the history must UNWRAP it, never drop it — the ledger push is what pushes ordinary prompts over that line. · [detail](docs/invariants.md#inv-41)
- **40.** "Is this agent behind?" is a CONTENT question with a DURABLE, adoption-aware anchor — not a version number, and not the in-memory snapshot. · [detail](docs/invariants.md#inv-42)
- **36.** A start that fails must take its watchers with it — and a short id is not a session id. · [detail](docs/invariants.md#inv-43)
- **40.** A setting the CLI merely WARNS about is one we must validate ourselves — and `--effort` is one. · [detail](docs/invariants.md#inv-44)
- **41.** A per-client message spelled by hand in several places WILL drift — the `profile` message had already. · [detail](docs/invariants.md#inv-45)
- **42.** The web tab turns busy only when the server's `working` comes back — so a fast second Enter sends a SECOND raw prompt the server refuses. · [detail](docs/invariants.md#inv-46)
- **43.** A dialog card must say what the TUI says above the question — the BODY is what a person approves by. · [detail](docs/invariants.md#inv-47)
- **44.** In a container, pid 1 is ours and pid 1 is the only reaper — so every orphan an agent leaves becomes a permanent zombie. · [detail](docs/invariants.md#inv-48)
- **45.** A pid number is not an identity — and in a container it is handed out again on every restart. · [detail](docs/invariants.md#inv-49)
- **46.** A password alone must never register a passkey — and two-factor is only as strong as the weakest door around it. · [detail](docs/invariants.md#inv-50)
- **47.** Never fake a wall. · [detail](docs/invariants.md#inv-51)
- **48.** Once migration completes, no agent runs as root — before that, agents keep the server's own user, which is root in the stock image. · [detail](docs/invariants.md#inv-52)
- **49.** A caller's group is derived server-side, from the SESSION — never from client input — and a resume is checked even for a LIVE session. · [detail](docs/invariants.md#inv-53)
- **50.** `$HOME` must be set at the privilege drop. · [detail](docs/invariants.md#inv-54)
- **51.** Ledger and talk default to the sender's own group; crossing is an explicit, consensual act. · [detail](docs/invariants.md#inv-55)
- **52.** A client that does not say who it is is shown as THE HUMAN — "anonymous" is not a state this cockpit has. · [detail](docs/invariants.md#inv-56)
- **53.** `claude setup-token` runs in a tmux session — read the RENDERED screen, not a raw stream — and the token it mints never leaves the server. · [detail](docs/invariants.md#inv-57)
- **54.** A dropped agent's on-disk STATE must live in its own home, not the server's `/root` — pointing `$HOME` there (invariant 50) is only half of it. · [detail](docs/invariants.md#inv-58)
- **55.** Exactly ONE `Live` per agent — a resume that can't attach must HAND OVER the old viewers, not orphan them. · [detail](docs/invariants.md#inv-59)
- **56.** A refreshable login credential is single-owner — share it only within one OS user, never across users. · [detail](docs/invariants.md#inv-60)
- **57.** A machine-wide seeded script may be NEWER than the server it calls — tolerate the skew, and don't re-seed from a side-by-side build. · [detail](docs/invariants.md#inv-61)
- **58.** An instance-wide or cross-group write is an AUTHORIZATION decision, not just an authentication one — and a filtered READ needs a matching WRITE. · [detail](docs/invariants.md#inv-62)
- **59.** An agent's credential is the AGENT, never the admin — and "browser-only" means a person's cookie, not an `Origin` header anyone can type. · [detail](docs/invariants.md#inv-63)
- **60.** What the server does on a group's behalf (cron checks, offered files, media) it does with that group's rights — never root's; and an agent may put a cron `check` only on ITSELF. · [detail](docs/invariants.md#inv-64)
- **61.** Who is speaking is decided by the CONNECTION (`connectionOrigin`), and text a person types can never pass for a header, ledger block or hiding mark the server wrote (`markHumanPrompt`). · [detail](docs/invariants.md#inv-65)
- **62.** Same-origin is not "ours": a rebound name is same-origin with itself, so the Host is checked too — strictly only with no password (or with `SHADOK_ALLOWED_HOSTS`), so proxied deployments on a domain keep working. · [detail](docs/invariants.md#inv-66)
- **63.** A global object an agent may write is a cross-group write — in multi-tenant an agent may not edit any profile prompt (`promptWriteRefusal`). · [detail](docs/invariants.md#inv-67)

- **64.** A room is not a channel: nothing that reads the CHANNEL registry may ever see one, or it resumes, bridges or counts it as an agent and spawns a `claude` behind it. · [detail](docs/invariants.md#inv-68)

- **65.** The moment a surface stops being operator-only, every line and every SHAPE that assumed "whoever is there is us" becomes a bug. · [detail](docs/invariants.md#inv-69)

- **66.** A mode that changes the rules must also disown the state the old rules created (a bound board, a stored owner) — else its guarantee depends on when the instance was set up. · [detail](docs/invariants.md#inv-70)

- **67.** What targets a channel (its schedules, its webhooks) dies with the CHANNEL being closed — never with its process: a dormant channel is exactly what a schedule wakes. · [detail](docs/invariants.md#inv-71)

- **68.** A prompt that provably did not go in is the ONLY signal of a dead terminal — recover on the submit failure (one enforced restart, one re-delivery, never a watchdog), and a failure the sender cannot act on must reach an admin. · [detail](docs/invariants.md#inv-72)

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
  WS message); `docs/architecture.md` for a new or reshaped subsystem and the
  trade-offs behind it, **plus the module-map row and the `/ws`+HTTP reference
  that now live there in full**; `docs/invariants.md` for a new or changed
  invariant (append it with its own `inv-<n>` anchor and the next sequential
  number, never renumbering existing ones); and THIS file for the one-line
  summary that points at each — a new module's one-liner in the Architecture map
  table, a new invariant's thesis + `#inv-<n>` link in the Invariants index. See
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
