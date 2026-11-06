---
name: shadok-ai-agents
description: Create and drive isolated Claude Code agents through the shadok-ai server (git worktrees, prompts, dialogs, diff). Use when the user wants to delegate a task to a shadok-ai agent, launch agents in parallel, or inspect/drive existing shadok-ai sessions.
---

# Driving shadok-ai agents

Every operation goes through the thin client shipped with this skill:

```bash
node ~/.claude/skills/shadok-ai-agents/pilotctl.mjs <command> …
```

Each command prints ONE JSON object on stdout (exit 1 + `{error}` on failure)
and automatically starts the shadok-ai server when it is not running (port
3789, or `$SHADOK_PORT`). Sessions stay visible in the web UI
(http://localhost:3789) — the user can follow along and step in.

## Commands

| Command | Effect |
|---|---|
| `spawn [--cwd DIR] [--worktree] [--profile NAME] [--name LABEL] [--resume ID] [--continue]` | creates an agent → `{sessionId, cwd, branch}`. Skill Factory skills are not passed here: the agent runs every factory skill shared with its group (or with everyone, or private to its creator), at the latest release accepted for that group. `--worktree` isolates the agent in a git worktree (`~/.shadok-ai/worktrees/`, branch `shadok-ai/<tag>`). `--profile` gives it a role + its guardrails + its secrets (see below). `--name` sets the agent's tab name in the cockpit (spawn only; a later rename in the UI is kept) — without it the name is derived from the profile/directory, so several agents look alike |
| `prompt <id> "text" [--timeout s]` | sends a prompt, waits for the end of the turn → `{status:"answer", text, tools}` or `{status:"dialog", question, options, multi}` or `{status:"timeout", screen}` or `{status:"pace-blocked", reason}` |
| `dialog <id>` | queries the state → `{status:"idle"}` or the pending dialog |
| `choose <id> <n>` | single-select dialog: picks and commits option n |
| `toggle <id> <n>` then `confirm <id>` | multi-select dialog: check/uncheck then submit |
| `freetext <id> <n> "text"` | the "Type something" option: a free answer |
| `list [--cwd DIR]` | driven agents (local state + alive/dead) and resumable sessions |
| `diff <id>` | the agent's changes (git status + diff against the worktree's base) |
| `stop <id>` | ends the session (for ALL its clients) |
| `screen <id>` | raw TUI screen (debug) |
| `profile-prompt "<text>" [--name NAME] [--readonly]` | rewrites a profile's **system prompt**: your own by default; any of them (and creation with `--name`) under the lead profile |
| `talk-handle` | prints **your own** handle — the "here is a handle to me" you share so another agent can send you a letter → `{handle}` |
| `talk <handle> "message"` | sends a one-way **letter** to the agent that handle points to → `{ok, delivered}`. A letter, NOT a drive: it is read in the recipient's own context and you get no transcript back (see below) |

## Choosing a profile (`--profile`)

A profile is a role applied at startup: system prompt, native permission
guardrails (e.g. git writes blocked), injected secrets, an optional model.
**Without `--profile` the agent starts as bare Claude** — no role, no guardrail,
no secrets.

The shipped profiles: `Shadok-Boss` (reads everything, delegates, read-only),
`Shadok-dev` (code, full access), `Shadok-Marketing` and `Shadok-Support`
(read-only). `pilotctl.mjs list` does not enumerate them — the list lives in the
UI's Profiles panel, or behind `GET /profiles`.

The profile is only applied to **new** sessions: with `--resume` or
`--continue`, the session keeps the one it already had.

## Growing your own role (`profile-prompt`)

You can rewrite your profile's **system prompt** — to record what you learned
about this repo, a convention nobody should rediscover, a trap to avoid. Under
the lead profile you can rewrite any prompt and **mint** a role (`--name`, plus
`--readonly` so it is born with git writes blocked).

