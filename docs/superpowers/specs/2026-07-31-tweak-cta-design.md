# Tweak Shadok-AI — a one-click agent that changes the cockpit and opens a PR

Date: 2026-07-31
Status: validated, ready for an implementation plan

## Problem

shadok-ai is a cockpit its users live in daily, and the fastest way to improve
it is to ask an agent that already runs inside it. Today that requires knowing
that the cockpit is itself a git repo: clone `shadok-ai/shadok-ai` by hand, find
the right working directory, tick the worktree box, pick a profile, and know
enough about the project's invariants (never restart the server, never merge)
not to break the very session you are talking in.

Nobody does that. The result is that the people who feel the friction are not
the people who fix it.

The target user is **any shadok-ai user** — someone who installed it with
`npx shadok-ai`, has no clone, and no rights on the repository. The delivery has
to be a **fork under their own GitHub account plus a pull request**, and the
setup has to be **zero configuration** up to the moment a PR is actually pushed.

## Scope

One entry point in the web UI, one server endpoint that materialises a working
copy of the source, one seeded profile, and one system prompt. No change to the
WebSocket protocol, to `src/channels.ts`, or to the worktree machinery — the
tweak session is a **normal worktree session** on a different repository.

Telegram is out of scope: the CTA is a web affordance. A tweak session started
from the web can still be bound to a Telegram topic afterwards, like any other.

## 1. The CTA — bottom of the agents column

Pinned at the bottom of `#tabbar` (`margin-top: auto` plus
`position: sticky; bottom: 0`), separated from the agent list by a hairline, so
it stays visible while the list scrolls.

```
┌─ Agents ────────────┐
│  general            │
│  agent-3            │
│  agent-7            │
│  ＋ new agent        │
│  ＋ new group        │
│                     │
├─────────────────────┤   ← hairline
│ ┌─────────────────┐ │
│ │ 🛠 Tweak Shadok │ │   ← --amber-soft fill, amber border,
│ │    -AI  ›       │ │      mono 12px title
│ │ change the      │ │   ← 10px --text-dim sub-line
│ │ cockpit itself  │ │
│ └─────────────────┘ │
└─────────────────────┘
```

It is deliberately **not** styled like anything else in that column: the tabs
are borderless rows and `＋ new agent` is a ghost button, so a filled card is
the only coloured element there and reads as an action rather than a session.

- Title: `🛠 Tweak Shadok-AI ›` — mono, `--amber`, 12px, 600.
- Sub-line: `change the cockpit itself` — 10px, `--text-dim`.
- Hover: `box-shadow: 0 0 12px rgba(240, 168, 72, .18)` and the `›` slides 2px
  right.
- **No permanent animation.** In a cockpit a blinking element competes with the
  real signals (a tab awaiting an answer, the quota dials) and becomes noise.
- The column narrows to 150px under 900px wide; the copy must wrap to three
  lines there without truncation.

Copy note: `now!` was considered and dropped. Urgency ages badly on a permanent
element, and the real barrier to clicking is not motivation but not knowing what
the button does — which is what the sub-line answers.

### Interaction

One click starts the agent. No pre-filled `New agent` box: the working
directory, the worktree, the profile and the context are all already decided,
and showing a form the user cannot meaningfully change would only ask them to
approve choices they have no basis to judge.

States on the card itself:

| State | Card shows | Notes |
|---|---|---|
| idle | `🛠 Tweak Shadok-AI ›` | |
| preparing | `⋯ fetching source` | first click only, a few seconds |
| failed | `⚠ <short reason> — retry` | click retries |

The card is **always clickable**. Missing `git` or `gh` is not checked at boot
and never greys it out: a dead control with no explanation is worse than a
control that tells you what to install when you use it. `git` missing surfaces
as a `failed` state; `gh` missing is handled later, by the agent, in words.

Everything is wired with `addEventListener` — inline `on*` handlers are not
covered by the page nonce and would silently not run (invariant 12).

## 2. The source checkout

`POST /tweak/prepare` → `{ cwd }` on success, `{ error }` otherwise.

