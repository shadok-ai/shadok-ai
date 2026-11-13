# shadok-connect (broker)

A stateless Cloudflare Worker for the "connected accounts" flow. It holds the
OAuth client secret so instances never do, exchanges the authorization code,
and hands the token back **through the browser, encrypted for the instance**
(ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM, see `src/core.ts`). It stores
nothing and logs no token.

Routes: `GET /health`, `GET /<provider>/start`, `GET /<provider>/callback`,
and `POST /google/refresh`. Providers: `linkedin`, and `google` once its two
secrets are set (`/health` lists only the providers whose secrets exist, plus
`testing: ["google"]` while `GOOGLE_TESTING=1`).

Redirect URLs to register: LinkedIn app →
`https://connect.shadok.ai/linkedin/callback`; Google OAuth client (type *Web
application*) → `https://connect.shadok.ai/google/callback`.

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
400 so the instance can ask for a reconnect. The refresh token is never logged
or echoed.

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
```

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
