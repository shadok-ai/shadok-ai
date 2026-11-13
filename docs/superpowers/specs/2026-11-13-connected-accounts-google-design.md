# Connected accounts — Google (wave 1): Calendar, Drive files, Docs, Sheets, Gmail drafts and sending

Status: built — the broker half (PR 1) and the instance half (PR 2). Every
Google call was exercised against mocks only; the five "Verify first" items
below still need a run against the real Google app. Builds on
[`2026-11-08-connected-accounts-linkedin-design.md`](2026-11-08-connected-accounts-linkedin-design.md)
— same broker, same crypto, same store, same share model, same approval card.
This document only says what Google changes.

## Intent and the why

The operator wants agents to work in a person's Google account the way they
already post on LinkedIn: connect once from the cockpit, never paste a
credential, share the account with chosen groups/profiles, and approve what
leaves the account.

Google is free to call (quota-bound, not billed per call), so the X problem —
the app owner paying for every instance's usage — does not apply, and the
browser hand-back of the LinkedIn flow is kept as is.

What Google costs instead is **app verification**, and it depends entirely on
the scopes. Wave 1 takes the lowest class for each need, with one deliberate
exception — Gmail drafts, which the operator requires:

| Need | Scope | Google's class (verified 2026-11-13) |
|---|---|---|
| Identity | `openid email profile` | non-sensitive |
| Files the app created or the user opened with it; Docs and Sheets on those files | `drive.file` | **non-sensitive** |
| Calendar events (read + write) | `calendar.events` | sensitive (no calendar scope is restricted — verify in the console) |
| Gmail drafts + send | `gmail.compose` | **restricted** — usable by test users in Testing; leaving Testing then needs the annual CASA audit |
| Reading mail (added after wave 1 shipped, operator decision) | `gmail.readonly` | **restricted** — fine for test users in Testing; adds no new hurdle, since CASA is already required to leave Testing because of `gmail.compose` |

`gmail.compose` ("Manage drafts and send emails") covers both drafts and
sending, so `gmail.send` (sensitive) is not requested on top. It does **not**
read the mailbox. If leaving Testing without CASA ever matters more than
drafts, the fallback is `gmail.send` alone and drafts disappear — an operator
decision, not a builder's.

Deliberately **not** requested: `gmail.modify`, `drive`, `drive.readonly`
(restricted, and not needed). Agents that need the whole Drive keep using the
claude.ai connectors (the `login` agent-auth mode).

**Reading mail** was first left out, then added at the operator's request as a
FOURTH area, `gmail_read` → `gmail.readonly`, separate from `gmail` (drafts +
send) so a person can grant drafts without opening their mailbox. It is
unticked by default on the Connect dialog — opening a mailbox to agents is a
deliberate choice — and a person adds it by reconnecting
(`include_granted_scopes` merges). Nothing here can modify or delete mail.

The Docs (`documents`) and Sheets (`spreadsheets`) scopes are **not requested**:
both APIs accept `drive.file` for the files it covers, which keeps the consent
screen shorter and the scope class lower.

## Decided by the operator

- All four Google areas are wanted eventually (Gmail, Calendar, Drive/Docs/
  Sheets, YouTube/Business Profile). Wave 1 is this document; wave 2 (restricted
  Gmail/Drive, behind CASA) and wave 3 (YouTube — uploads forced private until
  the YouTube API audit, ~6 uploads/day for the whole project on the default
  quota; Business Profile — API access granted by Google on request) are later.
- The app stays in **Testing** for now: only test users added in the Google
  console can connect, and that is fine for the test phase.
- **Gmail drafts are required** (hence `gmail.compose`).
- **Two settings per Google account**, each *with approval* (default) or
  *automatic*, like LinkedIn's posting policy: one for **sending mail**, one
  for **adding events** (any event creation, update or deletion, with or
  without attendees).

## Consequences of Testing mode (designed for, not worked around)

