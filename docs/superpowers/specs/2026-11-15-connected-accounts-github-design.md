# Connected accounts — GitHub: clone, push and `gh` on the repositories a person picked

Status: built — the broker half (PR #513) and the instance half (this PR).
Every GitHub call is exercised against mocks only; the "Verify first" items at
the end still need a run against the real GitHub App. Builds on
[`2026-11-08-connected-accounts-linkedin-design.md`](2026-11-08-connected-accounts-linkedin-design.md)
and [`2026-11-13-connected-accounts-google-design.md`](2026-11-13-connected-accounts-google-design.md)
— same broker, same crypto, same store, same share model. This document only
says what GitHub changes.

## Intent and the why

GitHub is what a new user needs first: an agent that cannot clone or push
cannot work on their code. Today that takes a personal access token pasted
into the vault and attached to a profile — exactly the kind of step a new user
does not know how to do. The goal: one click, **Connect GitHub**, in the
Connected accounts panel (next to Google; not in the onboarding flow yet), and
then agents can `git clone` / `git push` and run `gh` on the repositories the
person picked.

**No approval layer.** Unlike LinkedIn and Google there are no action cards and
no per-account policy. The operator decided that GitHub's own repository
protection (branch protection, required reviews, rulesets) is the real
guardrail: an agent that pushes a branch and opens a pull request is the normal
case, and what must not happen to `main` is GitHub's to enforce. The share
scope still decides WHICH agents may use the account.

## The GitHub App (broker side, PR #513)

A GitHub **App** (slug `shadok-ai`), not an OAuth App: it takes no scopes, and
a user token reaches exactly the repositories the person installed the app on,
with the app's permissions. Two consequences shape everything below:

1. **Authorizing grants no repository.** Installing does. A person who just
   connected may have zero installations; the panel then says *Choose
   repositories* and links to `githubInstallUrl` (from the broker's `/health`).
   Picking repositories later needs no reconnect: the same user token reaches
   them at once. The install flow's Setup URL lands on a broker "close this
   tab" page.
2. **User tokens expire and the refresh token ROTATES.** Access `ghu_…` lasts
   8 h, refresh `ghr_…` about 6 months, and each `POST /github/refresh` returns
   a NEW refresh token — the old one is dead from that moment. A dead token
   comes back as `400 {error:"invalid_grant"}`.

## Store

Same file, same rules (`connected-accounts.ts`). A GitHub account:

- `provider: "github"`, `externalId` = the numeric user id (stable across a
  login rename), `label` = the login.
- `token` / `expiresAt` = the access token (8 h); `refreshToken` /
  `refreshExpiresAt` = the refresh token and its deadline.
- `github: { login, id, email, installations: [{id, account, selection, repos}], checkedAt }`
  — `email` is the noreply address `<id>+<login>@users.noreply.github.com`
  (the commit identity: it never exposes the person's real email and GitHub
  attributes commits to them), `installations` what `GET /user/installations`
  last answered. No secret in it.
- `policy` stays `"approve"` and is never read: there is nothing to approve.

`accountDeadline` reads `refreshExpiresAt` for GitHub as for Google: reading
`expiresAt` would expire every GitHub account eight hours after connecting it.

## Token refresh — `GithubTokens` (`src/github.ts`)

The twin of `GoogleTokens`, with the rotation on top:

- Refresh when the access token has < 5 min left.
- **One refresh per account at a time** (an in-flight promise map). Two
  concurrent refreshes would both send the same refresh token; GitHub honours
  the first, the second gets `invalid_grant`, and the account would be marked
  expired although it is fine.
- **Persist the rotated refresh token BEFORE handing out the access token.**
  The store write is synchronous and atomic (tmp + rename); the access token is
  returned only after it. A rotated token that never reached the disk would
  kill the account on the next refresh.
- `invalid_grant` → `status: "expired"`, every later call refuses with the
  reconnect sentence without asking the broker again. A broker that cannot be
  reached, or answers 5xx, changes nothing (try again later).
- A refresh that was sent and got no answer is the one unrecoverable case: if
  GitHub rotated on its side, the stored token is dead. It is said in the log;
  the next use answers "reconnect". Unavoidable with a rotating token.
- **Keep-alive.** The hourly expiry watch refreshes any GitHub account whose
  refresh token has under 14 days left (each refresh issues a fresh ~6-month
  one), so an account used rarely does not lapse; the 7-day warning only fires
  when that refresh fails.

## Agent side — the core design point

Invariant 33: a credential frozen into a process's environment cannot be
refreshed. An 8-hour token in `GH_TOKEN` at spawn would work for eight hours and
then fail in a way nobody can see. So **no token in the env, ever**. What the
spawn adds is only the NAME of a credential helper:

```
GIT_CONFIG_COUNT=<n+1>
GIT_CONFIG_KEY_<n>=credential.https://github.com.helper
GIT_CONFIG_VALUE_<n>=!node '<skills base>/shadok-github/scripts/github.mjs' credential
```

(`githubGitEnv`, appended after any `GIT_CONFIG_*` the env already carries.)
It is set for every agent, account or not — an account connected later must
work without a reload — and is silent when nothing is connected. A helper the
agent's own git config already lists runs first (git consults helpers in
config order, env last), so an existing `gh auth setup-git` keeps working.

Both paths fetch the CURRENT access token from the server at use time:

- **git** — git runs `github.mjs credential get` with
  `protocol=https / host=github.com [/ path=…]` on stdin. The script asks
  `POST /github/token` with its `x-shadok-session-key` and prints
  `username=x-access-token`, `password=<token>`, `password_expiry_utc=<s>`.
  For any other host, or `store` / `erase`, it prints nothing.
- **gh** — `github.mjs gh <args…>` runs `gh` with `GH_TOKEN` set for that one
  invocation only.

`POST /github/token` (agent key only) is gated by the account's share
(`accountVisible`, `agentsUnwalled` in mono-tenant, the profile filter, a
restricted peer box sees nothing) and answers `{account, login, email, token,
expiresAt}`. **This is the first route that hands an agent a provider token** —
deliberately: git and `gh` must hold it to authenticate. What bounds it: the
access token only (the refresh token never leaves the server), 8 hours, the
repositories the person picked, the share scope.

### Several accounts visible to one agent

`pickGithubAccount` (pure), in this order:

1. An explicit account: `--account`, else `SHADOK_GITHUB_ACCOUNT`, else
   `git config shadok.githubAccount` (repo-local or global; `git -c` too).
2. The only usable one.
3. The one whose installations cover the repository's owner — when the owner
   is known (`gh -R owner/repo`, `clone owner/repo`, or git's `path` when
   `credential.useHttpPath` is on). `credential.useHttpPath` is NOT set
   globally: it would change how every other helper keys github.com.
4. Otherwise a refusal naming the accounts. `github.mjs clone` picks by owner,
   clones with `-c shadok.githubAccount=<id>`, then writes that and the commit
   identity into the new repo, so every later fetch/push there is
   deterministic.

Expired accounts are skipped when another one is usable; an explicit pick of
an expired account, or an agent whose only account is expired, gets the
reconnect sentence.

### The `shadok-github` skill (`context/github-skill/`)

`accounts`, `token` (for scripts; never print it), `credential` (the git
helper), `gh`, `clone`, `identity`. Commit identity = name `<login>`, email
the noreply address. Seeded like the other skills (HOME tier, and the
machine-wide tier in multi-tenant), full absolute script paths (skill-paths
rules) — a dropped group agent reaches it under
`/etc/claude-code/.claude/skills`, from its own HOME, and the helper needs
nothing but `SHADOK_PORT` + `SHADOK_SESSION_KEY`, both in its env.

## Panel

- **Connect GitHub** next to Connect Google, offered when the broker lists
  `github`. No dialog: straight to GitHub.
- A GitHub row shows the login, the reconnect deadline, the repositories the
  app reaches (`all repositories of <owner>` / `<n> repositories of <owner>`),
  and either **Choose repositories** (zero installations, or zero repositories:
  agents can do nothing yet) or **Manage repositories** — both open
  `githubInstallUrl` in a new tab. Coming back to the tab re-reads the list
  (the panel's existing `visibilitychange` refresh); `GET /connected-accounts`
  re-reads a GitHub account's installations when its copy is older than a
  minute.
- No policy chips. Share + profile chips as for every account.
- Disconnect forgets the tokens. Revoking the authorization at GitHub needs the
  app's client secret, which only the broker holds: the confirmation says to
  revoke it under GitHub → Settings → Applications if wanted. The refresh token
  is dead in at most 6 months anyway.

## Not in this PR

- The onboarding flow's GitHub step (the operator scoped this to the panel).
- Revoking at GitHub on disconnect (a broker route).
- Any approval card.

## Verify first (against the real app)

1. `GET /user/installations` with a user-to-server token lists only the
   installations the person can access, with `account.login` and
   `repository_selection`.
2. `GET /user/installations/{id}/repositories?per_page=1` gives `total_count`.
3. A refresh returns a fresh `refresh_token_expires_in` (~6 months) — the
   keep-alive relies on it.
4. `git clone https://github.com/<owner>/<private repo>` through the helper,
   then `git push` of a branch, from a mono-tenant agent and from a dropped
   group agent.
5. `github.mjs gh pr create` from the same two.
