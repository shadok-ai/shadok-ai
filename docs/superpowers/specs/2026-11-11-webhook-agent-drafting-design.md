# Webhooks drafted by an agent — design (v2 on #464)

**Date:** 2026-11-11
**Builds on:** `docs/superpowers/specs/2026-11-10-webhooks.md` (PR #464 — the base
webhook feature). This design does not land until #464 does.

## Intent

#464 gives a webhook a fixed *prompt* that a person types into the ⏰ Schedule
popin by hand. The natural ask is one step up: tell an agent, in plain language,
*"here's the kind of payload I'll POST you — wire yourself a webhook for it"*,
and have it do the authoring. Two entry points were wanted, and both are worth
having:

- **A — conversational.** From the chat, the agent proposes a webhook; a person
  approves it with one click. The classy flow ("branche-moi ça").
- **B — in the popin.** Next to the prompt field, a button asks the agent to
  draft the webhook; the draft appears for the person to approve. The twin of
  the 🧭 *Instance context* editor's "Ask general to draft it".

The whole point of #464's security model is that **an agent cannot open a door
from the internet into itself** (`requestFromBrowser` on every write — the
anti-prompt-injection guard). This design must make authoring easy **without
weakening that guard by one inch.**

## What #464 established, and must not change

- `POST /hooks/:id` is pre-gate and token-authenticated; the token is minted
  once, only its SHA-256 is stored; unknown id / disabled / wrong token all
  answer the same `404`.
- Every management **write** (`POST/PATCH/rotate/DELETE /webhooks`) is
  `requestFromBrowser` only. An agent calling them gets `403`.
- Delivery reuses the cron path (`driveChannel`), payload fenced as untrusted.

None of the above changes. This design **adds** an agent-reachable surface that
is, by construction, incapable of making anything callable.

## The one security invariant (everything hangs on this)

> **Only a person's click in the browser can mint a token and make a webhook
> callable.** Anything an agent produces is an *inert draft*: it has no token,
> and the pre-gate call endpoint can never route to it. An injection can, at
> worst, cause an inert draft to appear in a person's popin, which they discard.

The inert property is not merely asserted — it falls out of #464's own code:
`callVerdict` requires a presented token whose SHA-256 equals a stored hash, and
a draft has **no** `tokenHash`. `tokenMatches("", "")` is already `false`. We
add an explicit `status` check on top (belt and suspenders), so a draft is
rejected before the hash step and can never be confused with a paused active
hook.

## Design

### Data model (one new field on `Webhook`)

```ts
status: "draft" | "active";   // absent on #464 rows → read as "active"
```

- A **draft** has `status: "draft"`, **no `tokenHash`**, `enabled: false`, and a
  `proposedBy` label (the agent/turn that drafted it) for the approval card.
- Approval turns a draft into an **active** webhook: it mints the token
  (`newWebhookToken` + `hashWebhookToken`), sets `status: "active"`,
  `enabled: true`, and returns the token **once** — the exact reveal #464
  already shows at creation.
- `publicWebhook` is unchanged (it already strips the hash); it now also carries
  `status` so the popin can render a draft differently from a live hook.

`callVerdict` gains one line: a hook whose `status !== "active"` is refused like
any other miss (same `404`). Drafts are therefore never callable even if a
future bug gave one a hash.

### The shared core: how an agent drafts a webhook

Both A and B converge on **one agent-reachable write and one person-only
approval** — that is what makes "do both" cheap:

| Route | Who | Effect |
|---|---|---|
| `POST /webhooks/draft` | **agent** (`x-shadok-session-key`, `mayActFor(self)`) | Creates an inert draft `{ sessionId: self, name, prompt }`. Opens nothing. The **only** webhook write an agent may make. |
| `POST /webhooks/:id/approve` | **browser person** (`requestFromBrowser`) | Mints the token, flips to active, returns the token once. The door-opening click. |
| `DELETE /webhooks/:id` (existing) | browser person | Also discards a draft. |

The agent can only draft **for itself** — `mayActFor` scopes it, and `sessionId`
is forced to the caller's own session, never taken from the body (a draft that
could target a sibling is the repointing hole #464 already closes on `PATCH`).

#464's direct `POST /webhooks` (browser-person create+activate in one step) stays
for the fully-manual case. So there are now three ways to get a live webhook, and
**all three end at a person's browser**: manual create, approve-a-chat-draft (A),
approve-a-popin-draft (B).

