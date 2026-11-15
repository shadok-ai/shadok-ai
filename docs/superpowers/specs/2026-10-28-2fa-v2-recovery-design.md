# Two-factor v2 — recovery levels, two-admin approvals, a Security panel — design

Follows `2026-10-21-passkey-2fa-design.md` (shipped as #280). That version made
a stolen password useless on its own. This one closes what is left around it:
the **recovery** paths, which are now the easiest way in, and the fact that the
person concerned is never told.

## Intent

The flow the requester validated on 2026-10-28 (ledger `[41eb]`), and how each
point is read:

| Decided | Reading |
|---|---|
| Synced passkeys accepted | Unchanged from v1: any passkey with user verification. iCloud / Google sync is the normal case, not an exception. |
| Email is a notification channel with a "this wasn't me" button, **not a factor** | **No sender exists yet** (answered 2026-10-28), so v2 ships the channel IN THE COCKPIT: a *Security* panel with every notice and every pending action, and the "this wasn't me" button there (§ 6). Email is a second delivery of the same notices, added once a sender exists (§ 7) — never a factor: a mail link only does what an admin already decided, or blocks. |
| An admin never sets a password | Already true (invitation links). Kept, and extended to every reset. |
| A fresh passkey for every admin action | Today only reset, enrollment codes, passkey deletion and the 2FA switch ask for one. Inviting, deleting an account and changing a role do not. All of them will. |
| 2 admins to promote/demote an admin and for the bypass | A second admin approves, with their own passkey. "The bypass" = the immediate full reset (below). |
| Lost password → a link sent by 1 admin | Level 1. Passkeys are kept. |
| Lost passkey, password known → 2 admins approve, then a link | Level 2. |
| Lost everything → full reset effective after 24 h, or at once if a 2nd admin approves | Level 3. Cancellable during the 24 h by the target or any other admin. |
| No mandatory second passkey | Unchanged. |
| No emergency procedure | Unchanged: shell on the machine ("we call Gnarco"), v1 § 8. |

Plus two gaps found while reading the code, both in the same spirit:

- **A reset does not end the sessions already open.** The cookie carries no
  version of the account, so a session stolen before the reset stays valid
  after it, and a lost phone that was signed in stays signed in.
- **Invitations last 7 days.** Down to 48 h.

Success:
- a lost password is fixed by one admin, and the person keeps their passkeys;
- one admin alone (or someone riding their session) can no longer strip
  anyone's second factor, nor make anyone admin;
- every reset, new device, invitation and promotion is shown to the person
  concerned and to the admins in one place, with what is waiting on whom, and
  "this wasn't me" stops it;
- after any reset, every session opened before it is dead;
- with no mail sender (the case today), all of it works; links are handed over
  by the admin, as now.

## Threat model

Same boundary as v1: anything running as the machine's OS user is out of scope
(soft isolation, invariant 26). What v2 adds against:

- **one compromised admin** (password + their phone, or a ridden session) —
  can no longer reset someone's passkeys, promote an accomplice or demote a
  defender without a second admin;
- **a recovery request made behind the user's back** — the user and every
  other admin see it in the Security panel and can stop it;
- **a stolen session** — dies at the next reset or block.

The honest limit without mail: a notice only protects someone who opens the
cockpit. The 24 h of level 3 are worth what the other admins' attention is
worth — which is why every admin sees, and may cancel, a pending full reset,
not only its target. Email (§ 7) widens that to people who are not looking.

Once mail exists, a compromised mailbox can press "this wasn't me" (a denial
of service an admin undoes) and read a level-1 link — which still needs the
passkey the attacker does not have, since level 1 keeps it. That is the point
of email not being a factor.

## Design

### 1. Storage

On `Account`:

```ts
email?: string;               // normalised lower-case; unique per instance
sessionsAfter?: number;       // a session cookie issued before this is refused
locked?: { at: number; by: "self" | string };  // "this wasn't me", or an admin
```

Pending two-admin requests, beside the accounts
(`~/.shadok-ai/users/<key>.requests.json`, 600):

```ts
interface AdminRequest {
  id: string;                                     // random, 16 bytes base64url
  kind: "passkey-reset" | "full-reset" | "promote" | "demote";
  target: string;
  by: string;                                     // the admin who asked
  createdAt: number;
  approvedBy?: string;                            // the second admin
  effectiveAt?: number;                           // full-reset: createdAt + 24 h
  cancelToken: string;                            // "this wasn't me" from a mail (§ 7, later)
  done?: number;
}
```

At most one open request per (target, kind); a new one replaces it. An
unapproved request expires after 48 h. Done/expired rows are pruned on write.

Events for the Security panel: § 6. Mail settings, later: § 7.

Below, "**notified**" means: an event in the Security panel for the target
(and the admins where stated) — and a mail too, once § 7 exists.

### 2. Sessions die with a reset

`readSessionFull` returns `{user, mfa}` today; it also returns `issuedAt`.
`currentAccount` and `cookieAccount` then refuse a cookie whose `issuedAt` is earlier
than the account's `sessionsAfter`, or any cookie of a `locked` account. Set
`sessionsAfter = now` on: every reset level when it takes effect, a block, a
demotion, and the deletion of a passkey (the lost device's session goes with
it). The same check covers a WebSocket upgrade, which is authenticated by the
same cookie.

Bootstrap admin and the Telegram bridge's internal cookie have no account row
and are unaffected.

### 3. Fresh passkey on every admin write

`stepUpOk` (v1) is added to `POST /users` (invite), `DELETE /users`,
`POST /users/role` and every route below. With 2FA **off** nobody has to own a
passkey, so the step-up applies only while 2FA is on — the same condition
under which v1's existing step-ups are meaningful.

### 4. The three recovery levels

All three start from the target's row in the Users panel (**Recover access…**,
which asks which case it is) and are refused on oneself (v1 rule).

