# The `shadok-ai-agents` skill — design

Date: 2026-07-20
Status: agreed (brainstorming with the user)

## Goal

Let Claude Code create and drive shadok-ai agents through the web server (the
WebSocket protocol documented in the README): launch an agent in an isolated git
worktree, send it prompts, read its answers, answer its interactive dialogs, get
its diff, stop it. The sessions stay visible and drivable in parallel in the web
UI (sessions are shared server-side).

## Decisions taken

- **Interface**: the web server / WebSocket (`ws://localhost:3789/ws`) + the HTTP
  endpoints (`/sessions`, `/diff`). No direct driving through the CLI or the
  library.
- **Coverage**: complete — spawn (with or without a worktree), prompt/answer,
  dialogs (choose/toggle/confirm/freetext), attaching to an existing session,
  diff, stop, screen (debug). No built-in multi-agent orchestration (parallel
  agents are driven by issuing several commands).
- **Location**: a project skill, versioned in this repo under
  `.claude/skills/shadok-ai-agents/`.
- **Server absent**: automatic background start (building if necessary), waiting
  for the port, then carrying on.
- **Architecture**: a "thin client" approach — a `pilotctl.mjs` helper shipped
  with the skill wraps the protocol in one-shot commands with JSON output. No
  persistent daemon: the shadok-ai server is the source of truth (session state,
  resumability), and each command connects, acts, detaches.

## Structure

```
.claude/skills/shadok-ai-agents/
  SKILL.md        # instructions: when to use, commands, typical flows, traps
  pilotctl.mjs    # thin WS/HTTP client; single dependency: "ws" (already in the repo)
```

`pilotctl.mjs` is an ESM module inside the repo: `import WebSocket from "ws"`
resolves by walking up to the repo's `node_modules` (Node 20 has no stable global
WebSocket client). The script runs with
`node .claude/skills/shadok-ai-agents/pilotctl.mjs <command> …`.

## `pilotctl.mjs`'s commands

Output: one JSON object on stdout; exit code 0 on success, ≠ 0 on error (with
`{error: …}` on stdout).

| Command | Effect |
|---|---|
| `spawn [--cwd DIR] [--worktree] [--resume ID] [--continue]` | opens a WS, sends `start`, waits for `ready`, prints `{sessionId, cwd, branch}` then detaches |
| `prompt <id> "text" [--timeout s]` | reattaches (`start` + `resume: id`), sends `prompt`, stays connected until `answer` **or** `dialog`, prints `{status:"answer", text}` or `{status:"dialog", question, options, multi}` |
| `dialog <id>` | reattaches and prints the pending dialog when there is one, else `{status:"idle"}` |
| `choose <id> <n>` | single-select: picks and commits option n, waits for what follows (`answer` or a new `dialog`) |
| `toggle <id> <n>` | multi-select: toggles option n, prints the dialog's re-read state |
| `confirm <id>` | multi-select: submits the selection, waits for what follows |
| `freetext <id> <n> "text"` | the "Type something" option: sends the free answer, waits for what follows |
| `list [--cwd DIR]` | GET `/sessions` |
| `diff <id>` | GET `/diff?session=…` → the worktree's `{status, diff, branch}` |
| `stop <id>` | sends `stop` (ends the session for every client) |
| `screen <id>` | prints the current TUI screen (debug / engine room) |

### Automatic server start

Every command begins with an HTTP health check on
`http://localhost:${SHADOK_PORT ?? 3789}`. If the server does not answer:

1. `npm run build` in the repo when `dist/server.js` is missing;
2. a detached launch of `node dist/server.js` (stdout/stderr into a log under
   `~/.shadok-ai/`);
3. actively waiting for the port (~15 s timeout), then carrying on with the
   command;
4. a persistent failure → an explicit `{error}`, exit ≠ 0.

The server thus launched stays up afterwards (it also serves the web UI).

## SKILL.md's content

- **When to use it**: delegating a task to an isolated Claude agent in a
  worktree, driving/inspecting existing shadok-ai sessions.
- **The typical "create an agent" flow**: `spawn --worktree --cwd <repo>` →
  `prompt <id> "<task>"` launched through Bash with `run_in_background` (turns can
  take several minutes) → on the notification, read the JSON; if it is a `dialog`,
  answer (`choose`/`toggle`+`confirm`/`freetext`); at the end of the task,
  `diff <id>` to present the changes to the user.
- **Guardrails**:
  - never `stop` a session the current conversation did not create (it may belong
    to the user in the web UI);
  - the `shadok-ai/<tag>` branch and its worktree are never merged or deleted
    automatically — the user is the one who merges;
  - each agent consumes the Claude quota like an ordinary session: do not
    multiply agents without an explicit request;
  - a `prompt` timeout does not interrupt the turn server-side — reattach later
    rather than resending the prompt.

## Error handling

- `prompt`/`choose`/… timing out → `{status:"timeout", screen}` (the current
  screen helps the diagnosis), a clean detach, the session intact.
- An unknown session → the server answers `error`; pilotctl prints `{error}` and
  exits ≠ 0.
- An unexpected `exited`/`stopped` while waiting → `{status:"exited", code}`.
- An unreachable server after the auto-start attempt → an explicit `{error}`.

## Validation test (manual, end to end)

1. `spawn --worktree` on a toy repo → a `sessionId` + `branch` returned, a
   worktree created under `~/.shadok-ai/worktrees/`;
2. a simple `prompt` ("create a hello.txt file") → an `answer` received
   (answering any permission dialogs through `choose`);
3. `diff` → the file appears in the diff;
4. `stop` → the session is over, the dirty worktree is **kept**;
5. the session is visible in the web UI during steps 1–3.
