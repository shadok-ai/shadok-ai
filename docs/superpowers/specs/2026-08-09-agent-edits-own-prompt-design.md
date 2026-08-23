# An agent shapes its role — never its guardrails

Date: 2026-08-09
Status: agreed, implemented

## The request, and what it revealed

"An agent should be able to change a profile's prompt — its own only;
Shadok-Boss could change any of them, and even mint new ones."

While investigating the question, a hole appeared: **it was already possible,
with no limit whatsoever**. `PUT /profiles` accepts `deny`, `allow`, `secrets`
and `model`; `requestAuthed` returns `true` outright when no GUI password is
configured; and the origin guard deliberately lets `Origin`-less callers through
(invariant 11, for Telegram and pilotctl). So a read-only agent could do:

```bash
curl -X PUT localhost:3789/profiles -d '{"name":"Shadok-Content","deny":[]}'
```

and grant itself git writes. So the requested feature is above all the occasion
to **close** that door while opening a small window in its place.

## What is actually guaranteed — and what is not

Closed: the API path. An agent can no longer write a guardrail, and the
capability disappears from the documented surface.

**Not** closed, and it has to be said: agents run under the **same Unix user**,
with a shell. `~/.shadok-ai/profiles.json` is 600 — hence writable by them. A
determined agent rewrites the file and the next spawn re-reads it. This is the
model `CLAUDE.md` already announces: "SOFT (same OS user, not a sandbox)". A real
boundary would take a system user or a container per agent. This design removes
the accident, not the intent.

## The split

| | its profile's prompt | another's prompt | mint a role | deny/allow/secrets/model |
|---|---|---|---|---|
| An agent | ✅ | ❌ | ❌ | ❌ |
| The lead profile | ✅ | ✅ | ✅ | ❌ |
| The human (web UI) | ✅ | ✅ | ✅ | ✅ |

The lead profile can mint a full-access role: that gives it nothing new, it can
already spawn a `Shadok-dev`. What it cannot do is **attach a secret** — the one
capability that would be unprecedented (a role injecting the vault, handed to any
agent). So a created role gets `secrets: []` whatever the request asked for, not
merely a refusal.

## The mechanism

**`browserOrigin`** (`src/net.ts`, pure, tested): true only when an `Origin` is
present AND same-origin. Deliberately stricter than `originAllowed`, which lets
`Origin`-less clients through. It guards `PUT /profiles`. Checked that no
non-browser caller needed it: only `index.html` writes there, Telegram and the
skills only read.

**`promptEditVerdict`** (`src/profiles.ts`, pure, tested): the whole policy in
one place — an empty name, a managed prompt, a caller with no profile, someone
else's target, the lead profile, creation.

**`PUT /profiles/prompt`**: writes `systemPrompt` only. An update starts from the
stored value (`{ ...existing, systemPrompt }`), so guardrails survive **by
construction** rather than by vigilance.

**`SHADOK_SESSION_KEY`**: one key per session, injected into the agent's env. The
session id could not serve as an authenticator — `/live` publishes every id, so
any agent could pass for another. Without that key, "its own profile" would have
been just a comment.

**A managed prompt is refused, not swallowed**: `Shadok-Tweak` takes its prompt
from `context/tweak-prompt.md` at every boot. Accepting the edit would have made
it vanish at the next restart, without a word; the error returns the path of the
file to edit instead.

## The surface for the agent

`pilotctl.mjs profile-prompt "<text>" [--name NAME] [--readonly]`, documented in
the skill with its limits, and announced in the lead profile's prompt — without
which it would not know it can shape the roles.

The prompt is passed to `claude` **at spawn**: a change takes effect at the
target agent's **next restart**, not mid-session. The response says so
explicitly.

## Verification

Pure cores: 12 assertions (`browserOrigin`, `promptEditVerdict`).

End to end against a real server, with **real** agents and their real keys — a
`Shadok-Content` agent and a `Shadok-Boss`:

- the key is indeed in the agent's env;
- it rewrites its prompt (200), the change is in the store, `deny` and `secrets`
  intact;
- refused when editing another profile, when creating, with an unknown key, or
  when touching a managed prompt — each with its own message;
- the boss rewrites `Shadok-Support` (guardrails preserved) and mints a role;
- the created role is read-only as asked and carries `secrets: []` **although the
  request demanded `GOOGLE_ADWORDS`**;
- a `curl` with no `Origin` on `PUT /profiles` is refused, the same one with an
  `Origin` gets through.

The vault being global, it was backed up beforehand and restored identically
afterwards (verified by a byte-for-byte comparison).
