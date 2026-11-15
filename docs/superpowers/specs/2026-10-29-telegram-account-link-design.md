# Telegram ↔ web account: one person, one identity

Status: design, approved 2026-10-29. Not implemented.

## Intent

A teammate who writes from Telegram shows up in the cockpit as a stranger.
`isOwnPrompt` (`public/echo-author.js`) says so in one line:

```js
if (origin && origin !== "web") return false;
// "Only a web prompt can be yours: another platform is another person, or nobody."
```

That assumption was true while Telegram was one shared mouth. It is not true any
more: the same humans drive the cockpit from both doors, and several of them have
a web account **and** a Telegram account. The reporter's own words: *"quand
j'écris sur telegram, j'ai l'impression que c'est quelqu'un d'autre"*.

The cockpit should recognise the **person**, not the door. This design adds one
thing: a Telegram person can be **associated with a web account** by an admin.
Everything that names who acted then names the account.

### Why now

- **#326** put other people's prompts on the left. The split was invisible while
  every human bubble looked the same; now your own Telegram message visibly
  arrives as somebody else.
- **#336** (secret audit log) carries the same conflation one level deeper: its
  principal chain is `peer > parent agent > cron > telegram > web account`, where
  `telegram` and `web account` are two *different* kinds. A `/secret` posted from
  Telegram is recorded as `telegram <display name>`, never as the account of the
  person who posted it.
- **#321** (multi-tenant scoped isolation, spec merged) enumerates "Telegram
  listings and command dispatch" among the points where a future ACL must filter
  by caller identity — and never says who the caller *is* on Telegram. There is
  no answer in the build today. This design is that answer, and nothing more.

Note for anyone reading this alongside those: **private groups do not exist in
the build.** PR #332 was closed without merging, so there is no visibility layer
to hook into yet. What a link changes today is attribution; what it makes
*possible* is the Telegram half of #321.

## Goals

- An **admin** can associate a Telegram person with a web account, from the web.
- Once associated, every place the cockpit names who acted names the **account**:
  the prompt bubble's side and label, the context header the agent reads, and the
  secret audit `actor`.
- The association is the identity hook the Telegram half of a future ACL needs,
  so #321 can be built on it without inventing identity a second time.

## Non-goals

- **No self-service link.** Decided by the human: an admin does it. A member
  cannot claim an account.
- **DMs stay single-owner.** `dmGate` keeps refusing everyone but the adopted
  owner. A link does not open a DM channel, tempting as that is — see anti-goals.
- **No retroactive history.** Messages sent before a link keep the author they
  were stored with.
- **Not a replacement for `allowed chats`.** Which chats the bot answers at all
  is unchanged.
- **No new rights for anyone.** See "The baseline rule".

## Anti-goals

Each of these would make the feature a failure even if it worked:

- **A link obtainable from a group chat.** A code typed into the board would be
  read by every member, and a code that binds a Telegram id to an account is a
  way to *become* that account. There is no private channel to a teammate (DMs
  are single-owner), so there is no code-based flow at all.
- **Authorising on a name.** A Telegram display name is chosen by its owner and
  can be changed at will; `senderName()` can return `@handle` or nothing. The
  **numeric Telegram user id** — supplied by the Bot API on every message, not
  settable by the sender — is the only key. See "Names label, links authorise".
- **An unlinked member losing an access they have today.**
- **A Telegram id reaching more than the account it maps to.**

## The baseline rule (decided)

**The baseline stays the baseline; a link only ever adds.**

- Whoever is in an allowed chat keeps exactly what they can do today, linked or
  not. Nothing is gated behind linking.