What you **cannot** touch: `deny`, `allow`, `secrets`, `model`. Those are the
guardrails, they belong to the human and are edited from the web UI — a
read-only agent must not be able to grant itself git writes, nor a minted role
hand itself the vault's secrets. These fields are ignored here, not merely
refused.

Authorisation rests on `$SHADOK_SESSION_KEY`, injected into your env at startup
— the session id would not do, `/live` publishes it.

The prompt is passed to `claude` **at spawn**: a change takes effect at the
agent's next restart, not mid-session.

```bash
node ~/.claude/skills/shadok-ai-agents/pilotctl.mjs profile-prompt "$(cat <<'TXT'
… the complete new prompt …
TXT
)"
```

Write the **whole** prompt: it replaces the old one, it does not add to it.

## Typical flow: delegating a task to an agent

1. `spawn --worktree --profile <role> --cwd <repo>` → note `sessionId` and `branch`;
2. `prompt <id> "<task>"` — launch it through Bash with **run_in_background**
   (a turn can take several minutes) and read the JSON at the end;
3. if `status:"dialog"`: answer with `choose` (single) or `toggle`+`confirm`
   (multi) or `freetext`, which in turn return `answer` or a new `dialog`;
4. if `status:"timeout"`: the turn CONTINUES server-side — do not resend the
   prompt; check back later with `dialog <id>`;
4bis. if `status:"pace-blocked"`: NOTHING was sent — usage is above the quota's
   ideal pace (`reason` spells it out). Do not insist in a loop; tell the user;
5. task finished: `diff <id>` and present the changes to the user. The
   `shadok-ai/<tag>` branch and its worktree are NEVER merged or deleted
   automatically — the user is the one who merges.

Parallel agents: repeat `spawn` (one id per agent), and launch the `prompt`
calls in the background simultaneously.

## You get told: your agents report back

An agent you spawn is registered as your **child**, automatically — nothing to
pass. You then receive a message when it:

- **finishes its turn** (with its own summary and a pointer to its `diff`);
- **blocks on a question** (the question, its options, and how to answer);
- **dies or times out** — otherwise you would wait forever for an agent that is
  already gone.

These messages arrive prefixed `🤖 [agent]`. You are told about **your** children
and about no other channel.

Practical consequence: **do not loop to watch an agent any more.** Launch the
`prompt` in the background and move on — repeated polling costs a turn every
time, and the information comes to you.

`--parent none` spawns an agent deliberately unattached; `--parent <id>`
attaches it elsewhere.

## Talking across groups: a letter, not a remote control (`talk`)

When agents belong to different **groups** (teams sharing one cockpit), you
cannot `prompt`/`drive` another group's agent — see/drive stay to your own group
and to public ones. `talk` is the one narrow, consensual exception: you send a
one-way **letter** the recipient handles in ITS OWN context, under its own
guardrails. You never receive its transcript, stream or files back — `talk`
returns only that the letter was accepted and delivered.

The ACL, enforced server-side:

- an agent in a **public** group — messageable freely, no handle needed;
- an agent in another **restricted** group — ONLY if you hold its **handle** (an
  opaque token it shared with you). There is no roster to browse: you can only
  write to an agent whose handle reached you out of band;
- an agent in a **private** group — **sealed inbound**: no letter gets in, even
  with a handle. (But a private-group agent may still send OUTWARD.)

To let someone write to you, give them your handle:

```bash
node ~/.claude/skills/shadok-ai-agents/pilotctl.mjs talk-handle      # → {"handle":"…"}
# share that string (a human or a prompt relays it), then they run:
node ~/.claude/skills/shadok-ai-agents/pilotctl.mjs talk <handle> "please review PR 42"
```

There is no automatic reply channel — if you want an answer, include YOUR handle
inside the message. (In mono-tenant / single-team cockpits everything is one
public commons, so `talk` is simply unrestricted.)

## Being prompted BY another agent

The other direction: a prompt from an agent arrives under a context header
naming it and ending with its short session id — its reply address:

```
⟦agent · 2026-11-02 15:40 · Shadok-Boss · b1c347bc⟧
```