New module `src/selfrepo.ts`:

- `SELF_REPO_URL = "https://github.com/shadok-ai/shadok-ai.git"` — the canonical
  remote. Note that `package.json`'s `repository.url` still points at the
  pre-migration `gnarco/shadok-ai`; fix that field in the same change, since it
  is the first place an implementation would look for this URL.
- `selfRepoDir()` → `~/.shadok-ai/self/shadok-ai`. A separate copy even when the
  user happens to have their own clone: predictable, and it is never the
  directory the running server was launched from.
- `selfRepoPlan(exists, isRepo): "clone" | "update" | "reclone"` — pure, unit
  tested. `reclone` covers a directory that exists but is not a git repo (an
  interrupted first clone).
- `ensureSelfRepo()` — executes the plan. Clone is anonymous over HTTPS (the
  repository is public), so **no authentication is needed to start working**.
  On update: `fetch origin` then fast-forward `main`, so a tweak never starts
  from a stale base. Time-bounded; a failure returns a short human reason.

The client then sends the ordinary `start` message with `cwd` = that path,
`worktree: true`, `profile: "Shadok-Tweak"`, `origin: "web"`. From there this is
a normal session: branch `shadok-ai/<tag>`, isolated checkout, the Diff panel,
and the existing prune-on-close rules all apply unchanged.

Auth is deliberately deferred to the moment a PR is pushed: the user can
describe an idea, watch the agent work and read the diff before connecting any
account.

## 3. The agent's context

New file `context/tweak-prompt.md`, versioned in the repo. It carries what the
agent cannot infer from the checkout:

- It is modifying **the cockpit the user is currently talking in**. The
  `CLAUDE.md` of the repo it just cloned is authoritative — invariants,
  conventions, `docs/architecture.md`.
- Verify with `npm run build` and `npm test`. To see a page, run **its own build
  on a free port** — never touch 3789, which would kill the sibling sessions
  including its own.
- It has no rights on the repository. Delivery is a **fork under the user's
  account plus a PR against `shadok-ai/shadok-ai`**, never a merge, never a push
  to upstream.
- The person on the other side may not be a developer: explain in their
  language, show the diff in plain terms, and do not ask for technical
  arbitration they have no way to make.
- At PR time only: check `gh auth status`. If unauthenticated, run
  `gh auth login`, relay the device code and `github.com/login/device` in the
  chat, and wait. Then `gh repo fork --remote`, push the branch, `gh pr create`.
  If `gh` is not installed, say so and fall back to leaving the branch and the
  diff for the user.

### Where the prompt is injected

Through the existing profile pipeline, not a new one. A `Shadok-Tweak` profile
is seeded at boot next to the other starter profiles, and its `systemPrompt` is
**refreshed from `context/tweak-prompt.md` on every boot** — only that field, so
a secret or model the user attached to the profile survives. This keeps
`profileArgs` generic, and `profile` is already a server-owned channel field
re-applied on resume and restart, so the role is not lost when the session comes
back.

The profile is not shown in the `New agent` grid. One door in, so the CTA path
and a hand-rolled path cannot drift apart.

## Testing

- `selfRepoPlan` — pure, three cases (absent, valid repo, non-repo directory).
- `POST /tweak/prepare` — returns a usable cwd on a fresh state and on a second
  call (idempotent); returns `{ error }` rather than throwing when git fails.
- Profile seeding — refreshing `systemPrompt` preserves `secrets` and `model`.
- CSP — the CTA carries no inline handler (`test/csp.test.ts` already locks the
  general rule).
- Browser check, per `CLAUDE.md`: the card renders and stays pinned at 220px and
  at 150px, and one click opens a working tweak session.

## Deliberately out

- **A GitHub App and an OAuth button.** Better UX, but it means hosting an app,
  a callback and token refresh — a project of its own, not a channel.
- **A pinned permanent tab.** Discoverable, but it takes a permanent slot in the
  list of sessions that are actually running.
- **Auto-updating the tweak checkout while a session is live.** The session owns
  its worktree; refreshing under it is how you lose work.