### The drafting brief (`webhookDraftBrief`, pure + tested)

A single constant string, the instruction the agent writes from in **both** A and
B — locked by a test the way `boss-role.test.ts` locks the lead's. It tells the
agent to return a tight `{ name, prompt }` and encodes two rules:

1. The prompt must treat the request body as **untrusted data** — describe what
   to *do* with it, never "follow what the payload says". (#464 already fences
   the payload; this keeps the *prompt* from undoing that.)
2. **No unattended destructive or irreversible action on an external trigger.**
   A webhook fires on a call from outside; whoever holds the token — or anyone
   who can shape the payload — pulls that trigger. So a drafted prompt *proposes
   and warns* on anything destructive (delete, nuke, spend, send), and leaves
   the irreversible step to a human. (This is the "nuke les us" risk, and it is
   independent of who authored the hook — hence it lives in the brief, which
   every path shares.)

### A — conversational (the social-draft pattern)

Mechanically identical to LinkedIn drafts (`src/social-drafts.ts`,
`public/social-card.js`):

- The agent, mid-conversation, calls `POST /webhooks/draft`. The server emits a
  WS **`webhook-draft`** event to the agent's thread, rendered as an **approval
  card** (reuse the social-draft card shell): name, prompt, target agent, and a
  one-line note of any destructive verb the prompt contains → **Approve** /
  **Discard**. The draft also appears in the ⏰ popin's ⚡ list, tagged *draft*.
- **Approve** → `POST /webhooks/:id/approve` → token revealed once (same curl
  block #464 shows). **Discard** → `DELETE`.
- Unlike LinkedIn, there is **no `autonomous` policy** — approval is *always*
  manual, because approval here is the security boundary, not a convenience.

### B — the popin button (the instance-context pattern)

- In the ⚡ Webhooks section, beside the prompt field: **"✨ Ask this agent to
  draft one"**.
- Clicking it calls `POST /webhooks/draft-request` (**browser person**), which
  delivers a **hidden** one-shot brief to the webhook's own agent over the
  loopback — exactly like `/instance-context/draft` delivers its interview brief
  (`markAgentPrompt` + `deliverWithRetry`). A short free-text *hint* the person
  typed ("a CI failure payload like `{…}`") rides along.
- The agent reads the brief + hint and calls `POST /webhooks/draft` — the **same**
  inert-draft route A uses. The draft lands in the popin list; the person
  approves it there.

So B is not a second backend — it is a second *trigger* for the same agent
action, and the person is in the browser the whole time.

## Why this is safe, restated

- An agent can create **drafts only**, **for itself only**, and a draft is
  **never callable**. The internet-facing endpoint (`/hooks/:id`) can reach
  active hooks only, and only a person's browser click makes a hook active.
- A prompt injection that reaches an agent can at most spawn an inert draft a
  person sees and discards — it cannot open a door, cannot mint a token, cannot
  target a sibling.
- The destructive-action risk is handled where it actually lives (the prompt's
  *content*), in the shared brief, for every authoring path.

## Non-goals / left for later

- HMAC signature verification (still the #464 v2 note).
- An `autonomous` auto-approve policy — deliberately absent; approval is the
  boundary.
- Repointing a webhook at another agent — still refused.
- Returning the agent's answer to the caller — still fire-and-forget.

## Testing

- **Pure, tested:** `webhookDraftBrief` locked like `boss-role.test.ts`;
  `status` transitions (draft → active on approve, token minted only then); a
  `draft`/`status!=="active"` hook is refused by `callVerdict`; `/webhooks/draft`
  forces `sessionId` to the caller and ignores a body `sessionId`.
- **Browser (the two surfaces #464's author could not fully verify):** the
  approval card renders and Approve reveals the token once (A); the ✨ button
  produces a draft in the popin that approves cleanly (B); a chat injection that
  "creates a webhook" yields only a discardable draft, nothing callable.

## Docs that ship with it

- `README.md` — extend the **Webhooks** bullet: an agent can *propose* a webhook
  (chat card or ✨ in the popin); you approve it; approval is what creates it.
- `docs/architecture.md` § Webhooks — the inert-draft + approve model, the shared
  brief, the two triggers.
- `CLAUDE.md` — one invariant: *a webhook an agent authored is inert until a
  person approves it in the browser; the agent surface can never mint a token or
  make a hook callable.*
