# Agent reports — a stuck agent asks an admin for help

## Problem

An agent hits a wall only a human can remove: the Linear token expired, it has
no access to the Slack token it was told to post with, the Claude API key it
uses answers 401, a tool or shadok itself is broken. Today its only outlet is
its own chat. Nobody reads that when nobody is watching the agent — a scheduled
agent on a dead token fails every run, silently, for days.

## Design

- **One place**: a per-instance store of reports (`src/agent-reports.ts`,
  `~/.shadok-ai/reports/<instanceKey>.json`, 600).
- **Filed by the agent only**, through the `shadok-report` skill →
  `POST /reports`, authenticated by its session key. A report carries the agent
  (name, group, profile, captured server-side), a `kind` (`access` / `bug` /
  `blocked`), a one-line `title`, an optional `body` and, for `access`, the
  `secret` NAME concerned (validated as an env-var name; a value is refused).
- **No flood**: the same open title from the same agent merges (`count`,
  `lastAt`, unread again). At most 10 NEW reports per agent per hour (429).
- **Notified twice**: a Telegram DM to the owner (new report; a duplicate at most
  hourly), and a live `agent-report` WS frame to admin persons' sockets only
  (badge + sound), with a 60s poll as the net.
- **Read and resolved by admins** in the Reports panel: open first, the body,
  *Open agent*, *Set <SECRET>* (opens the vault on the name, the agent's profile
  pre-ticked), *Mark resolved* / *Reopen*.

## Not in scope

- Replying to the agent from the panel (open the agent and talk to it).
- Email / other notification channels (none exists in shadok yet).
- Visibility for members: reports can describe credential problems; admins only.
