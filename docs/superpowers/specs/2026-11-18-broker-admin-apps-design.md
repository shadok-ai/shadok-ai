# Broker admin page: OAuth apps per provider and per domain

## Problem

The broker's OAuth apps were Worker secrets: changing a client id or secret
meant `wrangler secret put` and a deploy, and serving a different app to one
instance (a demo going through Google's verification) needed a hard-wired
Google-only "alternative app" (`GOOGLE_ALT_*`). Google's Testing flag was one
variable for the whole broker, so a verified app on the demo domain was still
reported as expiring every 7 days.

## Design

- **One default app per provider, plus per-domain overrides**, set on
  `connect.<domain>/admin`. Resolution, most specific first: the page's app for
  the instance's host → legacy `GOOGLE_ALT_*` for a listed host → the page's
  default → the Worker-secret default. The host is the validated return URL's
  (start) or the signed state's (callback), never a header.
- **Storage:** one JSON document in KV (`CONFIG`, key `apps:v1`). Each client
  secret is sealed with AES-256-GCM under `CONFIG_KEY` (a Worker secret), the
  provider, host and client id bound as AAD. The page never shows a secret
  back; an empty field keeps the stored one, only for the same client id.
- **Access:** Cloudflare Access in front of `/admin*`, and the Worker verifies
  its JWT (RS256 against the team's keys, `aud`, `iss`, `exp`, optional email
  allowlist). No Access config → no route; invalid token → bare 404. Writes
  also require a same-origin `Origin` (CSRF only, not authentication).
- **Per-app flags:** Google *Testing* — the callback stamps
  `refresh_token_expires_in` (7 days) when the app is in Testing and Google did
  not send one; `/health` says `deadlineStamped: true` and the instance then
  stops applying the broker-wide `testing` flag to new accounts. GitHub *slug* —
  the default app's feeds `githubInstallUrl`.
- **Refresh:** the instance does not know which app minted its token, so
  `/refresh` tries every configured app, each client id once, default first.
- No script on the page (plain forms, CSP `default-src 'none'`).

## Out of scope

Per-domain GitHub install URLs on `/health` (it does not know the caller's
host), a "test this app" button, and an audit log beyond `updatedAt` /
`updatedBy` on each entry.
