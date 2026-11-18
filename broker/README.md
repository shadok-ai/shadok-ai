# shadok-connect (broker)

A stateless Cloudflare Worker for the "connected accounts" flow. It holds the
OAuth client secret so instances never do, exchanges the authorization code,
and hands the token back **through the browser, encrypted for the instance**
(ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM, see `src/core.ts`). It stores
nothing and logs no token.

Routes: `GET /health`, `GET /<provider>/start`, `GET /<provider>/callback`,
`POST /google/refresh`, `POST /github/refresh` and `GET /github/setup`.
Providers: `linkedin`, and `google` / `github` once their two secrets are set (`/health` lists only the providers whose secrets exist, plus
`testing: ["google"]` while `GOOGLE_TESTING=1`).

Redirect URLs to register: LinkedIn app →
`https://connect.shadok.ai/linkedin/callback`; Google OAuth client (type *Web
application*) → `https://connect.shadok.ai/google/callback`; GitHub App →
callback `https://connect.shadok.ai/github/callback`, Setup URL
`https://connect.shadok.ai/github/setup` (with *Redirect on update*).

Google specifics (spec `docs/superpowers/specs/2026-11-13-connected-accounts-google-design.md`):
`/google/start` takes `areas=` among `calendar`, `drive`, `gmail` (drafts +
send), `gmail_read` (`gmail.readonly` — reading mail, its own area so drafts
can be granted without it) and `drive_all` (`drive` — the whole Drive, read
and write, apart from `drive` = `drive.file`; restricted, part of the CASA
scope set at publication) (a fixed table in `src/core.ts`, never raw scopes;
carried in the signed state; `/health` lists them as `googleAreas`, so an
instance never offers an area this deploy would refuse — **redeploy the broker
to offer a new one**, and declare the scope on the Google consent screen) and asks for
offline access with `prompt=consent`, so a refresh token comes back on every
connect. `POST /google/refresh` `{refresh_token}` adds the client secret and
returns `{access_token, expires_in, scope}`; `invalid_grant` comes back as a
400 so the instance can ask for a reconnect.

**Two Google apps.** With `GOOGLE_ALT_CLIENT_ID` / `GOOGLE_ALT_CLIENT_SECRET`
set and hostnames listed in `GOOGLE_ALT_HOSTS` (a `wrangler.toml` var), those
hosts are served the alternative app and every other host the default one —
e.g. an app kept in Testing for everyone while another goes through Google's
verification on a demo instance. The host is read from the validated return
URL at start and from the signed state at the callback. `/google/refresh`
does not know which app minted a token, so it tries the default app, then the
alternative; `invalid_grant` from either still means "reconnect". Both apps
need the same redirect URI and scopes. The refresh token is never logged
or echoed.

**The admin page** (`/admin`, `src/admin.ts`) sets each provider's app from a
browser: ONE default app for every instance, and any number of per-domain
overrides (the cockpit's hostname, e.g. a demo instance going through Google's
verification). Resolution for an instance on host H, most specific first
(`src/apps.ts` `pickApp`): the page's app for H → the legacy `GOOGLE_ALT_*` app
when H is in `GOOGLE_ALT_HOSTS` → the page's default → the Worker-secret
default. So the Worker secrets keep working and are the fallback; a deploy
without KV behaves exactly as before. A provider is offered once it has a
default app (page or secrets). The page also carries, per app, Google's
*Testing* flag — the callback then stamps the 7-day `refresh_token_expires_in`
itself, so a verified app on one domain is not reported as expiring weekly —
and GitHub's app slug (the default's feeds `githubInstallUrl`). `/refresh`
tries every app, each client id once, default first.

- Storage: one JSON document in the KV namespace bound as `CONFIG` (key
  `apps:v1`). A client secret is stored AES-256-GCM-sealed under `CONFIG_KEY`
  (32 random bytes, base64url, a Worker secret), with its provider, host and
  client id as associated data, so an entry cannot be moved by editing KV. The
  page never sends a secret back; leaving the field empty keeps the stored one
  (only for the same client id).
