# Connected accounts — posting to LinkedIn by just writing

**Status:** design (shape approved by the operator in chat on 2026-11-08;
awaiting doc sign-off, then plan). Ledger `[ffa2]`.

## Intent and the why

Today a secret is a value somebody pastes into the vault. That works for an API
key and fails for every service that hands out credentials through an OAuth
consent screen — LinkedIn, X, Meta. There the "secret" does not exist until a
person clicks *Allow*, it expires, and obtaining it means registering a
developer app, hosting a redirect URL and running a token exchange. Agents end
up hand-rolling it: on correctsms an agent wrote its own `x-oauth.mjs`, with its
client secret and token files in `/root`, which later broke when agents stopped
running as root (ledger `[3fb4]`).

The operator wants a person to be able to say *"post this on LinkedIn"* to an
agent and have it happen, with no developer console, no pasted token — for one
person on a laptop and for a company where a CEO and a CTO automate posting to
the company Page. LinkedIn is the first provider; the shape must fit X/Meta
next without redesign.

The feature is a **connected account**: a credential produced by a *Connect*
button, owned by a person, shared on purpose, used by agents only through the
server, under a publishing policy its owner chose.

## Decided by the operator

- **One single shadok-owned LinkedIn app**, not one app per user and not a
  third party (Postiz). The person never sees a developer console.
- **A connected account has an owner, a sharing scope and a publishing
  policy.** "Global" keys are a sharing choice the owner makes, not the default.
- **Every publication is logged**: who triggered it, who approved it, what text,
  when, the resulting post.
- **Personal profile first; company Pages next** — but the access request to
  LinkedIn for Pages is filed **now**, since its review takes weeks.

## Goals

