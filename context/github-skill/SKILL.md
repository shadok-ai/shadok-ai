---
name: shadok-github
description: Clone, pull and push GitHub repositories and run `gh` (pull requests, issues, checks) with the GitHub account the person connected in the cockpit. Use when you need to clone a private repository, push a branch, open or review a pull request, or call the GitHub API on their repositories — and when git or gh says it has no GitHub credential.
---

# shadok-github

Works with a GitHub account the person connected in the cockpit (Secrets →
Connected accounts → Connect GitHub). It reaches exactly the repositories they
picked for the shadok GitHub App, nothing else.

**There is no approval step.** What protects their repositories is GitHub's
own protection (branch protection, required reviews). Work the way a careful
contributor does: push a branch and open a pull request; never force-push a
shared branch, never push straight to the default branch unless asked.

## Pick the account

```bash
node ~/.claude/skills/shadok-github/scripts/github.mjs accounts
```

One line per account: `<id>  <login>  repos=<owner(all|n)>  email=<noreply>  reconnect-by=<date>`.
`repos=NONE` means the person connected GitHub but has not chosen any
repository yet: tell them to click **Choose repositories** in Secrets →
Connected accounts. `EXPIRED`: they must reconnect it. Nothing listed: ask them
to connect a GitHub account, or to share theirs with this agent's group.

## git: clone, pull, push

git already asks the cockpit for a credential by itself (this script is its
credential helper for `https://github.com`), so plain `git pull` / `git push`
on an https remote just work. Clone with the script, which also sets who your
commits are authored by:

```bash
node ~/.claude/skills/shadok-github/scripts/github.mjs clone <owner>/<repo> [dir]
```

That writes into the new repository `user.name` = the login, `user.email` = the
account's noreply address (`<id>+<login>@users.noreply.github.com` — GitHub
credits the person without exposing their email), and `shadok.githubAccount`
= the account id. In a repository cloned some other way, run this once inside
it to do the same:

```bash
node ~/.claude/skills/shadok-github/scripts/github.mjs identity
```

Use **https** remotes (`https://github.com/owner/repo.git`): an `git@github.com:`
SSH remote does not use this account.

## gh: pull requests, issues, checks, the API

Run gh through the script — it hands gh the current token for that one call:

```bash
node ~/.claude/skills/shadok-github/scripts/github.mjs gh pr create --fill
node ~/.claude/skills/shadok-github/scripts/github.mjs gh pr list -R <owner>/<repo>
node ~/.claude/skills/shadok-github/scripts/github.mjs gh api repos/<owner>/<repo>/actions/runs
```

A bare `gh` does not use this account.

## Several accounts

With one account shared with you, it is always that one. With several, the
account is picked by, in order: `--account <id>` (`gh --account <id> …`,
`clone … --account <id>`), `SHADOK_GITHUB_ACCOUNT`, `git config
shadok.githubAccount` (set by `clone` / `identity`), then the account whose
repositories belong to the repository's owner. If git or gh says "Several
GitHub accounts are shared with this agent", pick one with
`git config shadok.githubAccount <id>` in the repository.

## A script that needs the token itself

```bash
node ~/.claude/skills/shadok-github/scripts/github.mjs token [--account <id>]
```

It prints the token on stdout — pipe it straight where it is needed. **Never
print it, log it, write it to a file, or put it in a command line you show**:
it is the person's credential. It lasts at most 8 hours; ask again rather
than keeping it.

## When it fails

- `No GitHub account is shared with this agent` — nothing connected, or not
  shared with your group/profile: ask the person.
- `needs a reconnect` — only the person can fix it (Secrets → Connected
  accounts → Reconnect).
- `Repository not found` / 403 from GitHub on a repo you expected — the
  repository is not among those they picked: ask them to add it with
  **Manage repositories** (no reconnect needed).