- **Refresh tokens expire after 7 days** in Testing (Google: *"a publishing
  status of 'Testing' is issued a refresh token expiring in 7 days"*). The
  account therefore needs a weekly *Reconnect*. The expiry watch
  (`src/account-expiry.ts`) already warns before expiry; for a Google account
  in Testing it warns **2 days** before instead of 7 (a 7-day warning on a
  7-day token would fire at connect time). The broker's `/health` says whether
  the Google app is in Testing (a Worker var), so the UI can say *"Test app —
  reconnect weekly"* instead of surprising anyone.
- Only listed test users get through; anyone else sees Google's own refusal.
  The cockpit maps it to: *"This Google account is not on the test list of the
  shadok app — ask the instance operator."*
- Other refresh-token losses Google documents, all ending on the same
  *Reconnect* path: unused for 6 months; password change when Gmail scopes are
  held; user revocation; more than 100 refresh tokens per Google account per
  client id (a reconnect supersedes in place, so a person never accumulates).

## Architecture — what differs from LinkedIn

```
connect:  same as LinkedIn (browser → broker /google/start → Google consent →
          broker /google/callback → encrypted fragment → instance), plus
          access_type=offline, prompt=consent, include_granted_scopes=true
use:      instance ──▶ Google APIs with the access token (outbound only)
refresh:  instance ──(refresh_token)──▶ broker POST /google/refresh
          broker  ──(+ CLIENT SECRET)──▶ oauth2.googleapis.com/token
          broker  ──(access_token, expires_in)──▶ instance
```

### 1. Broker

- A `google` entry in `PROVIDERS`: authorize
  `https://accounts.google.com/o/oauth2/v2/auth`, token
  `https://oauth2.googleapis.com/token`, extra authorize params
  `access_type=offline`, `prompt=consent` (a refresh token is only returned on
  the first grant otherwise), `include_granted_scopes=true`. Secrets
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; var `GOOGLE_TESTING=1`.
- **Requested scopes come from the instance**, from a fixed allowlist
  (`calendar`, `drive`, `gmail` → the scopes above). The person ticks the
  areas on the Connect dialog; an unknown name is refused at `/google/start`.
  They are carried in the signed state, so the callback cannot be fed others.
- The return path stops being LinkedIn's: `RETURN_PATH` becomes
  `/connect/<provider>/done`, validated per provider. The instance serves one
  page for all providers (the provider is in the signed state, echoed in the
  fragment).
- **`POST /google/refresh`** (new, the reason this differs): Google access
  tokens last about an hour and refreshing needs the client secret, which only
  the broker holds. Body `{refresh_token}`; the broker adds the secret, calls
  Google, returns `{access_token, expires_in, scope}` — or Google's error
  verbatim (`invalid_grant` = reconnect needed). Stateless, logs nothing but the
  status. It is called **by the instance's server**, outbound, so it works for
  instances behind NAT exactly like the publish path. Abuse surface: a caller
  needs a refresh token minted for our client id, i.e. one already obtained
  through our app; Cloudflare's per-IP rate limiting is enough for wave 1.
- Disconnect revokes at Google: the instance calls
  `https://oauth2.googleapis.com/revoke?token=…` itself (no secret needed).

### 2. Store

`ConnectedAccount` gains nothing structural: `provider: "google"`,
`kind: "member"`, `externalId` = OIDC `sub`, `label` = the Google email
(people have several Google accounts; the email is what tells them apart),
`refreshToken` set, `expiresAt` = the access token's expiry, a new
`refreshExpiresAt` = connect time + 7 days while the broker says Testing, and
`policies: { mail: "approve" | "autonomous"; calendar: "approve" | "autonomous" }`
(both `approve` at connect; LinkedIn accounts keep their single `policy`, and a
Google account never reads it), and
`scopes: string[]` (what Google actually granted — the person may untick boxes
on Google's consent screen, so the granted set is read from the token response,
never assumed).

Share, profile filter, owner rules, `accountVisible` and `accountEditVerdict`
are reused untouched.

### 3. Token use on the instance

A small `src/google.ts`, twin of `src/linkedin.ts`: `accessToken(account)`
refreshes through the broker when the token has under 5 minutes left (one
in-flight refresh per account, others await it), persists the new expiry, and
maps `invalid_grant` to *expired — reconnect*. API calls are plain `fetch`,
no Google client library (the package stays dependency-light).

### 4. What an agent can do (skill `shadok-google`, twin of `shadok-social`)

Each action declares a **class**; the class decides whether an approval
setting applies, and which one:

| Class | Actions (wave 1) | Approval |
|---|---|---|
| read | `calendar list` (window, calendar id), `drive list` (app files), `doc read`, `sheet read` | never — it leaves nothing |
| read, audited (area `gmail_read`) | `gmail search` (Gmail search syntax; 20 results by default, 50 at most, paged) → id, thread, from, to, subject, date, snippet, unread, labels; `gmail read` (a message or a thread) → headers, the text body (text/plain, else the HTML stripped to text — never raw HTML; long bodies cut with a marker), attachment names and sizes (no download) | never — but **logged** (§5) |
| own-write | `gmail draft` (a real draft in the person's Gmail — nothing is sent), `doc create` / `doc append`, `sheet create` / `sheet append` | never in wave 1: it only changes the person's own drafts/files, and Drive keeps history |
| mail | `gmail send` | the **mail** setting: `approve` (default) → Gmail draft + approval card; `autonomous` → sent at once |
| calendar | `calendar create` / `update` / `delete`, with or without attendees | the **calendar** setting: `approve` (default) → approval card; `autonomous` → at once |

**Mail with approval — the Gmail draft IS the draft.** Under `approve`,
`gmail send` creates the message as a real Gmail draft *and* an approval card.
The person may open Gmail and edit it before approving. On *Send* the server
re-reads the draft (`drafts.get`) and compares it with the card's snapshot
(hash of recipients, subject, body, attachment names): unchanged → `drafts.send`;
changed in Gmail → the card is refreshed with the new content and asks again
(*"Edited in Gmail since — send this version?"*), so a person always sends what
they are looking at (invariant 43). The agent cannot update or delete a draft
that is awaiting approval (the skill refuses; only a new `send` makes a new
card). A draft that is no longer in Gmail closes the card and the agent is
told — worded as *"no longer in Gmail — deleted there, or already sent from
Gmail"*, since Gmail answers the same for both and an agent told "deleted, not
sent" would send a second copy. *Discard* on the card deletes the Gmail draft too.
Under `autonomous`, `gmail send` sends directly (no draft left behind).

Switching a setting to *automatic* asks for confirmation spelling it out:
*"Agents in <scope> will be able to send email as <address> without asking
anyone."* / *"…to add, change and delete events in <address>'s calendar
without asking anyone."* — the LinkedIn wording, same rule (only the owner,
never an admin on someone else's account).

Drive/Docs/Sheets writes have no setting in wave 1 (they stay in the
person's own files); a third setting can be added the same way if wanted.

- The **approval card** gains two renderers next to the LinkedIn post: *email*
  (from, to/cc/bcc, subject, the exact body, attachments by name) and *event*
  (title, start/end with time zone, attendees who will be mailed, location,
  description). Invariant 43: the card shows exactly what will be sent.
- `social-drafts.ts` is generalised from "a post" to "an action": a draft
  carries `{provider, action, payload}` and the publish step dispatches on it.
  Its snapshot rule stays: an attachment path is snapshotted at draft time, so
  the agent cannot swap the file after approval.
- Mail body on stdin, never argv (like `post --stdin`). Sending builds the RFC
  2822 message server-side; the agent supplies fields, not raw MIME (no header
  injection through a subject line).
- Errors are sentences the agent can relay: *"Google account 'ana@…' needs a
  reconnect (test app tokens last 7 days) — Ana can do it in Secrets →
  Connected accounts."*

**Mail is untrusted content.** Anyone can write to the person, so a mail is
where a prompt injection arrives. The skill prints everything that comes out
of the mailbox — sender, subject, snippet, body, attachment names — inside a
fence that says it is data, never instructions, closed by a marker carrying a
random tag made for that run (a mail cannot contain it, so it cannot fake the
end of the fence). SKILL.md says the same, and that replying or forwarding
still goes through `gmail send` and the mail setting: reading never sends.

**`gmail draft --update` is limited to drafts the cockpit made.** Gmail's
`drafts.update` takes any draft id of the mailbox; the server records the ids
`gmail draft` creates, per account, and refuses any other.

### 5. Log

The publication log records every outbound action and every own-write (not
reads): account, action, who triggered, who approved, a summary (recipients +
subject for mail, title + time for an event, file id + name for Drive), the
outcome. Mail **bodies are not logged** — the log is readable by everyone who
can use the account, and a mail body is more private than a public post.

Reading mail is the one read that IS logged: `gmail search` with its query and
the number of results, `gmail read` with the message (or thread) id and its
subject — never a body or a snippet. A person can see, in the account's Log,
what an agent looked for and what it opened.

### 6. UI

*Connect Google* beside *Connect LinkedIn*, opening a small dialog with the
three areas as chips (Calendar, Drive files, Gmail — all on by default) and
the Testing note when it applies. The account row shows the granted areas as
chips, the 7-day reconnect deadline in Testing, and the same Share / Profiles /
Posting footer; for Google the footer shows two chips, *Mail: with approval /
automatic* and *Events: with approval / automatic*.

## Operator tasks (outside the code)

1. A Google Cloud project for shadok; enable the Calendar, Gmail, Drive, Docs
   and Sheets APIs.
2. OAuth consent screen: External, **Testing**; app name, logo, support email,
   home page and privacy policy on a verified domain (needed for verification
   later, harmless now); declare the four scopes; add the test users.
3. An OAuth client of type **Web application**, authorised redirect URI
   `https://connect.shadok.ai/google/callback`.
4. `wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the broker.
5. Later, to leave Testing: brand verification, sensitive-scope verification
   (justification per scope + demo video; Google quotes up to 10 days), **and,
   because of `gmail.compose`, restricted-scope verification with the annual
   CASA security assessment** by an approved assessor (paid, renewed yearly).

## Rollout

- PR 1, broker: provider entry, scope allowlist, `/connect/<provider>/done`
  validation (LinkedIn's path still accepted), `/google/refresh`, tests. Inert
  until the secrets exist; `/health` lists `google` only when they do.
- PR 2, instance: generic done page, store fields, `src/google.ts`, the skill,
  the draft generalisation, the card renderers, the UI. The *Connect Google*
  button appears only when `/health` lists `google` (same rule as LinkedIn).

## Verify first (builder)

1. In the console, the class shown for `calendar.events` (expected sensitive).
2. That Docs `documents.get` / `batchUpdate` and Sheets `values.*` accept a
   `drive.file`-only token on app-created files (documented; confirm live).
3. The `scope` string Google returns when the person unticks an area, and that
   `include_granted_scopes` merges correctly on a reconnect that adds one.
4. That `refresh_token_expires_in` is present in Testing (else use the 7-day
   rule from connect time).
5. Gmail `drafts.create` / `drafts.get` / `drafts.send` with a base64url RFC
   2822 message, and what `drafts.send` does when the draft changed or vanished; header
   encoding of non-ASCII subjects and names (RFC 2047) — the likeliest source
   of "the mail came out mangled".

## Tests (intended)

- Broker: scope allowlist (unknown area refused, scopes carried in the signed
  state, not taken from the callback); per-provider return path; `/google/refresh`
  adds the secret, passes `invalid_grant` through, never echoes the refresh
  token; `/health` lists `google` only with secrets.
- Instance: refresh at < 5 min, single in-flight refresh, `invalid_grant` →
  expired; granted scopes read from the response; action class table (an
  `calendar create` without attendees still follows the calendar setting; each
setting governs only its own class); `approve` never sends from the
  agent route; publish is browser-person-only (reuse the LinkedIn gate tests).
- Gmail approval: unchanged draft → sent; edited in Gmail → card refreshed,
  not sent; deleted → card closed, agent told; agent update of a pending
  draft refused; Discard deletes the Gmail draft; `autonomous` sends with no
  draft.
- MIME builder: header injection via CR/LF in subject/to refused; RFC 2047
  encoding; body never on argv, never in the log.
- Token never in: skill output, `GET /social/accounts`, the log, the env.

## Docs in the same PRs

README (Connect Google, the skill, Testing caveats), `docs/architecture.md`
(broker refresh route, action classes), `broker/README.md` (secrets, redirect
URI), CLAUDE.md rows for `src/google.ts` and the skill.