- *Connect LinkedIn* in the cockpit: two clicks (Connect → LinkedIn's *Allow*),
  the account appears with its name and expiry.
- Works for **every** shadok instance, including ones not reachable from the
  internet (localhost, a private network), as long as the person's browser can
  reach the instance and the instance can make outbound HTTPS calls.
- Several people on one instance each connect their own account; an owner can
  share an account with a group or the whole instance.
- An agent can publish on an account visible to it: **after a human approves**
  (default) or **on its own** (when the owner allowed it — the automation case).
- Expiry never fails silently: the owner is warned ahead, and a publish on an
  expired account fails with a sentence naming who must reconnect.

## Where the wall is real — and where it is soft (decided by the operator)

In **multi-tenant**, agents run as other OS users: they cannot read the store,
and the publish gate is a real boundary. In **mono-tenant** (a laptop, any
macOS cockpit), agents run as the server's own OS user: they can read
`connected-accounts/*.json`, and with no GUI password `isBrowserPerson` reduces
to "no agent key + same-origin `Origin`", which a `curl` can forge. That cannot
be fixed in code without separate OS users. The operator chose to **accept it
as a SOFT layer, documented**, like profiles (invariant 26): there, the anti-
goals below protect against accidents and injection (an agent posting because a
web page told it to), not against an agent deliberately working around them.
The README and the Connected accounts panel say so in one sentence on a
mono-tenant instance.

## Non-goals (v1)

- Company Pages (v1.1, once LinkedIn grants the Community Management API — the
  model below already has room for them).
- Other networks (X, Meta): the broker and the store are provider-shaped, but
  only LinkedIn is built.
- Approving a draft from Telegram (needs a Telegram-user → shadok-account link
  that does not exist yet; see invariant 61's family). v1 approval is web-only.
- Scheduled posts approved in advance; editing a draft inside the card (ask the
  agent to rewrite instead).
- Reading the feed, comments, analytics.

## Anti-goals (a failure even if it "works")

- **A token in an agent's reach**: env, argv, transcript, a file the agent's OS
  user can read. Agents never hold the token — the server publishes.
- **An agent publishing when the policy says a human approves.** Who may approve
  is decided by the CONNECTION (a browser person's session), never by anything
  the agent sends (invariant 61, invariant 59's `isBrowserPerson`).
- **The broker keeping anything.** No database, no token at rest, no log of
  tokens. If `connect.shadok.ai` leaks, it leaks nothing.
- **A silent expiry**, especially under a cron: the Monday post that stops every
  60 days with nothing on screen is the exact failure invariant 15 forbids for
  crons.
- **A phishing relay**: our broker must not let a stranger's link deliver a
  victim's token to the stranger (see "Broker" below).

## Architecture

```
browser ──(1) Connect──▶ instance: makes ephemeral key pair + nonce
browser ──(2)──────────▶ linkedin.com/oauth/v2/authorization
                           client_id = shadok app, redirect_uri = broker,
                           state = {return URL, instance public key, nonce}
browser ◀─(3)─ LinkedIn redirects to connect.shadok.ai/linkedin/callback?code&state
broker  ──(4)──────────▶ linkedin token endpoint (code + CLIENT SECRET)
broker: encrypt token for the instance's public key; show "connect to <host>?"
browser ──(5)──────────▶ <return URL>#<ciphertext>   (fragment: never sent to any server log)
instance page posts the fragment to the instance; instance decrypts, stores
instance ──(6)─────────▶ api.linkedin.com (userinfo, posts) — outbound only
```

### 1. The broker (`connect.shadok.ai`, a Cloudflare Worker — my call)

- The **only** holder of the LinkedIn client secret (a Worker secret). The
  secret cannot ship in the npm package: anything in the package is public.
- Stateless. `state` carries everything the callback needs:
  `{ v, provider, returnUrl, pub, nonce }`, signed by the broker (HMAC with a
  Worker secret) so a callback cannot be fed a `state` the broker did not mint.
  Minting goes through `GET /linkedin/start?return=…&pub=…&nonce=…`, which
  validates and redirects to LinkedIn.
- `returnUrl` must be `https://…`, or `http://` on a loopback/private address
  (`localhost`, `127.0.0.0/8`, `::1`, RFC 1918) — a plain-http public host is
  refused. Path fixed to `/connect/linkedin/done`.
- Encryption: ECDH P-256 (the instance's ephemeral public key, a broker
  ephemeral key) → HKDF-SHA256 → AES-256-GCM, the `nonce` as associated data.
  Available in WebCrypto (Worker) and `node:crypto` (instance) with no
  dependency. Payload: `{access_token, expires_in, scope, refresh_token?,
  refresh_token_expires_in?}`.
- **Anti-phishing interstitial.** Before redirecting back, the broker shows one
  page: *"You are connecting LinkedIn to the shadok cockpit at
  `<returnUrl host>`. Only continue if that is your cockpit."* [Continue]. A
  stranger's link made with the stranger's key would otherwise hand the
  victim's token to the stranger after an ordinary-looking consent screen.
- Errors from LinkedIn (`error=user_cancelled_authorize`, …) are passed back to
  the return URL as a plain `#error=…`, so the cockpit says what happened.

### 2. The instance side of the connect flow

- `POST /connect/linkedin/start` (browser person only): generate the key pair
  and nonce, keep `{privateKey, person, kind}` in memory keyed by nonce, TTL 10
  minutes; answer the broker URL. The **return URL is the browser's own
  `location.origin`**, sent by the page — behind a TLS proxy the server does not
  know its public name (invariant 20's lesson).
- `GET /connect/linkedin/done` serves a tiny page (nonce'd script, invariant 12)
  that reads `location.hash`, `POST`s it to `/connect/linkedin/complete`, clears
  the hash, and returns to the cockpit.
- `POST /connect/linkedin/complete` (browser person only, **the same person who
  started**): decrypt, call LinkedIn `userinfo` for the member id (`sub`) and
  display name, store the account. A nonce is single-use.
- An instance restart during the 10 minutes loses the pending key: the person
  clicks Connect again. Accepted.

### 3. The connected-account store

`~/.shadok-ai/connected-accounts/<instanceKey>.json`, mode 600, server-owned —
**not** the secret vault, because its entries are never injected into an
agent's env; keyed per launch dir like channels and crons. One entry:

```ts
interface ConnectedAccount {
  id: string;                 // short handle, prefix-resolvable (invariant 17)
  provider: "linkedin";
  kind: "member" | "organization";   // organization = a Page (v1.1)
  label: string;              // "Alexandre Cognard", later "Acme (Page)"
  externalId: string;         // urn:li:person:… / urn:li:organization:…
  owner: string;              // shadok account name
  connectedVia: string;       // whose LinkedIn login produced the token
  share: { scope: "private" } | { scope: "groups"; groups: string[] } | { scope: "instance" };
  policy: "approve" | "autonomous";
  token: string;              // never leaves the server
  expiresAt: number;
  refreshToken?: string; refreshExpiresAt?: number;  // if LinkedIn grants one
  createdAt: number; updatedAt: number;
}
```

Defaults: `share: private`, `policy: approve`. Only the **owner** (a browser
person) changes share, policy, reconnects or disconnects; an admin can
disconnect any account (an admin must be able to cut off a departed employee's
Page access) but **cannot read** the token and cannot switch the policy to
`autonomous` on someone else's account. Reconnecting the same `externalId`
supersedes the token in place (same `id`).

With no GUI password (mono-tenant, accounts dormant) the one person is `admin`
and every account is effectively theirs; `share` is shown but moot.

**Who can use an account** — a pure `accountVisible(account, viewer, groups)`
next to `src/groups.ts`. My calls, aligned on the secret vault's tiers:
- `instance` means **the commons** — Main plus every public group, exactly the
  vault's commons tier. It does **not** reach agents in other people's private
  groups (sealed, even from an admin) nor restricted groups that are not
  listed: a sealed group stays sealed for this too.
- `groups` lists explicit group ids. An owner may only list groups they are a
  member of (no sharing into a room you cannot see). Listing Main is allowed
  and equivalent to sharing with Main only.
- a person: the owner, a member of a listed group, or any person who can see a
  commons group for `instance`;
- an agent (`agentGroup` set): its own group is listed, or its group is in the
  commons and the scope is `instance`. A `private` account is usable by the
  owner's agents **only** when they live in the owner's private group — an
  agent in a shared group never sees a private account even if its launcher
  owns it (the channel's group decides, invariant 49, never the person behind
  it).
- an agent driven by a **restricted peer** (`restrictedBoxOf`): no account, in
  v1. Peers are another instance's people; lending them a company Page is a
  decision nobody has made.

The test matrix is scope (private / groups incl. Main / instance) × viewer
(owner, group member, non-member, admin, agent in each group nature, peer).

### 4. Publishing

A seeded skill, `shadok-social` (twin of `shadok-secrets`), with
`scripts/social.mjs`:
- `accounts` → the accounts this agent can use: id, label, provider, policy,
  expiry. Never a token.
- `post --account <id> --stdin` → the post text on stdin (not argv), optional
  `--image <abs path>` (v1: one image, see Verify-first). Authenticates with
  `x-shadok-session-key` like every skill (invariant 33).

Server: `POST /social/posts` resolves the agent principal, checks
`accountVisible`, then:
- `policy: approve` → creates a **draft** (`pending`) and answers
  `{status:"pending", draftId}`. The draft is shown in the agent's chat as an
  **approval card** — the account label, the exact text, the image, and
  *Publish* / *Discard* — broadcast to the channel's clients and merged into the
  `history` it sends on reload, the way `historyWithOffers` merges file offers.
  The agent is told, via the same hidden loopback as other server notices, when
  the draft is published (with the URL) or discarded, so it can report back.
- `policy: autonomous` → publishes at once, answers the post URL.

`POST /social/drafts/:id/publish` and `/discard`: **browser person only**
(`isBrowserPerson`), and that person must be able to use the account. The token
used is the account's — not "the clicker's LinkedIn": a person approves on an
account they have access to; the log records them as approver. A draft is
single-use and expires after 7 days (my call).

**A waiting draft must reach a person, not only sit in a chat** (my call — a
cron-made draft lands in a channel nobody may open for days, which would be
invariant 15's silent loss again):
- the channel counts as *waiting for an answer* in `notifyState`, like a dialog
  — favicon badge, tab blink, the left-column marker;
- the account's **owner** gets a Telegram DM when they are the Telegram DM
  owner (notify only — approving stays on the web), with the channel name;
- a draft that expires unapproved is logged as `expired` and the agent is told,
  so the next cron run can say so instead of assuming it went out.
A cross-channel "pending drafts" list is NOT built in v1; the store keeps
drafts in one place, so it can be added without migration.

Errors are sentences, not codes, so the agent can relay them: *"LinkedIn
account 'Acme (Page)' expired on 12 Jan — Paul must reconnect it in Secrets →
Connected accounts."*

### 5. The publication log

`~/.shadok-ai/connected-accounts/<instanceKey>.log.jsonl`, append-only: account
id, triggered by (agent session id + channel name, `cron` id when the turn was a
cron fire, or the person), approved by (person or `autonomous`), the text, the
outcome (post URN + URL, or the LinkedIn error). Readable in the UI by anyone
who can use the account.

### 6. Expiry

- A daily server check (no LLM): 7 days before `expiresAt`, warn the **owner**
  — a cockpit banner on their sessions, and a Telegram DM when the owner is the
  Telegram DM owner. On the day: the account shows *expired*, publishes refuse
  with the sentence above, the log records each refused attempt.
- If LinkedIn grants refresh tokens (Pages / Community Management API), the
  server refreshes silently before expiry and the warning moves to the refresh
  token's own expiry.

### 7. UI

A **Connected accounts** section at the top of the Secrets panel (this is the
"simpler secret creation" the operator asked for): *Connect LinkedIn*; per
account a row with label, *via*, expiry (amber under 7 days, red expired),
share, policy, *Reconnect*, *Disconnect*, *Log*. Switching to `autonomous`
asks for confirmation spelling it out: *"Agents in <scope> will be able to post
as <label> without asking anyone."*

### 8. Company Pages (v1.1, after LinkedIn's approval)

Connect requests the organization scopes as well; after the callback the
instance lists the Pages the person administers and offers each as an account
(`kind: organization`, `connectedVia` = that person). Reconnect by another Page
admin replaces `connectedVia` — this is the departure case.

## Operator tasks (outside the code, on the critical path)

1. A LinkedIn **Company Page** for Shadok (an app must be attached to one).
2. The LinkedIn developer app *Shadok*: products *Sign In with LinkedIn using
   OpenID Connect* and *Share on LinkedIn*; redirect URL
   `https://connect.shadok.ai/linkedin/callback`; logo/name as shown on the
   consent screen.
3. **File the Community Management API request now** (Pages).
4. DNS `connect.shadok.ai` → the Worker; Worker secrets: client id, client
   secret, state HMAC key. Who holds the Cloudflare account and the LinkedIn
   app admin role is the operator's decision.

## Rollout (my calls)

Every merge publishes to alpha instances, and the broker / LinkedIn app are not
live yet, so:
- the broker URL is configurable (`SHADOK_CONNECT_BROKER`, default
  `https://connect.shadok.ai`), so a builder runs a local or staging Worker
  (`wrangler dev`) against a test LinkedIn app;
- the *Connect* button appears only when the broker answers `GET /health`
  with the provider listed — no flag to forget, and a cockpit whose broker is
  down says *"LinkedIn connection is unavailable right now"* instead of
  opening a dead page. Already-connected accounts keep publishing (the broker
  is only on the connect path);
- PR order: (1) broker + its tests, deployed; (2) instance side. Each PR is
  inert alone.

## Verify first (builder, before relying on it — all from memory)

1. *Share on LinkedIn* is self-serve and grants `w_member_social`; with
   `openid profile` it gives `userinfo` → `sub`.
2. Member access token lifetime (believed 60 days) and **no refresh token** for
   a standard app; whether Community Management API approval brings refresh
   tokens.
3. Maximum length of `state` LinkedIn round-trips (the signed state is ~250
   chars); if too short, the broker keeps nothing still by putting the public
   key in the start URL and only a signed digest in `state` — redesign before
   building, do not truncate.
4. Posts API: endpoint (`/rest/posts`), the `LinkedIn-Version` header, the
   author URN, image upload (`initializeUpload` then PUT), and the **escaping
   rules of the `commentary` field** (reserved characters such as `( ) [ ] { }
   @ # * _ ~ < > \ |` must be escaped or text is silently cut) — this is the
   single most likely source of "the post came out mangled".
5. App-level rate limits, since every instance shares one app.

## Left to the builder

- Exact route names and file layout; reuse of `isBrowserPerson`,
  `agentPrincipal`, the hidden loopback notice, `historyWithOffers`' merge.
- The card's markup, following the existing approval-card skin and invariant 43
  (show exactly what will be published).
- How the daily expiry check is scheduled (server timer, not a cron prompt).
- Worker code and its deployment (wrangler), kept in this repo under `broker/`
  (my call) so it is reviewed with the instance side.

## Tests (intended)

- Pure: `accountVisible` across private/groups/instance × person/agent,
  including "launcher owns it, agent in a shared group → not visible".
- Pure: `returnUrl` validation (https, loopback/private http, refuse public http,
  fixed path); `state` sign/verify; single-use nonce.
- Crypto round-trip: encrypt with WebCrypto as the Worker does, decrypt with
  `node:crypto`; wrong nonce/AAD fails.
- Publish gate: an agent can never call `/social/drafts/:id/publish` (agent key,
  peer token, no-Origin client → refused); `approve` policy never publishes
  from `POST /social/posts`.
- Token never in: the skill's output, `GET /social/accounts`, the log, the
  agent's env (assert all four — invariant 24's discipline).
- Commentary escaping against the reserved-character list from Verify-first 4.
- Expiry: warning at J-7, refusal sentence after expiry, refusal logged.

## Docs in the same PR

README (connected accounts, the skill, the operator setup), `docs/architecture.md`
(broker + store + publish gate), CLAUDE.md map rows for the new modules.
