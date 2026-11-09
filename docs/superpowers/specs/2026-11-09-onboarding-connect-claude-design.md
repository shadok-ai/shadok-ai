# First-run onboarding: one "Connect Claude" card

**Status:** design, shape approved by the operator in chat (2026-11-09, mockups
reviewed on test.shadok.ai); awaiting doc sign-off, then a plan.

## Intent and the why

A fresh instance no longer looks like anything coherent on first run. Observed on a
brand-new `test.shadok.ai` (alpha 0.17.47, multi-tenant because a GUI password is
set — every hosted instance is):

1. The welcome tour opens, and **at the same time** a red full-width banner says
   *"This instance has no subscription token — agents can't start"* — before the
   person knows what the product is.
2. Closing the tour opens **"Sign in to Claude"** (the instance's own `claude auth
   login`, `/auth/*`). It shows the raw ~350-char OAuth URL as a block of
   underlined blue text and one line of explanation.
3. The banner's button opens a **second** OAuth card, *"Subscription token for group
   agents"* (`claude setup-token`, `/mt-token/*`), whose raw URL overflows the panel.
   The person has to do two OAuth round-trips and paste two codes, with no idea
   why there are two.
4. There is no way to paste a long-lived token you already have (minted on your
   own machine with `claude setup-token`).

What the operator wants, in their words: *the tour as it is, then an invitation
to log in to Claude with explanatory text and the two modes, 1 month and 1 year,
and after that we land on our feet.*

## The flow

1. **Tour** — unchanged (`maybeStartTour`). Nothing alarming is shown while it
   runs: no red banner, no card behind it.
2. **Connect Claude — choose** (step 1 of 2). One paragraph saying why: every
   agent is a real Claude Code session running on *your* Claude plan, nothing is
   billed per call, Shadok needs your permission once. Then two choice tiles:
   - **1 year** (recommended, first and preselected — operator's call after
     trying it): set and forget; model access only, no connectors.
   - **1 month**: the agents get your claude.ai connectors (Gmail, Drive,
     Slack…); Shadok reminds you a few days before it expires.
   A quiet secondary link: **"I already have a token"** → a paste field for a
   `claude setup-token` token (equivalent to choosing 1 year).
   A third path stays reachable but secondary: **"Another model"** (today's
   custom-backend tab, `src/backend.ts`) — kept, as a small link, not a peer tile.
3. **Connect Claude — authorise** (step 2 of 2). A primary **"Open claude.ai ↗"**
   button (opens the OAuth URL in a new tab) with a small "copy the link instead"
   fallback; never the raw URL as text. Then "Paste the code Claude gave you" +
   **Connect**. Footer: "← change duration", and a note that the code expires.
   Invalid code → inline error, same child reused (the CLI re-prompts; invariant 27).
4. **Connected.** "✓ Claude is connected", until when (date), the reminder
   promise, and that the first agent (`general`) is starting. Then the card
   closes and the existing first-agent path runs (`startFirstAgent`, greeting).

Mockups (desktop): `onb/mock-a.png` (choose), `mock-b.png` (authorise),
`mock-c.png` (connected) — sent in chat; they set the look, the copy can be
polished.

## What each choice does underneath (no new auth mechanics)

Both durations already exist in the code; this redesign is one door in front of
them.

| | multi-tenant | mono-tenant |
|---|---|---|
| **1 year** | `agentAuth = "token"`; mint via `claude setup-token` (`src/setup-token.ts`, `/mt-token/*`) or paste → stored as `MT_CLAUDE_OAUTH_TOKEN` in Main | **not offered** (see below) |
| **1 month** | `agentAuth = "login"`; interactive `claude auth login` **as the OS user of the space being connected** (`src/agent-login.ts`, `/agent-login/*`) | today's instance sign-in (`src/claude-auth.ts`, `/auth/*`) |

**Mono-tenant shows no duration choice** *(builder's-check call, not the
operator's)*: the code has no mono token path (`makePilot` injects a token only for
a dropped `user`, `/mt-token/*` is 400 on mono, the spawn gate needs the root
login), and an injected `CLAUDE_CODE_OAUTH_TOKEN` would override a developer's own
keychain login. A mono instance (a laptop, no password) goes straight to step 2
with today's sign-in, in the new look. The choice tiles appear only on
multi-tenant.

### Decision: one connection per space in "1 month" multi-tenant mode — lazily

A subscription login cannot be shared across OS users (refresh = write-then-rename,
owned by the refresher, mode 600 — ledger `[45be]`/`[2d5c]`). So in 1-month mode
the commons (`main`) and every private/restricted group each need their own login,
including the private group auto-created for the admin.

**Decided by the operator:** onboarding connects **only the space where the first
agent is born** — the commons (the first agent is spawned over the loopback with
no group, so it runs as `main`). Every other space asks for its own connection
**the first time an agent is started there**, through the **same card** (step 2
directly, the duration being an instance-wide choice already made). No up-front
chain of logins.

### Decision: connecting a space is an admin action

**Decided by the operator:** only an admin connects a space (the `/agent-login/*`
and `/mt-token/*` admin gates stay as they are). A **member** who starts an agent
in an unconnected space gets a calm, non-blocking state — "This space isn't
connected to Claude yet — ask an admin to connect it" — and no OAuth flow. An
**admin** in the same situation gets the step-2 card for that space. The admin
should also see which spaces are unconnected (a cheap indicator where the
per-user login list already lives is enough; no new panel).

### Decision: drop the root-login gate where it is not what agents use

Today every spawn is refused with `logged-out` unless the instance's own (root)
`claude auth login` is signed in (`authStatus()` in the `start` handler;
`firstAgentPlan` also needs `signed-in`). In multi-tenant, agents never use that
credential — they use the token or their own space's login — which is exactly why
a fresh instance demanded two OAuth flows. The gate becomes **"can THIS agent
authenticate?"**:

- multi-tenant + token mode → the token is present;
- multi-tenant + login mode → the spawning space's OS user has a login
  (`agentLoginInfo(home).loggedIn`); if not, refuse with a distinct code (e.g.
  `space-not-connected`, carrying the space) so the page opens the step-2 card
  for that space;
- mono-tenant → unchanged (the instance sign-in is what agents use);
- custom backend → unchanged (not required).

**No regression for running instances** *(call)*: an instance whose root login
is signed in keeps spawning as today — the root login also counts as "connected"
for the commons while it is not yet migrated (`commonsOsUser` is the server's own
user until `groupsMigrated`), and for the existing token-less multi-tenant
instances that run on it. The card appears only when NOTHING usable is there.
A fresh hosted instance migrates at boot (observed on test.shadok.ai: "instance
moved to isolated groups" before any sign-in), so its commons is `main`.

The multi-tenant code routes (`/mt-token/code`, `/agent-login/code`) gain the
`startFirstAgent()` + `maybeRunGroupsMigration("post-sign-in")` hook that
`/auth/code` has today.

Keep invariant 27's three-valued rule: only an OBSERVED "not connected" refuses;
an unreadable state ("unknown") lets the spawn through.

## Banners and other surfaces

- No red banner during the first-run funnel. The "no subscription token" banner
  (and any sign-in banner) is only for a connection that **existed and lapsed**
  or is about to (the expiry reminder that exists today), never for "never
  connected yet" — the card handles that.
- The existing admin surfaces (version menu: re-login, rotate token, switch auth
  mode, per-user login list) keep working and reuse the new card's components
  where it is cheap; restyling them all is not in scope.

## Mobile

The card must work on a phone (≤ 640px, `(pointer: coarse)`):

- Full-width popin (the existing `.sec-panel` mobile rule), choice tiles
  **stacked** vertically, primary button full-width.
- "Open claude.ai" on a phone opens a new tab/app; the person comes back to the
  cockpit tab to paste. Copy says so ("then come back to this tab").
- Inputs ≥ 16px (invariant 28 — Safari zooms otherwise); the paste field must
  stay above the keyboard (`--app-h`, `syncViewport`).
- "copy the link instead" uses the Clipboard API with a visible "copied" state.
- Verified with Playwright at 390×844 with a touch context, screenshots read back.

## Goals / non-goals / anti-goals

- **Goals:** one door, one OAuth round-trip on a fresh instance; plain-language
  explanation; the two durations with their trade-off; paste-a-token; clean link
  presentation; works on mobile.
- **Non-goals:** changing the OAuth mechanics, the token storage, the auth modes
  themselves; redesigning the tour or the greeting; the admin settings panels.
- **Anti-goals:** a red alarm before the person has done anything wrong; a token
  value ever in a response, a log, or the page (only ok/err, as today); a
  silently stranded agent — a space that is not connected must say so and offer
  the card, never fail with a generic error.

## Left to the builder

- Exact copy (English, per conventions) and component structure in `index.html`.
- Whether the paste-a-token path validates the token (e.g. a cheap probe) before
  storing — at minimum shape-check and never echo it.
- How the expiry date shown in step 4 is derived (login: `refreshTokenExpiresAt`
  as today; token: `longLivedExpiresAt`).
- **Live check before planning:** that `claude setup-token` works on an instance
  whose root is NOT signed in (the one-round-trip goal for 1 year rests on it). If
  it does not, come back — the root login would stay in the funnel.
- Whether `/usage` (pace gauges) still needs the root login in multi-tenant, and
  what it shows if not — must degrade quietly, never re-open a sign-in card.
- Tests: pure pieces (the gate decision, card state machine if extracted to an
  ESM module per the `public/*.js` pattern); browser verification on a free port
  and on test.shadok.ai (the operator allows trashing and recreating it).
- Docs in the same PR: README (onboarding), `docs/architecture.md` (auth section),
  CLAUDE.md if an invariant changes (the spawn gate).
