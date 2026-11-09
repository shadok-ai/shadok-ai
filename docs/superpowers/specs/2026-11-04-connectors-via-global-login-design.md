# Connectors for multi-tenant agents: a per-instance "login" auth mode

**Status:** design (shape approved by the operator; awaiting doc sign-off, then build).

## Intent and the why

A multi-tenant instance drops every agent to a non-root OS user (`main` for the
commons, a private/restricted group's `sk-*` for its own agents), which has no
keychain, so the agent authenticates from an injected `CLAUDE_CODE_OAUTH_TOKEN` —
the long-lived token from `claude setup-token` (`MT_CLAUDE_OAUTH_TOKEN`,
`src/setup-token.ts`, `/mt-token/*`). That token "can only make model requests":
it does **not** fetch the account's **claude.ai connectors** (Slack, Google
Workspace, Microsoft 365, Atlassian, Claude Docs, …). So since the multi-tenant
migration agents lost the operator's connectors; pre-migration they ran as root
and shared the operator's interactive login under `/root`, which had them.
Shared-ledger `[45be]`.

The operator wants connectors back **without** giving up isolation, and **without
the broker** (see "Why not a shared credential / broker"). Decision: a
**per-instance auth mode**, one of two, with the tradeoff explicit:

- **`token` (default, today's behavior):** the ~1-year setup-token, injected into
  every dropped agent. No connectors. One operator provisioning, ~yearly.
- **`login` (new):** no token injection; **each OS user does an interactive
  `claude auth login` once** into its **own** home. Connectors work for every
  agent. Shorter-lived (~1 month) and needs a per-user reconnect in the cockpit.

## The crux: same-user sharing works, cross-user does not

`claude` refreshes its on-disk credential by **write-new-then-rename**, the new
file is **owned by whoever refreshed, mode 600**, and the refresh token
**rotates** (measured in #373 `[2d5c]`, re-confirmed by this session's POC
`[45be]`). Consequences:

- **Cross-user sharing is out.** Two different OS users cannot share one
  credential file: the first to refresh leaves it `userA:600`, locking the other
  out (and a per-home symlink is destroyed by the rename). This is exactly why
  #373 abandoned the shared-credential-file path
  (`docs/superpowers/specs/2026-11-03-group-credential-injection-design.md`) and
  adopted the token.
- **Same-user sharing is fine** — and is why "it worked before": when every agent
  is the **same** OS user (all commons agents are `main`; pre-migration all were
  `root`), the refresh rewrite stays owned by that one user and every one of its
  processes keeps reading the one real file. No symlink, no cross-user perms.

So the design shares a login **only within one OS user**, never across users:

- **Commons** → **one** `claude auth login` as `main` into `/home/main/.claude`.
  All commons agents are `main`, so they share it natively.
- **Each private/restricted group** → **its own** `claude auth login` as that
  group's `sk-*` user into that user's home, shared by that group's agents.

`login` mode therefore means **N logins = 1 (commons) + 1 per private group**,
each renewed ~monthly. No shared file between users, no broker.

## Why not a shared credential / broker

A single credential shared across the different group users needs a **broker**
(a server component owning the one credential so agents never hold/refresh it).
Two shapes, neither clean: an `ANTHROPIC_BASE_URL` proxy carries model requests
but **not** the connectors (those are direct remote-MCP connections `claude`
makes to `mcp.slack.com` etc., off the model path) — so it does not solve the
goal; a "credential babysitter" that re-opens perms after every refresh fights
`claude`'s write-new-rename and long-lived agents refreshing on their own — racy
and fragile, the very thing #373 called "broker mandatory" and still did not
build. Rejected. Per-user logins give connectors to every agent with none of it.

## Goals

- A per-instance `agentAuth` choice: `token` (default) or `login`, presented with
  the tradeoff (1 yr / no connectors vs ~1 month / connectors + per-user monthly
  reconnect).
- In `login` mode, every dropped agent authenticates from a login **in its own OS
  user's home** and sees the operator's connectors.
- The cockpit shows, **per OS user** (commons + each private group), the login
  status, its ~1-month expiry, and a Reconnect action; a lapsed login is surfaced,
  not silent.
- `token` mode stays byte-for-byte today's behavior.

## Non-goals / anti-goals

- Sharing one credential across different OS users; any broker. (Rejected above.)
- Per-group or per-agent *mode* selection — the mode is one per instance. (Within
  `login` mode, each OS user naturally has its own login; that is not a per-agent
  toggle.)
- Mono-tenant changes: it already uses the keychain interactive login, so
  connectors already work. This feature is **multi-tenant only**.
- Auto-authorizing per-connector integrations that need their own OAuth
  (Supabase/Notion/Linear showed "Needs authentication" in the POC) — connected by
  the operator at claude.ai, out of scope.

## What the POC established (correctsms, 2026-11-04, `[45be]`)

- A non-root user, `claude auth login --claudeai` driven in tmux, **no**
  `CLAUDE_CODE_OAUTH_TOKEN`: login succeeds and `claude mcp list` shows the
  account connectors `✔ Connected`. The authorize URL requests the
  `user:mcp_servers` scope the token lacks.
- Access token ~7h; refresh token (login lifetime) ~1 month.
- A **copy** of one credential into another home dies on first refresh (rotation
  + wipe) — which is why sharing is same-user-only, never copies/cross-user.

## Design

### Per-instance mode

New per-launch-dir config field `agentAuth: "token" | "login"` (default
`"token"`; alongside `autoUpdate`/`permissionMode` in `src/config.ts`). Changing
it **restarts agents** (the auth wiring is a spawn-time decision), like the ledger
toggle. Mono-tenant ignores it.

### `login` mode — per-user login flow

Reuse the `setup-token` machinery (`src/setup-token.ts`: tmux-driven OAuth, URL
parse, code submit, ok/err, never logs the secret), parameterised to run
`claude auth login --claudeai` **as a given OS user** (`setpriv`, `HOME`=that
user's home, env scrubbed of `CLAUDE_CODE_OAUTH_TOKEN`). The credential lands in
that user's own `~/.claude/.credentials.json` natively — no sharing wiring, no
symlink, no shared group. Server routes mirror `/mt-token/*`, keyed by target
user: `POST /agent-login/start` `{user}`, `POST /agent-login/code` `{user,code}`,
`GET /agent-login` (status per user), `DELETE /agent-login` `{user}`. Browser +
admin only.

The set of users needing a login = `main` (commons) + each private/restricted
group's `sk-*` (derivable from the groups + `osUserFor`). The cockpit lists them
with status.

### Spawn wiring

`src/session.ts` / `makePilot`: when `agentAuth === "login"`, do **not** inject
`CLAUDE_CODE_OAUTH_TOKEN` (today it is injected when `opts.user && opts.oauthToken`
— gate it on the mode). The dropped agent then authenticates from its own home's
login. If that user has no (or an expired) login, the agent would hit a sign-in;
detect and surface it (named, actionable — spirit of `claudeStubMessage`) rather
than let it fail opaquely. When `agentAuth === "token"`, unchanged.

### Expiry + reconnect

Extend `src/claude-creds.ts` (`readTokenExpiry`) to take a **path/user** and read
each relevant home's `.credentials.json` `refreshTokenExpiresAt` (~1 month). The
cockpit's Account area shows a row per OS user with the deadline, nags as it
nears, and offers **Reconnect** (re-runs `/agent-login/*` for that user). A lapsed
login stalls that user's agents (documented Claude behavior) — surfaced.

### `/usage` (pace)

Unchanged in `token` mode. In `login` mode there is no instance-global token for
`/usage`; point the usage/pace read at the commons `main` login (or the server's
own credential) so pace keeps working. Builder to confirm the exact source.

## Verify-first (builder, before/at start of build)

1. **Same-user, multi-process refresh safety** — the load-bearing assumption.
   Two `claude` processes as the same user sharing one `~/.claude/.credentials.json`:
   force a refresh in one, confirm the other does **not** wipe/desync (i.e.
   `claude` re-reads the file before refreshing, or locks). Strong prior evidence:
   the pre-migration all-`root` setup ran many concurrent agents on one shared
   credential and worked. Confirm it still holds on 2.1.x before relying on it.
2. **`claude auth login` as a non-root user via tmux** writes a usable login in
   that user's home — already shown in the POC; re-assert in a test harness.
3. **tmux adopt path** (invariant 25/29): a pane created before a server restart
   is re-adopted and the env strip/wiring is skipped — confirm `login` mode agents
   created pre-restart still read their home login (they should: the credential is
   on disk, not in env), and that `token`→`login` switching forces fresh panes.

## What's left to the builder

- The per-user login orchestration (one flow at a time per user; distinct tmux
  session name per user, cf. setup-token's single `sk-mttoken`).
- The cockpit UI: the mode toggle, and the per-user login/status/expiry/reconnect
  rows; coexistence with the existing `/mt-token` row (the two modes are mutually
  exclusive; a dormant `MT_CLAUDE_OAUTH_TOKEN` vault entry is simply ignored in
  `login` mode — leave it, reversible).
- Deriving the user set from the live groups and keeping it current as groups are
  created/removed.
- `/usage` source in `login` mode (above).

## Security

Each group's login lives in **its own home** — no cross-user credential exposure
(better than any shared-file scheme). It is the **same** Claude account for all,
so every group's agents act with the operator's connectors; a private-group member
can read the operator's credential in their own home, exactly as they could read
the injected token today. Accepted (one company subscription, already `[DECIDED]`
in #373).

## Scope / rollout

Multi-tenant only; `token` remains the default so existing instances are
unchanged until an admin switches. Docs (README multi-tenant section,
`architecture.md` auth) ship in the same PR.

## Tests (intended)

- Pure login-flow parsers mirror `parseSetupToken*` (URL, code outcome, success),
  locked like `test/setup-token.test.ts`.
- `agentAuth` config round-trips per launch dir; default `token`.
- Spawn wiring: `login` mode does NOT set `CLAUDE_CODE_OAUTH_TOKEN`; `token` mode
  unchanged (assert both — invariant 24 discipline).
- Per-user expiry read returns each home's `refreshTokenExpiresAt`; a missing
  credential reads as "needs login", not a crash.
- Source-scan: no shared-credential-file / cross-user symlink reintroduced (locks
  the anti-goal).
