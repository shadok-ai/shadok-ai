# Webhooks an agent defines itself

**Date:** 2026-11-28. **Builds on:** `2026-11-10-webhooks.md`. **Supersedes:**
`2026-11-11-webhook-agent-drafting-design.md` (never built).

## Intent

A webhook could only be created by a person in the cockpit. The request that
changed it: an agent should be able to wire one itself — and the agent that
needs it is a guest's, in an external group. That person talks to their agent
from a messaging app; nobody sits in a browser on their behalf, so "a person
approves a card" (the earlier design) is a flow with no one to perform it.

## The rule

An agent may create, edit, rotate and delete webhooks **on itself only**.

- The target is the caller's own session, read from its session key. A body
  naming another session is refused, not ignored.
- `mayActFor` does not decide for an agent: in mono-tenant it says yes to every
  sibling, and a door opened on a sibling is the hole the original rule closed.
- At most `AGENT_WEBHOOK_MAX` (5) webhooks the agent created itself. A person's
  are not counted and not capped.
- Stored `createdBy: "agent"`, shown as such in the popin, logged at creation.
- Another agent's webhook answers 404, like a missing one.
- `SHADOK_AGENT_WEBHOOKS=0` restores person-only writes.

A person's rights are unchanged.

## Why this is acceptable

The original objection stands: an agent that can open a door on itself is what
a prompt injection wants. What changed is the weighing.

- For a guest's agent the door adds little: a stranger already drives that
  agent, and everything it reaches is walled to one conversation (its own Unix
  user, HOME, secret slice, and a box on the API).
- For an internal agent the exposure is real and bounded rather than removed:
  itself only, capped, labelled, the body fenced as untrusted, and the skill
  tells it to open one only on the person's request, to say so, and never to
  act destructively on a call alone. An instance that does not accept that
  trade sets the switch.

**Not built:** a per-profile or per-group permission. One switch per instance
is what exists; a finer grain can follow if an instance needs both.

## The address

A person's browser knows the cockpit's public address; an agent sees the
loopback. So the server remembers the origin a signed-in browser last reached
it at (never a loopback one), or takes `SHADOK_PUBLIC_URL`. Answers carry
`path` always and `url` when known; unknown, the skill tells the agent to ask
for the address rather than invent a host.

## The agent side

`context/scheduler-skill/scripts/webhook.mjs` (`add`, `list`, `update`,
`rotate`, `del`), documented in the `shadok-scheduler` skill — the webhook is
the event-driven twin of a schedule and belongs beside it. The pilot prompt
gains a short section on turns nobody typed: what a webhook call carries is
data someone outside wrote.

## Verified / not verified

Pure rules and the script are unit-tested; the routes were exercised on a side
instance as a person (create, list, pause, call, delete) and as callers with no
valid credential (refused). **Not run for real:** an agent creating a webhook
with its own session key, the origin learnt from a public host, and a
webhook-triggered answer reaching a guest on WhatsApp or Telegram — the side
instance could not start an agent (no Claude sign-in available to it).
