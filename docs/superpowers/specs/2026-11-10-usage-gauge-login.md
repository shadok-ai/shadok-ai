# Usage-gauge login

## Problem

On a multi-tenant instance the agents authenticate with a long-lived
`setup-token` (vault secret `MT_CLAUDE_OAUTH_TOKEN`). That token is scoped
`user:inference` only; `GET /api/oauth/usage` needs `user:profile`. So the 5h/7d
gauge — and the pace guard that reads it — has no credential that can work. An
interactive `claude auth login --claudeai` mints a credential with
`user:profile`, so a dedicated one can feed the gauge.

## Verified constraints

1. The refresh token of an interactive login has a fixed window (~1 month from
   sign-in). On refresh the CLI stores `Math.min(oldExpiry, newExpiry)`:
   refreshing never extends it. A manual re-login about monthly is unavoidable.
2. The access token (hours) refreshes inside that window.
3. The refresh token rotates, so the credential needs exactly one owner and its
   own `CLAUDE_CONFIG_DIR`.
4. **Correction to the original brief:** Claude Code 2.1.322 has no
   `claude auth refresh` (`error: unknown command 'refresh'`; `claude auth` has
   `login`, `logout`, `status`). The CLI refreshes lazily before an
   authenticated request.

## Design

- **Store**: `~/.shadok-ai/gauge/<instanceKey>/.claude` (0700), pointed at with
  `CLAUDE_CONFIG_DIR`. Children get a scrubbed env (no `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`).
- **Login**: `claude-auth.ts` becomes a `createLoginFlow({env, signedIn,
  onSuccess})` factory; the instance login is its default instance, the gauge
  login a second one with its own env. Endpoints `GET/DELETE /usage-gauge`,
  `POST /usage-gauge/login|code`, `DELETE /usage-gauge/login` — admin only,
  browser-origin for writes, never returning a token.
- **Keep-fresh**: every 15 min, if the access token has < 90 min left (and the
  refresh token is not past its wall, and not within the 10-min backoff, and no
  login is in progress): one minimal `claude -p ok --model haiku
  --no-session-persistence` in the gauge dir. Success = the access expiry in
  `.credentials.json` advanced; exit codes and output are not trusted. Logged,
  best-effort, never blocks anything. Cost: a handful of tokens a few times a day.
- **Wiring**: `usageToken = [gaugeToken, vaultLongLived, readOAuthToken()]`.
  `gaugeToken` is null unless the access token is present, has `user:profile` (when
  the blob lists scopes) and is not within 60 s of expiry; `getUsage` keeps the
  first candidate that reports a window. A fresh login resets the usage cache.
- **Reminder**: `gauge` in `GET /auth` carries state (`none|ok|expiring|expired|
  wrong-scope`), expiries, email and the last refresh outcome. `gaugeWarning`
  shows its own top strip within 5 days of the refresh token's wall (and after).
  A version-menu row and a *Set up / Renew usage gauge login…* button reuse the
  Connect card's authorise step.
- **Opt-in**: no credential file → no refresh, no banner (state `none`, row says
  "not set up"), candidates unchanged.
- **Platform**: file credential store only. On macOS the CLI uses the keychain;
  the feature reports `supported: false` and the row is hidden.

## Non-goals

Re-implementing OAuth; extending the refresh window; making the setup-token read
usage; showing a *different* account than the one signed in (it shows the login
account's usage — intended to match the agents').

## Verification

Unit: path builder, env scrub, creds parsing, state thresholds, token usability,
refresh scheduling/backoff, candidate order, refresh invocation shape, refresh
outcome judged on the file, store isolation (the user's `~/.claude` is never
read), reminder wording. Integration: the login child starts with the gauge dir
(0700) and the instance store untouched. Bench on a free port. **Not testable
without the human's browser**: a real sign-in, and a real lazy refresh by the
`-p` call — if the CLI did not rewrite the store, the card shows "refresh
failing" rather than pretending.