- What a link adds — the account's name on their messages, the account in the
  audit log, and (when #321 lands) membership-based visibility — is **never
  reachable by staying unlinked**.

So nobody loses an access, and nothing private opens to someone the cockpit
cannot name. The link is additive in both directions, which is also what makes it
safe to ship before any ACL exists.

## How (decided)

### 1. A roster of Telegram people

Nothing in the build records who has ever written from Telegram, so "pick the
person from a list" has no list to offer. One is needed: every non-bot sender the
bot **answers** is recorded — **id, last display name, `@handle` as its own
field, last seen, which chat** — in a per-instance file beside the existing ones
(`~/.shadok-ai/telegram-roster/<enc-launch-dir>.json`, 600), keyed like channels,
crons and the ledger.

- Bounded: one row per person, superseded on each message (the ledger's rule, not
  an append log).
- Names only, no message content.
- **Recorded after the gates, never before.** A sender refused by the allowlist
  or by `dmGate` leaves no row: the roster is a list of people the instance
  already serves, not a guest book of everyone who found the bot.
- **The allowlist is usually empty**, and the check is `if (allowed.length && …)`
  — so "a chat the bot answers" means *every chat it has been added to* on a
  typical instance. The picker can therefore contain people an admin does not
  know, which is why the row carries the handle and the chat: picking the wrong
  row is precisely how the last anti-goal gets violated.
- The roster is **not** an authorisation list. It is what the admin picks from.

### 2. The link is keyed by account NAME, in its own file

The obvious home — a field on `Account` (`src/accounts.ts`) — cannot hold the one
link that matters most. **The bootstrap admin has no `Account` row**: it lives in
`SHADOK_GUI_PASSWORD`, `currentAccount` synthesises `{name: "admin", role:
"admin"}` for it, and `userWriteVerdict` *refuses* creating a row named `admin`
("reserved for the instance password"). On a typical instance that principal is
the person who reported this bug, and an instance with a password and no accounts
file has no row at all. A field on `Account` would make the reporter the one
person who cannot be linked.

So the link lives in its own per-instance map, keyed by **account name**:

```
~/.shadok-ai/telegram-links/<enc-launch-dir>.json   (600)
{ "<account name>": { id: 123456, name?: string, linkedAt: number, by: string } }
```

`"admin"` is a valid key — `src/security-events.ts` already treats it as a name
("an account name, or `admin` for the instance password"), so this is the
existing convention, not a new one. `name` is the display name at link time, kept
for the panel so an admin can see who they picked; it is never used for matching.
`by` is the admin who did it, for the same reason the audit log exists.

**One id ↔ one account**, both ways, and a collision is **refused explicitly**
rather than silently re-pointed — the discipline `secretWriteVerdict` and
`linkRefusal` already follow. A pure verdict function (`telegramLinkVerdict`) is
the one place that policy lives: not an admin → refused; an account that is
neither in `loadAccounts()` nor the bootstrap admin → refused; id already linked
to another account → refused, naming it; account already linked to another id →
refused unless the caller asked to replace. **Unlinking is a first-class
operation** (`id: null`), not a re-point: a mis-link must be undoable without
having to blame someone else for it.

One free convenience: on most instances the bootstrap admin is also the adopted
DM owner, whose numeric id is already on disk in `…-telegram-owner.json`. The
panel may offer that as a pre-filled suggestion for `admin`. Optional.

### 3. Resolution happens in the bridge, and nothing new goes on the wire

The Telegram bridge runs **inside the server process** and dials a WebSocket to
127.0.0.1 (`src/telegram.ts`; one bridge per `{chat, thread}`). It is therefore
the one place that holds both the Telegram message — id included — and the account
store, and the `prompt` handler already trusts it to name its sender:

```ts
// src/server.ts, the one prompt handler
const author = promptAuthor(origin, me?.name, msg.from);
// "The Telegram bridge is trusted to name its sender — it knows it. A browser is
//  not: for a web client the SESSION decides."
```

So the resolution belongs **before** the frame is built, not after it: an
`authorFor(from)` helper wraps `senderName()` with the link lookup and replaces it
at the `promptTo(...)` call sites (plain message, attachment, transcribed voice
note, and the album buffer, which stores a per-item `from` and must store the
**resolved** name). `promptAuthor`, the WS protocol, `promptmeta` and the client
are untouched.

The alternative — a new `fromId` field on the `prompt` frame, resolved in
`promptAuthor` — was rejected, and not only for being more code. `origin` is a
per-connection claim from the `start` frame, and by invariant 11 every
`Origin`-less loopback client reaches `/ws`: pilotctl, the CLI, agents, crons. Any
of them can already claim `origin: "telegram"` with any `from` it likes, which is
today's (cosmetic) status quo; honouring a linked **id** off the same frame would
turn that into a forgeable claim to *be* an account, printed in the agent's
context header and written into the secret audit log as `actor`. Resolving
in-process keeps the id where it cannot be asserted by anyone else, and keeps the
new field out of invariant 24's trap entirely.

### 4. Names label, links authorise — never the other way round

With resolution done at the source, a linked person's `from` **is** their account
name, so the client's test collapses to `from === me` and works identically live
and on replayed history (where the stored header is the only identity left).

That comparison is **cosmetic, and stays cosmetic.** Two consequences, stated
rather than engineered away:

- A Telegram member who sets their display name to exactly a viewer's account
  name will have their bubbles drawn on that viewer's right. Likewise, creating an
  account named like an unlinked person who has already written makes those stored
  headers read as that account. Both require already being in the board, both are
  a drawing side and a label, and **neither grants anything**. Fixing them with a
  reserved character in account names was considered and dropped: it buys a
  cosmetic guarantee with a rule in two places (`userWriteVerdict` and the
  renderer) and an ordering check, and the project's own `admin`-shaped names and
  email-shaped names make the reserved character arbitrary.
- The part that must be sound already is: **the audit log never compares names.**
  `src/telegram.ts` records an unlinked sender as `telegram <display name>` (the
  `telegram ` prefix is #336's, and no bare account name can equal it) and a
  linked one as the account name itself. `via` stays `telegram` either way:
  **`via` is the door, `actor` is the person.** "Stéphane, from Telegram" is a
  fact the log cannot express today.

**The rule this leaves for #321, and it is the load-bearing one:** an ACL must
authorise on the **link** (the id resolved in the bridge), never on the name that
came out of it. A name is a label for humans to read; the id is the identity.

`isOwnPrompt`'s full truth table, which is what the tests pin:

| `auto` | `origin` | `from` | `me` | own? |
|---|---|---|---|---|
| yes | — | — | — | no (unchanged) |
| no | absent or `web` | empty | — | **yes** (a cockpit with no accounts) |
| no | absent or `web` | set | unknown | **yes** (`/me` in flight — never flash your own history left) |
| no | absent or `web` | set | known | `from === me` |
| no | any other door | empty | — | **no** |
| no | any other door | set | — | `from === me` |

The nameless non-web row is a real fix, not a formality: `senderName()` returns
`undefined` when a sender has neither name nor username, and an anonymous group
admin carries no `msg.from` at all. Dropping the origin veto without that row
would land those messages on the viewer's **own** side — this feature's
misattribution, inverted.

"Any other door" is matched as *not* (`web` or empty), never by listing doors:
`origin` here can be `telegram vocal` (the platform field of a transcribed voice
note, recovered by `parsePromptMeta` on replay), and an allowlist of door names
would silently lose it. A cron needs **no** branch and must not get a dead one:
the server sends no `prompt-echo` for `origin === "cron"`, and `loadHistory`
hides cron prompts, so a cron never reaches this function.

### 5. Where an admin does it

The accounts panel (admin-only) gains the link: per account, the Telegram person
it maps to, pickable from the roster, with the refusals above surfaced as
refusals. The endpoint follows the shape its three siblings already have
(`POST /users`, `DELETE /users`, `POST /users/role`), in order:

`accountAdmin(req, res)` → `telegramLinkVerdict(...)` → `stepUpIfTwoFactor` →
write → `recordEvent({ kind: "telegram-linked", actor: me.name, target: account,
detail: <handle or "unlinked"> })`.

Two deliberate differences from `POST /users/role`: linking does **not** go
through the dual-admin `askRequest` flow, and it does **not** set
`sessionsAfter`. Both exist for a privilege change, and by the baseline rule a
link grants no privilege. It is still a security **event**, because the Security
panel's purpose is that an account changed and the owner can say "not me".

Admin-only is enforced **server-side** by the verdict function, never by hiding a
control.

## Left to the builder

- Roster pruning and its cap.
- The endpoint's exact spelling (`PUT /users/telegram` vs widening an existing
  route); `userWriteVerdict`'s shape is the precedent.
- The panel's layout.
- Whether a Telegram `/whoami` is worth adding so a linked person can see which
  account they are; not required by the goals.
- Migration: nothing to migrate. No link exists, every account starts unlinked
  and behaves exactly as today, and the roster fills itself as people write.

## Verification

- Pure cores unit-tested: `telegramLinkVerdict` (every refusal, including the
  bootstrap admin as a valid target and `id: null` as a valid unlink), the roster
  upsert, `authorFor` with and without a link, and `isOwnPrompt` against the
  table above row by row.
- End to end against a real instance on a free port — the class invariant 24
  names, and `authorFor` touches five call sites: send a plain message, an
  attachment, a voice note and an album from a linked person, and assert the
  **stored transcript header** carries the account name in each, that the web
  bubble sits on the right after a reload, and that a `/secret` from that person
  lands in the audit log as `actor: <account>`, `via: telegram`.
- One negative test on the wire, because it is the rejected design's whole point:
  a loopback client claiming `origin: "telegram"` with a `from` equal to an
  account name must not become that account anywhere that authorises.
- Docs ship with it: `CLAUDE.md` (the `src/telegram.ts` and `src/accounts.ts`
  rows, plus the names-label/links-authorise rule as an invariant),
  `docs/architecture.md` (identity resolution in the bridge), `README.md` (an
  admin-facing sentence on linking).