**Level 1 — lost password, passkeys kept.** One admin, fresh passkey. The
password hash is removed, a reset link `/invite/<token>` (48 h) is issued and
shown to the admin to hand over; the target is notified; the passkeys stay. Redeeming sets a new password — and, with 2FA on,
the redeemer must then pass a **passkey assertion** with one of the kept
passkeys before the session is issued. A link that only sets a password would
otherwise be a way around the second factor for whoever intercepts it.
`sessionsAfter = now` at issue.

**Level 2 — lost passkey, password known.** Admin A asks (fresh passkey) →
request `passkey-reset`, the target is notified ("an admin asked to let you
register a new device"), the other admins see it in *Waiting for you*. Admin
B ≠ A, ≠ target approves (fresh passkey). On approval: an enrollment code is
minted (v1 § 4, but 48 h, since it is handed over by another channel) and
shown to both admins; the existing passkeys are kept (the user
deletes the lost one from their list once in, or an admin does);
`sessionsAfter = now`. Password + code → register → session `mfa=1`, the v1
enroll path unchanged.

**Level 3 — lost everything.** Admin A asks (fresh passkey) → request
`full-reset`, `effectiveAt = now + 24 h`; the target and every admin are
notified with the date, and any of them may cancel. Until then nothing
changes on the account. Then:

- admin B approves (fresh passkey) → effective at once (the "bypass");
- or `effectiveAt` passes → effective on the next action that reads it.

No timer: the request is *applied* when an admin opens the Users or Security
panel or asks for the link (both reads apply due requests), so a restart loses
nothing and there is no scheduler to keep alive. Applying = password and
passkeys removed, `sessionsAfter = now`, a reset link issued (48 h) and shown
to admin A to hand over. Redeeming it asks for
a password then registers a passkey (the v1 invitation path with 2FA on).

### 5. Promote / demote an admin

With 2FA **on**: admin A asks (fresh passkey) → request `promote`/`demote`;
admin B approves (fresh passkey) → applied, target notified. `keepsTwoAdmins`
(v1) still refuses a demotion that would leave fewer than 2 admins with a
passkey — checked at approval, on the state at that moment.

With 2FA **off**: one admin, as today. Requiring two would deadlock the very
step that creates the second admin, and 2FA cannot be switched on before two
exist anyway (v1 § 6), so the two-admin rule is in force exactly when it can be
satisfied.

### 6. The Security panel — notices and pending actions

One place, in the cockpit, for everything this design makes happen. A header
icon (beside Users) with a badge counting what **needs you**; the panel has
four parts:

- **Waiting for you** (admins) — requests another admin made that you may
  approve: level 2, the level-3 bypass, a promotion or demotion. *Approve* /
  *Refuse*, each with a fresh passkey. Your own requests never appear here (you
  cannot approve yourself).
- **Your requests** — what you asked, its state (waiting for a second admin,
  level-3 countdown to its effective time), *Cancel*.
- **About you** (everyone) — notices concerning your account: a recovery
  asked / approved / effective / cancelled, a passkey registered or deleted, a
  promotion or demotion. Each carries **This wasn't me**. Unread until opened.
- **Security log** (admins) — every event, newest first: who, what, on whom,
  when. The audit trail a second admin needs to judge a request.

**Events** are one list, written by the routes that do the thing:
`~/.shadok-ai/users/<key>.events.json` (600), `{ id, at, kind, actor, target,
requestId?, label? }`, bounded (last 500 or 90 days). Read state is per
viewer (`seenBy`). `GET /2fa/inbox` returns the four parts for the caller; the
badge is fetched on load and every 60 s — notices are not chat, a minute is
fine.

**This wasn't me**, from the panel (so from a signed-in person):

- on a request: cancels it;
- on a passkey registered: deletes that passkey;
- in every case: `sessionsAfter = now` on the account — every OTHER session
  dies, this one is re-issued — and a *flagged* event reaches every admin.

From a mail link (§ 7, later), where the clicker has no session, it also sets
`locked`: whoever clicks may be the only one who knows the account is taken.

A locked account cannot sign in; an admin unlocks it (fresh passkey).

**Who sees level 3**: the target and every admin, and every admin may cancel
it — not only the two involved. Same for a block: every admin.

### 7. Email — later, once a sender exists

No sending account exists today, so v2 ships without mail; the panel is the
channel. When one is configured, the same events are ALSO mailed, and nothing
else changes:

- **Addresses.** `email` on the account, set by the admin at invitation;
  afterwards changed only by the user themself (fresh passkey), the old
  address notified. An admin cannot change someone else's: it is where that
  person's alarms go.
- **What is mailed**: each event of § 6 to its target; a block to every admin;
  the invitation and reset links to their recipient.
- **"This wasn't me" by mail**: `<publicUrl>/alert/<token>`, reachable without
  a session like `/invite`, single use, 7 days, one wording for every refusal;
  same effect as from the panel, plus `locked` (§ 6).
- **Transport**: `nodemailer` over `SHADOK_SMTP_URL` (vault), sender and
  `publicUrl` per instance in `config.json`. A send never blocks the action; a
  failure is logged by event and recipient domain (never the link) and the
  admin is shown the link to hand over — today's behaviour.

Storing `email` can ship with v2 (the invitation form asks for it, optional),
so addresses are there when sending starts.

### 8. Invitations

`INVITE_TTL_MS` → 48 h. The link is shown to the admin, as today (and mailed
too, once § 7 exists).

### 9. Pure rules (tested)

In `src/twofactor.ts`, beside v1's verdicts:

- `requestVerdict({ actor, kind, target, accounts, twoFactor })` — who may ask;
- `approveVerdict({ request, approver, now })` — admin, ≠ asker, ≠ target, not
  already approved, not expired;
- `requestDue(request, now)` — level 3's clock;
- `sessionAlive({ issuedAt }, account)` — the `sessionsAfter` / `locked` rule;
- `inboxFor(viewer, events, requests, now)` — the four parts of the panel and
  the badge count;
- `notMeEffect(event)` — what "this wasn't me" undoes for each kind.

When mail lands (§ 7), its transport is injected (`sendMail`), tested with a
recording fake and end-to-end with nodemailer's `jsonTransport` — no network.

## Rollout

The recovery levels and two-admin rules apply once 2FA is on. Otherwise only
these change, all strictly tighter: 48 h invitations, `sessionsAfter` on
resets, and the Security panel (which also logs what happens with 2FA off).

Verification before merge: Chromium with a CDP virtual authenticator (as v1),
three admins, each level run to completion and once stopped by "this wasn't
me" from the panel; a level-3 request cancelled by a third admin; a session
opened before a reset proved dead after it.

## Out of scope

Email as a factor or a magic-link sign-in; SMS; recovery codes; a mandatory
second passkey; per-event mail preferences; an emergency path beyond the shell
on the machine.

## Decided since the first draft (2026-10-28)

1. **Mail provider: none for now.** Hence the Security panel as the channel
   (§ 6) and email deferred (§ 7).
2. **Level-3 notices**: the target and every admin; every admin may cancel.
3. **A place for pending actions**, asked by the requester: the Security
   panel's *Waiting for you* and *Your requests*.