**To answer the turn you need nothing.** `prompt` blocks until your turn ends
and hands your answer back to the caller — the conversation is already a round
trip. The address is for reaching them LATER, on your own initiative:
`pilotctl prompt b1c347bc "…"`.

Two things not to assume. A name is **not** an address: nothing makes tab names
unique, which is why the id is in the header at all. And the automatic reports
above go to whoever **spawned** you, which is not necessarily whoever just
prompted you — if a sibling you did not come from asks you something, its
address is the only way back to it.

## Driving agents on ANOTHER instance (`--peer`)

You can spawn and drive agents on a **different** shadok instance — another one
of your own, or a teammate's — over an authenticated link. Add `--peer <alias>`
**after the command** (like `--profile`/`--cwd`) and it runs against that
instance instead of this one:

```
pilotctl peer add brasdroit1 https://brasdroit1.example.com <token>   # once
pilotctl spawn --peer brasdroit1 --profile dev --cwd /workspace       # spawn there
pilotctl prompt <id> "run the migration" --peer brasdroit1            # drive it
pilotctl diff <id> --peer brasdroit1                                  # read its work
pilotctl stop <id> --peer brasdroit1
```

- The **token** is minted by the REMOTE instance's admin (a human, in its
  cockpit — `POST /peers`). Paste it in once with `peer add`; it is kept in a
  600 file, `peer list` never prints it. You cannot mint your own — that is the
  point: the other instance decides who may reach it.
- What you may touch on X depends on the **scope** its admin gave you when they
  invited you:
  - **restricted** (the default) — only the agents YOU spawned on X; `--peer X
    list` and a diff of someone else's agent come back refused (`peer-scope` /
    `403`). Assume this one unless you were told otherwise.
  - **member** — you act like an invited user: `list`, `diff`, resume/drive/stop
    **any** agent on X, spawn more, read its usage. You are not an admin (no
    account or peer management).
  Track the ids you `spawn` either way and drive them by id.

## Guardrails

- NEVER `stop` a session this conversation did not create: it may belong to the
  user in the web UI. `stop` ends the session for all its clients. (Over `--peer`
  a **restricted** scope enforces this for you; a **member** scope does not — you
  have a member's reach on that cockpit, so mind whose agent you stop.)
- Every agent consumes the Claude quota like an ordinary session. Do not
  multiply agents without an explicit request from the user.
- `prompt` on a session whose turn is already running → the error "a response is
  already in progress": wait with `dialog <id>`.
- If an agent seems stuck in a state the dialogs do not cover, look at
  `screen <id>` (the equivalent of the UI's "engine room").
- To resume an existing session (`spawn --resume <id>`), always pass `--cwd`
  with the session's directory (the server would otherwise fall back to its own
  cwd); for an agent already being driven, the local state supplies that cwd
  automatically.

## Mechanics (for debugging)

The server kills the claude process when its last WS client detaches; so
`pilotctl` keeps a small detached "holder" process per agent (the internal
`hold` command), restarted as needed by every command. Local state:
`~/.shadok-ai/pilotctl/<id>.json` (cwd, branch, baseSha, holderPid). Log of the
auto-started server: `~/.shadok-ai/pilotctl/server.log`.

## Authenticating a direct API call

The commands above do this for you. If you call the cockpit's API yourself, send
your session key — it is in your environment and it does not expire:

```bash
curl -sS -H "x-shadok-session-key: $SHADOK_SESSION_KEY" \
  "http://127.0.0.1:$SHADOK_PORT/channels"
```

That key is your ONLY credential, and it does not expire. You are no longer
handed a cookie or the cockpit password, and a call made with the key is made
as YOU — an agent of your own group, never an admin: account, backend and
other cockpit-admin routes answer `403`, and so do the person-only (browser)
ones. That is by design; ask the human when you need one of those. A
`401` means that header is missing — or that you were started before this
existed, in which case nothing you hold can authenticate any more and only a
human can fix it: ask them for *Reload agent* on your ⋯ menu.
