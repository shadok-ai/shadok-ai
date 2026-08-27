# Web accounts: a login, and a name on every prompt

Date: 2026-08-27
Status: validated, ready for an implementation plan

## The ask

A notion of login for the web cockpit, so that we know **who** is connected and
send that with the prompt.

## What already exists — and why this is smaller than it looks

The "who spoke" pipeline is already built, end to end:

- `ClientMessage` already carries `{ type: "prompt", text, from? }`;
- the server re-broadcasts `from` to the other clients as `prompt-echo`, **and**
  prefixes it into the agent's real prompt through `promptMetaHeader`;
- `public/echo-author.js` already renders it (`Alexandre · telegram`), with tests.

The Telegram bridge fills `from` with the sender's name. The **web is the only
client that leaves it empty**, because it has nobody to name. So this feature is
not about plumbing an author through — it is about giving the web an identity to
put in a field that is already there and already tested.

## Decisions

| Question | Decision |
|---|---|
| Security boundary or label? | Real accounts. The existing GUI password **is** the `admin` account. |
| Roles | `admin` and `member`. |
| What does a role gate? | **Only account management.** A member does everything a user does today. |
| No `SHADOK_GUI_PASSWORD`? | Feature dormant: no auth, no login screen, no `from` — exactly today's behaviour. |
| How is an account created? | The admin issues a **single-use invitation link**; the invitee chooses their own password. The admin never knows it. |
| Session mechanism | A signed cookie, no session store. |
| Scope of the account list | **Per instance** (per launch directory), not per machine. |

## 1. Where accounts live

`~/.shadok-ai/users/<encoded-launch-dir>.json`, mode 600 — the same scoping as
channels (`channels/<enc>.json`), crons and the instance lock.

Per instance rather than global is the consistent choice, not the surprising one:
`SHADOK_GUI_PASSWORD` is already **per process** (read from the env at startup),
so accounts now share the scope of the door they extend. Profiles and the secret
vault are the global exception, not the rule.

A record:

```json
{ "name": "alex", "role": "member",
  "passwordHash": "<scrypt>", "createdAt": 1756300000000,
  "invite": { "token": "<random>", "expiresAt": 1756900000000 } }
```

`scrypt` comes from Node's `crypto` — no dependency is added. `invite` is present
only until the link is redeemed.

**Consequences to accept**, both stated up front:

- Ten instances on one machine means ten account lists. Creating a member
  everywhere means doing it everywhere.
- An instance relaunched from a different directory loses its accounts, exactly
  as it already loses its channels and crons.

## 2. The bootstrap admin

`SHADOK_GUI_PASSWORD` stays the door and **is** the `admin` account. It is not
stored in `users.json`; it is recognised at login and yields `{ name: "admin",
role: "admin" }`.

With no password configured, everything stays dormant: no auth, no login screen,
no `from`. An existing single-user install notices nothing.

## 3. The session

Cookie: `sk_auth = <user>.<issuedAt>.<HMAC>`. Every request verifies the
signature **and** re-reads the account list, so deleting an account or changing a
role takes effect immediately — no session store to keep alive across the
auto-update restarts, which happen several times a day.

The signature uses a **dedicated per-instance secret** (`~/.shadok-ai/users/<enc>.key`,
600, drawn once, persisted), **never exported into an agent's environment**.

This last point is load-bearing. `SHADOK_GUI_PASSWORD` currently leaks into every
agent's env (measured on three production agents on 2026-08-23). Signing sessions
with it would let any agent mint a cookie for any user — a leak that is merely
untidy today becomes impersonation once accounts exist. The new secret is
therefore excluded from the spawn env alongside it.

Trade-off accepted: there is no "sign this session out". Revocation is per
account, not per session. A session list can be layered on later without
changing this design.

## 4. Who spoke

For web clients the **server stamps `from` from the session and ignores any
`from` the client sent**. Without that, a member could impersonate a colleague by
editing one WebSocket frame. The Telegram bridge keeps supplying its own: it is a
trusted bridge, not a browser.

Nothing else is built here — `promptMetaHeader` and `echoAuthor` already do the
rest.

**Visible consequence:** agents will now receive "asked by <name>" at the head of
web prompts, where today they receive nothing. This is the point of the feature,
but it changes what every existing agent sees.

## 5. Invitations

The admin creates `{ name, role }` with no password and gets a single-use link,
valid 7 days. The invitee opens it and chooses their password.

An unknown, expired or already-redeemed token says so plainly rather than failing
as a generic error — the difference between "this link is used up" and "something
went wrong" is the difference between asking for a new link and filing a bug.

## 6. The screen

A **Users** panel beside Profiles and Secrets: the list (name, role, "invitation
pending"), create, change role, delete. Shown to admins only — and **refused
server-side**, not merely hidden. An admin cannot delete or demote themselves
into an instance with no admin left.

## 7. Endpoints

- `GET /users` — the list (names, roles, pending invitations; never a hash).
- `POST /users` — create + issue an invitation. Admin only.
- `DELETE /users` — remove an account. Admin only.
- `POST /users/role` — change a role. Admin only.
- `GET /invite/<token>` — the page to choose a password.
- `POST /invite/<token>` — redeem it.
- `GET /me` — who the current session is, so the client can label itself.
- `POST /login` — now accepts `{ user, password }`, and still accepts
  `{ password }` alone, which means the admin.

## 8. What breaks, once

Browsers already logged in hold the old cookie shape and will have to **log in
once more**. Accepting the old token would be worse: it is precisely the one an
agent can read out of its environment.

## 9. Testing

Pure cores, unit-tested:

- `userWriteVerdict` — who may create, delete or re-role whom; refuses removing
  the last admin, and refuses a member touching accounts at all.
- `signSession` / `readSession` — round-trip, wrong signature, tampered role,
  unknown user.
- `inviteVerdict` — unknown, expired, already redeemed, valid.
- The `cwd → filename` encoding, extracted (see below).

In the browser, against a real instance: an admin invites a member, the link is
redeemed, the member logs in, sends a prompt, and their name appears both in the
other client's echo and in the prompt the agent receives.

## 10. One targeted cleanup

The `cwd → filename` encoding is copy-pasted in **six** places (`channels.ts`,
`crons.ts`, `lock.ts`, `extract.ts` ×4) with no exported helper. Rather than add
a seventh, the function is extracted and the new code uses it. The six existing
sites are left alone: rewriting them would bury this change in an unrelated diff.

## Out of scope

- Any per-role permission beyond account management.
- Any link between web accounts and Telegram identities.
- A list of active sessions, or "sign out everywhere".
