# In-cockpit subscription-token provisioning (self-service `MT_CLAUDE_OAUTH_TOKEN`)

**Status:** design, pending operator approval before any code.
**Date:** 2026-11-03
**Follows:** `docs/superpowers/specs/2026-11-03-group-credential-injection-design.md`
(the credential-injection work, merged as part of #373 / 83cf4a8).

## Intent (the why)

A multi-tenant instance drops every agent to a non-root OS user with no
keychain, so those agents authenticate from the long-lived subscription token
stored in the vault as the server-owned secret `MT_CLAUDE_OAUTH_TOKEN`
(injected as `CLAUDE_CODE_OAUTH_TOKEN`, forced-last, at every drop-to-user
spawn). Until that token is present, **every** spawn is refused by
`mtCredentialMessage` — including the commons `general` agent once the instance
has migrated — so the whole cockpit is unusable.

Today the only way to put that token in the vault is a human running
`claude setup-token` in a shell and storing the result by hand (documented in
the README), or an operator-assisted ssh/`docker exec` copy from another
instance's vault. Both are crutches: **an instance is not autonomous.** The
operator's requirement, verbatim: *"une instance doit être autonome … il lui
faut un moyen pour démarrer / obtenir un token / le remplacer."*

This feature makes the instance self-service: from the cockpit (and Telegram),
an admin can **obtain** the subscription token the first time and **replace**
(rotate) it later, with the token never leaving the machine in a log, a
response body, or the chat.

## The load-bearing precedent

`claude setup-token` has the **same interactive shape** as `claude auth login
--claudeai`: it prints an OAuth URL, reads a pasted code, and finishes. The web
sign-in card (`#authOverlay` → `POST /auth/login` → `POST /auth/code`) and the
Telegram door (`case "login"` → `/code`) are the exact two-door UX this feature
mirrors.

**Measured difference, 2026-11-03 (verify-first #1, resolved):** unlike
`auth login`, `claude setup-token` is **`isatty`-gated** — run with plain pipes
it produces **zero output** and never prints the URL. It must be driven on a
**PTY** (the project already has `node-pty`, used by `src/session.ts`). On a PTY
it renders a small TUI: a banner, the line *"Browser didn't open? Use the url
below to sign in (c to copy)"*, the URL wrapped in an **OSC-8 hyperlink**
(`ESC ] 8 ; id=… ; <https://claude.com/…> ST`), then a *"Paste code here if
prompted >"* prompt. So this module cannot be the plain `spawn`+pipes shape of
`claude-auth.ts`; it is a `node-pty` spawn whose stream carries CSI
cursor-positioning plus the OSC-8 link. The robust parse is to pull the
`https://…` straight out of the **OSC-8 target**, not to match prose.

**The one difference, and it is the whole security surface:** `auth login`
writes its result to the keychain — there is nothing to capture. `setup-token`
**prints the long-lived token to stdout** on success (`sk-ant-oat01-…`). That
value must be parsed from the child's output and written **straight into the
vault**, and must never reach a log line, the error text a failed flow
surfaces, or any HTTP/Telegram response. Verified in-session (2026-11-02) that
`setup-token` mints a working long-lived token this way and that the
env-injection route authenticates both headless and interactive.

## Goals

1. **Obtain** `MT_CLAUDE_OAUTH_TOKEN` from inside the cockpit when it is missing
   on a capable (multi-tenant) instance, with no shell and no running agent
   (none can start — the gate blocks them).
2. **Replace** (rotate) the token at any time, from the same place, before its
   ~1-year lapse or on demand.
3. **Two doors**, sharing one flow, exactly like sign-in: the web card and
   Telegram (a code pasted on either finishes the other).
4. The token is stored server-side under `MT_CLAUDE_OAUTH_TOKEN` in the **Main**
   group of the vault (the one place `secretsFor([…], MAIN_GROUP_ID)` reads it),
   and is **never displayed, logged, or returned**.

## Non-goals

- Not automating the browser OAuth step — it is a human action on the
  operator's Claude subscription, by design (cannot be headless).
- Not changing how the token is *injected* at spawn (that is done, #373).
- Not a second credential store: it reuses the existing vault + reserved-name
  machinery (`RESERVED_SECRET_NAMES`, `longLivedTokenInfo`) unchanged.
- Not mono-tenant behaviour: mono-tenant instances run agents as root with the
  keychain and need no token; the card/commands are inert there.

## Constraints

- **Admin + browser-origin** for the web endpoints (same gate as `PUT
  /profiles`: `browserOrigin`, admin account). The Telegram door is gated by the
  existing DM owner (`dmGate`), like `/login`.
- **One flow at a time for the whole instance** (mirror `claude-auth.ts`'s
  global `flow`): a second concurrent mint would race. The web card and Telegram
  share it.
- **Everything into the repo in English**; chat/Telegram copy follows the user.
- **Never print the token** anywhere. The capture buffer is treated as
  secret: on any error the surfaced message is generic, never the raw output.
- No self-merge; ship as a branch → PR off `main`.

## The decided how

### New module `src/setup-token.ts` (twin of `claude-auth.ts`)

Pure parsers (unit-tested, no spawn), fed the accumulated PTY stream:
- `parseSetupTokenUrl(chunk): string | null` — the OAuth URL pulled from the
  **OSC-8 hyperlink target** (`ESC ] 8 ; … ; <url> (BEL|ST)`), reusing/extending
  `claude-auth.ts`'s `stripEscapes`. The same OSC-8 shape `parseLoginUrl`
  already strips; here the URL IS the link target (no "visit:" prose).
- `parseSetupTokenOutcome(chunk): "invalid-code" | null` — the refusal wording.
- `parseSetupToken(chunk): string | null` — **the minted token**, matched on
  the `sk-ant-oat01-` shape (verify the exact format — see Verify-first #2).
  Security-critical: most test coverage, including that it never matches the URL
  or a prompt line, and that cursor-positioning escapes between characters do
  not break or, worse, truncate it.

Flow (impure, same structure as `startLogin`/`submitLoginCode`, but on a PTY):
- `startSetupToken(): { url } | { error }` — spawn `claude setup-token` on a
  `node-pty` (NOT plain pipes — measured requirement), `BROWSER=/usr/bin/true`,
  poll the screen for the URL, 30s deadline, idle timeout. Write the code with a
  trailing newline to the pty, as the "Paste code here" prompt expects.
- `submitSetupTokenCode(code): { ok: true } | { ok: false; error }` — write the
  code; **success is the token appearing in stdout AND a clean exit** (assert
  the observable, as `claude-auth.ts` does — do not guess a success string). On
  success, hand the captured token to a stored callback that writes the vault,
  then wipe the buffer. Never return the token.
- `setupTokenPending()`, `cancelSetupToken()`.

Storage is injected (so the module stays testable and never imports the
server): the server passes a `store(token)` that calls the existing internal
`setSecret`-equivalent to write `MT_CLAUDE_OAUTH_TOKEN` into `vault[MAIN]`
(server-owned, `createdBy` = "operator:setup-token", `updatedAt` = now so
`longLivedTokenInfo` restarts the ~1-year window on a rotation).

### Server endpoints (mirror `/auth/login` + `/auth/code`)

- `POST /mt-token/start` — admin + browser-origin; capable instances only
  (mono-tenant → `{ error: "not applicable" }`). Returns `{ url }`.
- `POST /mt-token/code` — admin + browser-origin; `{ code }` → stores → `{ ok }`
  (or `{ ok:false, error }`, never the token). On success, invalidate whatever
  the `mtCredentialMessage` gate / `GET /auth` caches so the banner clears.
- `GET /auth` already returns `longLivedTokenInfo`; extend its payload so the
  client can tell "token present/expiring/missing" for the entry points below
  (no new endpoint needed if `/auth` carries it).

### Web UI (mirror `#authOverlay`)

- A **token card** (its own overlay, same CSP-nonce + ESM-bridge discipline):
  shows the URL as a link, a code input, Submit, and a generic status line.
- **Entry points:** (a) the multi-tenant missing-token state — surface a
  "Obtenir le token d'abonnement" action where `showMigrationBanner` /
  the token-missing condition renders; (b) a "Remplacer le token" control on
  the expiry line (`tokEl` / `accountExpiryLine`, which already prints the
  long-lived expiry and the "re-mint via claude setup-token" hint).
- Admin-only in the UI (hidden for non-admins), matching the server gate.

### Telegram (mirror `case "login"` + `/code`)

- `/mttoken` (name TBD, see Verify-first) → `startSetupToken` → send the URL +
  "send the code with /mtcode <code>".
- `/mtcode <code>` → `submitSetupTokenCode` → confirm stored (never echo the
  token). DM-owner gated.
- Add both to the `/help` text and the signed-out hint if relevant.

## What is left to the builder

- Exact UI placement/wording of the two entry points and the card markup
  (follow the sign-in card's structure and the mobile-viewport/CSP invariants).
- The precise Telegram command names (proposal: `/mttoken` + `/mtcode`;
  confirm they don't collide with existing commands).
- Whether `GET /auth` already carries enough, or a tiny `tokenState` field is
  added to it.

## Verify-first (before planning closes)

Measured against the **real** `claude setup-token` (2.1.3xx), the way
`claude-auth.ts` was verified against `auth login`:
1. ~~The exact URL-prompt wording~~ → **RESOLVED 2026-11-03**: needs a PTY; URL
   is in the OSC-8 hyperlink target; prompt is "Paste code here if prompted >".
   See "load-bearing precedent".
2. The **exact success output**: does it print the token on its own line, with
   what surrounding text, and does the child then exit 0? → pins `parseSetupToken`
   and the success verdict.
3. Does `setup-token` work when the instance keychain is **signed out** (a fresh
   multi-tenant box), or does it require a prior `auth login`? This decides
   whether the token card must be reachable from the signed-out screen too.
4. Confirm the stored token resolves through `secretsFor([MT_CLAUDE_OAUTH_TOKEN],
   MAIN)` and clears `mtCredentialMessage` on the next spawn (end-to-end, in a
   mono-tenant local build it cannot be exercised — needs a capable container).

## Review focus (likely to bite, pin a test each)

- A failed or cancelled flow must **never** surface the capture buffer (it may
  hold a partial token). Test the error paths return generic text.
- A rotation must bump `updatedAt` so the expiry window restarts; a re-mint that
  kept the old timestamp would show as already-expiring.
- The reserved-name hiding (`filterReserved`) must keep `MT_CLAUDE_OAUTH_TOKEN`
  out of the secrets listing after it is stored — unchanged, but assert it.
- Non-admin / non-browser callers are refused at the endpoint (not only hidden
  in the UI).
