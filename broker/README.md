# shadok-connect (broker)

A stateless Cloudflare Worker for the "connected accounts" flow. It holds the
OAuth client secret so instances never do, exchanges the authorization code,
and hands the token back **through the browser, encrypted for the instance**
(ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM, see `src/core.ts`). It stores
nothing and logs no token.

Routes: `GET /health`, `GET /linkedin/start`, `GET /linkedin/callback`.
The LinkedIn app's redirect URL must be `https://connect.shadok.ai/linkedin/callback`.

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
