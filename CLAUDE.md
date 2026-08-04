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
| `src/detect.ts` | `screenShowsWork(screen)` — the fragile "is Claude working" heuristic. |
| `src/worktree.ts` | Git worktree isolation: create, diff, list past sessions, recreate a reclaimed checkout. |
| `src/selfrepo.ts` | The working copy of shadok-ai's OWN source (`~/.shadok-ai/self/shadok-ai`) behind the "Tweak Shadok-AI" CTA: anonymous clone (no auth needed to start), `main` hard-reset to the remote on each use, never the launch directory. Only the base clone is refreshed — a live tweak session's worktree is a separate checkout and is never touched. Pure cores (`selfRepoPlan`, `gitFailReason`) tested. |
| `context/tweak-prompt.md` | Role of the tweak agent: read the cloned `CLAUDE.md` first, verify on a free port and never touch 3789, deliver as fork + PR (never a merge), talk to someone who may not be a developer. Injected through the managed `Shadok-Tweak` profile, whose `systemPrompt` is refreshed from this file at every boot (`seedTweakProfile` / `withManagedPrompt`) — only that field, so a secret or model the user attached survives. |
| `src/usage.ts` | Fetches subscription usage (5h/7d) from `/api/oauth/usage`. |
| `src/pace.ts` | The quota **guardrail**: ideal-pace computation + block verdict. |
| `src/retry.ts` | Auto-retry of turns that died on a transient API error (529, 5xx, timeout). |
| `src/channels.ts` | Server-side persistence of the channel + group lists, keyed by launch dir (`~/.shadok-ai/channels/<enc>.json`). `isMirrored` = does this channel live in Telegram too (opt-in per channel; falls back to "has a binding" so existing setups don't change). Also the Telegram board-group binding. Forces the main channel's name to `general`. |
| `src/telegram.ts` | The Telegram bridge (DMs belong to ONE user — `dmGate` + `…-telegram-owner.json`; the owner is adopted at boot from an existing DM binding or the board group's creator): one topic = one agent. Owns the bot long-poll, the command dispatcher (`/spawn`, `/stop`, `/secret`…), Markdown→Telegram HTML, dialogs as inline keyboards, attachments. Each binding holds a **WS client to our own server** — so a Telegram session is the same `Live` the web sees. |
| `src/main.ts` | The `npx shadok-ai` entry point: parses flags, first-run token prompt, then runs the **supervisor**. Not the server. |
| `src/supervisor.ts` / `src/updater.ts` / `src/update-flag.ts` | Self-update: the supervisor runs the npm-installed server as a child, restarts it on the update exit code; the updater fetches `@latest` into `~/.shadok-ai/app`. |
| `src/csp.ts` | La Content-Security-Policy (`cspHeader`) et l'injection du nonce dans la page (`injectNonce`, marqueur `__CSP_NONCE__`). Pur, testé. Voir invariant 12. |
| `src/net.ts` | Où on écoute et qui peut parler : `resolveHost` (`SHADOK_HOST`, loopback par défaut), `bindRefusal` (fail-closed : pas de bind réseau sans mot de passe), `originAllowed` (same-origin, cf. invariant 11). Pur, testé. |
| `src/config.ts` | `~/.shadok-ai/config.json` (600): port, **per-launch-dir** Telegram token/allowed chats/on-off, GUI password, `autoUpdate`, `permissionMode`, `timezone`. Config is authoritative over env once set. |
| `src/crons.ts` | Prompts programmés par canal (`~/.shadok-ai/crons/<enc>.json`) + le `check` déterministe qui évite de réveiller le LLM pour rien. `nextRunFor` calcule un `daily` dans un **fuseau IANA explicite** (`cron.tz` → config `timezone` → machine) : sans ça l'heure suit la machine, et un serveur en UTC décale tout en silence. `nextRunAfterFailure` décide où reprogrammer un tir dont la livraison s'est perdue (cf. invariant 15). `resolveCronTarget` dit OÙ un cron tourne (cwd/profile/branch/repo du canal) — une seule source de vérité pour la garde et pour la reprise (cf. invariant 19). Le tir lui-même vit dans `server.ts` (`cronTick` / `fireCron` / `driveChannel` / `settleCron`). Porte aussi `CRON_PROMPT_MARK` : le texte d'un prompt de cron est préfixé, parce qu'il finit dans le transcript comme un message utilisateur ordinaire — masquer le seul écho direct le laissait revenir au rechargement web et au backfill Telegram, qui relisent `loadHistory`. Jumeau de `NOTHING TO SHOW`. |
| `src/secrets.ts` | Central secret vault (`~/.shadok-ai/secrets.json`, 600). Profiles reference secrets **by name**; values are injected as env at spawn. |
| `src/ssh.ts` | Persistent per-container SSH identity (`ensureSshIdentity`, called at boot in `server.ts`). **Docker-only** (`/.dockerenv`): generates an ed25519 key under `~/.shadok-ai/ssh/` — on the `shadok-data` volume, so it survives restart AND recreate — and symlinks `~/.ssh` to it so agents' `git`/`ssh` use it. NO-OP on a normal host (never touches `~/.ssh`). Pure `sshPaths`/`planDotSshWiring`/`inContainer` are unit-tested. Voir invariant 21. |
| `src/profiles.ts` | Agent profiles (GLOBAL, `~/.shadok-ai/profiles.json` 600): role (`--append-system-prompt`) + permission guardrails (`--settings` deny/allow, e.g. no `git commit`) + secrets + model, applied at spawn via `profileArgs`. Stored on the channel (`profile`) → re-applied on resume/restart. SOFT (same OS user, not a sandbox). |
| `src/cli.ts` | One-shot CLI (`node dist/cli.js "prompt"`), separate from the server. |
| `public/index.html` | The entire web client (no framework, no build). Agents (la création est une **popin** `#setupOverlay`, profile-first : une grille de cartes, le reste replié ; le canal ne naît qu'au « Start agent », cf. invariant 18), groups, dialogs, engine room, diff panel, pace/usage gauges, context bars. UI copy says **agent**; the code, endpoints and storage keys still say `channel`. |
| `public/live-text.js` | Pure `extractLiveText(screen)` — pulls the in-flight assistant text block from the TUI screen for the web live preview. ESM: loaded by the browser (bridged to `window.extractLiveText`) AND imported by `test/live-text.test.ts`. |
| `public/notify.js` | Pure `notifyState(channels, {hidden, phase})` → `{color, badge, blink}` — la décision favicon/titre/clignotement. Le badge ne clignote que si l'onglet navigateur est caché ET qu'un canal **non muté** attend une réponse ; les deux phases restent visibles (un timer étranglé par le navigateur ne doit jamais rendre la page calme). ESM : chargé par le navigateur ET importé par `test/notify.test.ts`. |
| `public/profile-card.js` | Pure `profileBlurb` / `profileBadges` — the labels a profile card shows, derived from `systemPrompt` / `deny` / `model` / `secrets` (nothing added to `Profile`) — plus `defaultAgentName(profile, cwd)`, the name proposed for a new agent (profile → directory → `"agent"`). ESM: loaded by the browser AND imported by `test/profile-card.test.ts`. |
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
`origin` — "web"/"cron"/"telegram"…, renvoyé dans `prompt-echo` pour dire QUI a
parlé),
`prompt` (text, `force?`), `choose` n, `toggle` n, `confirm`, `freetext` n
text, `key`, `settle`, `restart`, `set-profile` (`profile` — le nom du profil ou
`null` ; `restart?` pour l'appliquer tout de suite en re-spawnant sur place.
C'est le SEUL chemin légitime : `profile` est `SERVER_OWNED` sur le canal, donc
un PUT `/channels` du navigateur ne peut pas y toucher), `stop` (`sessionId?` —
kills a specific channel, so the UI can remove a zombie).

**server → client:** `ready`, `working` (porte `elapsedMs` — depuis combien de temps le tour tourne ; le client s'ancre sur la DURÉE et jamais sur un instant serveur, sinon le chrono est faux de tout l'écart entre les deux horloges), `turn-done`, `stream-text`,
`stream-tool`, `stream-result`, `history`, `dialog`, `screen`, `tokens`,
`context`, `profile` (le couple `{profile, applied}` — désiré vs celui que le
process en cours porte vraiment ; leur écart est ce que l'UI montre comme « at
next reload »), `prompt-echo`, `pace-blocked` / `pace-hold` / `pace-resumed`,
`auto-retry-*`, `version`, `server-reload`, `gone`, `error`, `exited`,
`stopped`. `error` carries an optional `code` (today only `"busy"`, on a prompt
refused mid-turn) so a machine client can classify a refusal without matching on
the message text.

**HTTP:** `/usage` (5h/7d + pace verdict), `/live` (running sessions),
`/sessions` `/recover` (resumable), `/diff`, `/channels` `/groups` (GET/PUT,
persisted per launch dir ; le GET de `/channels` ajoute un `crons` **dérivé** —
les horaires du canal, pour l'⏰ de l'onglet — jamais stocké, cf. invariant 6),
`/defaults` (server cwd), `/tweak/prepare` (POST — clone/refresh shadok-ai's own
source, returns the cwd to start the tweak agent in), `/profiles` `/secrets`
(GET/PUT/DELETE), `/telegram` (GET/PUT — bot config from the GUI), `/version`,
`/autoupdate`, `/permission-mode`, `/login`, `/vendor/marked.js`.

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
12. **Tout `<script>` inline de `index.html` doit porter `__CSP_NONCE__`.** La
   page est servie par une route dédiée (pas `express.static`) qui remplace ce
   marqueur par un nonce tiré à chaque requête, et la CSP refuse `unsafe-inline`
   — c'est ce qui neutralise le HTML qu'un agent écrit dans le transcript. Un
   bloc ajouté sans le marqueur **ne s'exécute pas, en silence**. Idem pour les
   gestionnaires inline (`onclick=`), que le nonce ne couvre PAS : passer par
   `addEventListener`. `test/csp.test.ts` verrouille les deux.
13. **Le Markdown de l'agent est toujours assaini avant `innerHTML`.**
   `DOMPurify.sanitize(marked.parse(…))` — `marked` laisse passer le HTML brut,
   et ce Markdown dérive de ce que l'agent a lu (README cloné, page web, message
   Telegram). Sans DOMPurify chargé, on retombe en `textContent` plutôt que
   d'injecter du HTML non filtré.
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
17. **Un id de cron n'est jamais affiché en entier — donc toute API qui en prend
   un doit accepter un PRÉFIXE.** Les trois `list` (web, skill, Telegram)
   n'impriment que 8 caractères. `DELETE /crons` comparait l'UUID complet en
   égalité stricte et répondait `{ok:true}` quoi qu'il arrive : supprimer depuis
   la skill ne supprimait rien et annonçait « deleted ». La résolution est
   maintenant unique et pure (`resolveCronId`) — préfixe vide et préfixe ambigu
   sont **refusés**, jamais tranchés au hasard (`/cron del` nu effaçait le
   premier cron venu).

18. **`active` (le canal courant, côté web) PEUT être nul.** La création vit dans
   une popin (`#setupOverlay`) et ne crée l'onglet qu'au « Start agent » : ouvrir
   puis renoncer ne laisse plus d'onglet mort-né, mais plus rien ne garantit qu'un
   canal existe — fermer le dernier laisse `active === null` et le panneau central
   affiche `#emptyState`. `refreshChrome` gère explicitement ce cas ; tout nouveau
   `active.xxx` doit être gardé. Corollaire : une popin s'ajoute en portant
   `.overlay` (plus de liste d'ids à compléter — c'est cet oubli qui avait laissé
   le panneau des crons s'afficher dans le flux de la page).

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

## Conventions

- TypeScript, ESM, Node 20. `.js` extensions in imports (NodeNext).
- Comments explain **why**.
- **Everything written into the repo is in English**: code comments, identifiers,
  commit messages, PR titles and bodies, specs, docs, test names, log and error
  strings. The history is currently mixed FR/EN — write English from now on, and
  translate the French you happen to touch. No mass retranslation pass: a diff
  that only changes the language of untouched lines buries the real change.
  User-facing UI copy and chat replies are **not** covered by this — they follow
  the user's language (see `context/pilot-prompt.md`).
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