- Access: the page sits behind **Cloudflare Access**, and the Worker verifies
  Access's JWT itself (`src/access.ts`: RS256 against the team's published keys,
  audience, issuer, expiry; optional `ADMIN_EMAILS` allowlist). Without
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` the routes do not exist, and anyone
  without a valid token gets a bare 404 — a misconfigured Access app leaves the
  page closed, not open. Writes also need a same-origin `Origin` (CSRF).
- No script on the page: plain forms, CSP `default-src 'none'`.

Setup, once:

1. `npx wrangler kv namespace create CONFIG`, then uncomment the
   `[[kv_namespaces]]` block in `wrangler.toml` with the printed id.
2. `openssl rand 32 | basenc --base64url | tr -d = | npx wrangler secret put CONFIG_KEY`
3. Zero Trust → Access → Applications → *Self-hosted*: domain
   `connect.<your domain>`, path `admin` (it covers `/admin/*`), a policy
   allowing your email. Copy its **Application Audience (AUD) tag**.
4. `npx wrangler secret put ACCESS_AUD` (the tag), and set
   `ACCESS_TEAM_DOMAIN = "<team>.cloudflareaccess.com"` in `wrangler.toml`
   `[vars]`, optionally `npx wrangler secret put ADMIN_EMAILS` (kept out of the
   repository), then deploy.

**GitHub** is a GitHub App, not an OAuth App: it takes no scopes, and what a
token reaches is the app's permissions on the repositories the person
installed it on. Authorizing grants no repository by itself — installing does,
so `/health` advertises `githubInstallUrl` (from the `GITHUB_APP_SLUG` var).
Leave *Request user authorization during installation* OFF: GitHub then
redirects to the callback without our `state`, and the broker refuses it. The
Setup URL lands on `/github/setup`, a plain "close this tab" page — GitHub
carries no state there, and a user token reaches newly picked repositories
without reconnecting. GitHub's token endpoint refuses with HTTP 200 and an
`error` field (the broker treats it as a refusal), user tokens last 8 h, and
the refresh token ROTATES: `/github/refresh` returns the new `refresh_token`,
which the instance must keep. `bad_refresh_token` is reported as
`invalid_grant`, like Google's.

Every other path (`/`, `/waitlist`, …, any method) is forwarded to the site
Worker `shadok-connect-site` through the `SITE` service binding
(`wrangler.toml`). That Worker is deployed separately and must exist before
this one is deployed; without the binding the broker answers 404 there, as it
always did. The broker's own routes are never forwarded.

## Secrets

```bash
cd broker
npx wrangler secret put LINKEDIN_CLIENT_ID
npx wrangler secret put LINKEDIN_CLIENT_SECRET
npx wrangler secret put STATE_KEY        # long random string, signs the OAuth state
npx wrangler secret put GOOGLE_CLIENT_ID      # optional: Google is offered only with both
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_ALT_CLIENT_ID      # optional: a second Google app for GOOGLE_ALT_HOSTS
npx wrangler secret put GOOGLE_ALT_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID      # optional: GitHub is offered only with both
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put CONFIG_KEY      # optional: the admin page's storage key (see above)
npx wrangler secret put ACCESS_AUD      # optional: the admin page's Access audience tag
```

The client id / secret pairs above can instead be set on the admin page.

## Develop

Put the three values in `broker/.dev.vars` (git-ignored) as `NAME=value`, then:

```bash
cd broker && npx wrangler dev
```

`wrangler dev` serves on http://localhost:8787; the redirect URI is derived
from the request's own origin, so register that callback in a test LinkedIn app.

## Deploy

```bash
cd broker && npx wrangler deploy
```

Wrangler is run through `npx`; it is deliberately not a dependency of the repo.
