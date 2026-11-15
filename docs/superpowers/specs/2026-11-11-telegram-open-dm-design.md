# Open DMs: a stranger who writes to the bot gets their own agent, in a group of its own

Design, approved 2026-11-11. Status: not implemented.

## Intent

Today a DM to the bot belongs to exactly ONE person. `dmGate` answers `pair`
(no owner yet — present the cockpit's pairing code), `allow` (you are the
owner) or `deny`, and a `deny` gets one line: "⛔ This bot is private." That is
the right default and it stays the default.

This feature opens a second door, deliberately, on an instance configured for
it: **anyone** may write to the bot, and each person who does gets a dedicated
agent of their own, living in a group chosen by an admin. The operator reads
those conversations from the cockpit, inside that group, and can take the hand.

In the requester's words: an instance can be configured so that a "random" user
sends a DM and talks to a dedicated agent in a group reserved for that; the
agent's **profile** — chosen in the same panel — is what defines its job
(support, or anything else); and "a user must always land on the same agent".

The shape to keep in mind: shadok provides the plumbing, the profile provides
the job. Nothing here knows what support is.

## Why now

Three things that did not exist when DMs were first locked down now do.

- **Groups that isolate** (`src/groups.ts`). A non-public group carries its own
  Unix user (`osUserFor` → `sk-<id>`, provisioned before the group is persisted)
  and is visible only to its members (`canSeeGroup`; an admin is NOT exempt).
  That is the receptacle this feature needs, and it is why the option cannot be
  enabled without naming one.
- **Profiles as a job description** with real guardrails (`deny`/`allow`,
  secrets, model). An operator opening their bot to strangers is handing those
  strangers a role, and the role is where the limits live.
- **`connectionOrigin` and `markHumanPrompt`** (invariant 61,
  [detail](../../invariants.md#inv-65)): who is speaking is decided by the
  connection, and text a person types can never pass for a header, a ledger
  block or a hiding mark the server wrote. Every door before this one was
  manned by someone trusted. This is the first where the person typing is
  trusted with nothing at all, so that rule stops being hygiene and becomes the
  floor the feature stands on.

## The receptacle, and why it is a RESTRICTED group

The requester asked for a **private** group. That word names something specific
in this codebase, and it cannot be used here — a correction that came out of
the builder check, verified in the code:

- A private group is a **Personal** space, one per account, auto-provisioned on
  invite redemption (`newPrivateGroup(accountName, …)`, `privateGroupFor`). It
  cannot be created: `POST /groups` refuses it outright — "a personal group is
  created automatically, not here" (`createGroupFlow`, `src/osusers.ts`) — and
  `mergeGroupsPut` seals it ("a personal group is sealed and cannot be
  changed").
- The bridge could never enter one. It drives as `BOOTSTRAP_ADMIN` (`"admin"`,
  via `currentAccount` → `isInternalClient`), and that name is **reserved for
  the instance password**: `loadAccounts` refuses to create it, so it is a
  member of nothing. `canSeeGroup(aPrivateGroup, "admin")` is always false —
  which would have refused the spawn AND, after any restart, the resume
  (`canResumeAs` runs on that path too).

So the receptacle is a **restricted** group — the one non-public kind a person
can create. What that buys, stated exactly:

- its own Unix user, so guests' agents are walled from the rest of the instance
  (this is the same wall a private group has);
- visible only to its members, so nobody else in the cockpit sees those
  conversations;
- **but** its members may administer it and read it. "Invisible even to an
  admin" is a property of a Personal group and is NOT claimed here. The member
  list is therefore the whole access decision, and that is where it belongs:
  you choose who reads strangers' conversations by choosing who is in the
  group.

**The instance is a member of that group.** Enabling the option adds
`BOOTSTRAP_ADMIN` to the chosen group's `members` (and disabling removes it) —
done by the server, never typed by a human. This is what lets the bridge spawn,
resume and drive a guest's session, and it reuses the one membership primitive
(`memberOf`) instead of carving a new exemption into the group wall. Two
consequences, both verified:

- it does **not** open the group to every agent on the instance. An agent
  principal is judged on its own channel's group (`viewerFor` →
  `agentGroup`, `viewerInGroup`), never on the name `"admin"`.
- it does mean a browser signed in with the **instance password** sees that
  group — which is exactly what makes the operator's view work on an instance
  that has no named accounts.

**Multi-tenant only.** A non-public group cannot exist outside multi-tenant:
`createGroupFlow` applies `capabilityRefusal(mode)` to every non-public nature,
and `ensurePrivateGroupProvisioned` is a documented no-op there ("there are no
private groups"). So the option is refused on a mono-tenant instance, with that
same refusal primitive, rather than offered and quietly useless.

## Goals

1. An admin can open the bot's DMs, for this launch directory, by naming **a
   restricted group** and **a profile**. Both or nothing: the option cannot be
   enabled with either missing.
2. A DM from someone who is not the owner spawns an agent on that profile, in
   that group, bound to that DM.
3. **The same person always lands on the same agent**, with its history, for as
   long as the channel exists.
4. That agent is invisible to anyone outside the group, and runs as the group's
   own Unix user.
5. A guest can talk, and answer the questions their own agent asks them.
   Nothing else — no command reaches the dispatcher.
6. The operator sees the agent in the cockpit and drives it like any other.
7. Nothing the cockpit says to itself is said to a guest.

## Non-goals

- **No cap on the number of guests, and no queue.** Decided by the operator
  after the costs below were put in front of them: "we leave it like that, we'll
  see in use." The costs are real and are written down in Constraints so the
  next reader does not have to rediscover them.
- **No per-person block.** Turning the option off closes every guest DM at once;
  blocking one individual is a follow-up, to be built if usage asks for it.
- **No notification when a new guest arrives.** The agent appearing in the
  group IS the signal.
- **No self-service reset for a guest** (no `/end`, no "new conversation"). It
  follows from goal 5 and from goal 3: a guest who could end their agent could
  erase the very continuity this feature promises.
- **No change to the owner's DM**, to the board group, or to operators. An
  owner does not become one guest among many.
- **No greeting written by shadok.** The first answer comes from the profile.

## Anti-goals — things that would make this a failure even if it worked

- **A guest's agent landing anywhere but the configured group.** Silently
  falling back to the commons would publish a stranger's conversation to
  everyone on the instance. The spawn must be ASSERTED (invariant 24,
  [detail](../../invariants.md#inv-24)), and a resolution that does not produce
  the configured group must refuse to answer the guest at all.
- **A wall that is announced and not there** (invariant 47,
  [detail](../../invariants.md#inv-51)). Hence the exact wording above: own Unix
  user and member-only visibility, administrable by its members, and nothing
  about invisibility to an admin who is in it.
- **An allowlist quietly bypassed.** An admin who restricted the bot to named
  chats (`allowedChats`) has said something explicit; opening DMs must not
  reach around it.
- **A guest becoming the owner or an operator**, by a code, a deep link, or a
  race.
- **A guest's conversation wedged with nothing on screen.** See constraint 9:
  this is the failure mode a correct-looking implementation ships with.
- **A stranger's text read as something the server wrote.** Already prevented
  (invariant 61); it must stay prevented, with a test that says so.

## Constraints — measured, not assumed

**1. "Always the same agent" is already true, for free.** `bindKey` returns
`private:<chat.id>` for a DM, and in a DM the chat id IS the user's id. The
channel registry is keyed by that binding (`channelForTelegram(chatId)`), which
is what `bridgeFor` already consults before opening a session. So the
person→agent mapping needs no new storage: it is the channel row. Confirm it end
to end rather than take it on trust, but do not invent a
`telegram-guests/<enc>.json` before that check fails.

**2. A guest's agent never dies on its own.** `detach` (`src/server.ts`) arms
the idle-reclaim timer only when `s.clients.size === 0`, and a Telegram bridge
IS a client. A web agent whose tab you close is reclaimed after
`SHADOK_IDLE_MIN` (60 min default); a DM-bound agent stays resident for as long
as the instance lives. One hundred guests is one hundred `claude` processes in
tmux, permanently.

**3. The quota is shared, and the guest is TOLD when it runs out.** The pace
guard (invariant 14) refuses a prompt past the ideal pace, and the bridge
announces it in the chat: "⏸️ pace guard: … Your message was not sent — retry
later." That is the cockpit talking to a stranger about the operator's
subscription. See constraint 8.

**4. Every auto-update replays the herd.** Beyond ~30 concurrent
`claude --resume` the upstream OAuth refresh-token race trips, which is why
`restartAllSessions` is serial. A large guest population turns each update into
a long parade.

**5. The group comes from the configuration, never from the wire**
(invariant 49, [detail](../../invariants.md#inv-53)). A `group` in a `start`
frame is a request to be judged, not a fact, and `/ws` is reachable by every
`Origin`-less loopback client (invariant 11). The configured guest group is
server state — the same category as `parentGroupId`, which is honoured without a
`canSeeGroup` check precisely because it is read from server state and not from
the client. So the server reads the config itself; the bridge's job is only to
say "this is a guest DM from Telegram user X".

**6. That last claim is trustworthy on exactly one socket.** The bridge
presents `x-shadok-bridge` (a per-process secret passed to `startTelegram`),
which is what makes `connectionOrigin` resolve to `telegram` and what makes
`from` believable at all (invariant 61). A guest marker must be believed under
the same condition and no other.

**7. A guest channel cannot be named by the existing path.** `persist()` forces
a threadId-less channel's name to `"general"` — correct for the board's General,
wrong for every guest, who would all be upserted under one name. Naming a guest
after its sender (`senderName`) is new work on that override, not an affordance
already there.

**8. The bridge speaks cockpit to whoever is listening.** Besides the pace line,
a guest's DM would receive "— session ended —" (the `exited` event), "⚠️
couldn't send …", "♻️ restarting the agent to apply secrets…" and the rest of
the bridge's own vocabulary. Tool activity is already off by default
(`tgToolsEnabled`), but a file a profile hands over bypasses that switch by
design. Everything the bridge says on its own behalf must be reconsidered for a
guest: muted, or rewritten in words that make sense to someone who does not know
what shadok is.

**9. A dialog would wedge a guest's conversation, permanently and silently.**
`handleCallback` refuses every DM callback whose `dmGate(…) !== "allow"`. The
agent runs in the instance's permission mode and any profile may ask an
`AskUserQuestion`: the guest would receive the question's preface, click, be
refused — and nothing times out. The conversation dies with no error anywhere.
A guest must therefore be able to answer the keyboard **of their own DM**, which
is driving their own conversation, not a new power.

**10. After a restart, a guest's bridge may never be rebuilt.** Both
reconcilers return early when no board group is bound
(`loadTgGroup() === null`), and `reconcileOnBoot` additionally skips every
channel with no `threadId` — which every DM is. `reattachLiveBridge` itself
handles a DM correctly (`shouldReattachBridge` keys on the bound CHAT, not the
topic, and logs "DM"), so the gap is only in who calls it. Inbound traffic
recovers by itself (`bridgeFor` resumes from `channelForTelegram`); an agent
speaking **unprompted** — finishing a long task, a cron — reaches nobody. An
instance that opens its DMs for support may well have no board group at all, so
this stops being a corner case: DM reattachment must not depend on a board
binding. Same family as invariant 7.

## How — the parts decided here

### The configuration: one option, two solidary fields

Per launch directory, through `PUT /telegram`, which is already admin-only and
browser-person-only. Three fields, named by the builder: the switch, the
**group** id, the **profile** name. Enabling with either missing is **refused**,
not silently half-applied — the requester's own rule ("you cannot enable it
otherwise"). Enabling also writes `BOOTSTRAP_ADMIN` into the group's members,
and disabling removes it (see the receptacle section). A change restarts the
bridge, like the rest of that panel; `telegramState()` and the
`hasConfigChange` test must both learn the new fields.

The picker lists the **restricted** groups out of `GET /groups`, already
filtered by `listableGroups` — a group the caller may not see is not in the
list. That is not a nicety: it is where the authorisation for "may I put
strangers here?" actually lives.

### The gate: a fourth verdict

`dmGate` gains `guest`, returned when the option is on, an owner **exists**, and
the sender is not the owner. It stays pure and unit-tested, like today.

Two orderings are load-bearing. `allowedChats` filters **before** the gate, as
it does now — an explicit allowlist keeps winning. And `pair` keeps priority
over `guest`: while the bot has no owner, the only message that gets anywhere is
a valid pairing code. Open DMs apply only to an instance whose bot is already
owned, which also keeps a deep-link `/start <code>` from a stranger on the
pairing path it is already on, with its existing refusals.

The callback gate (`handleCallback`) gains the same verdict, for the guest's own
DM only (constraint 9).

### The guest's first message

- The bridge opens a session marked as a guest's; the server resolves the group
  and the profile **from the configuration** (constraint 5) and stamps the
  channel's group.
- The channel is named after the sender (constraint 7 — the `"general"`
  override has to be taught about guests).
- **No worktree.** A stranger's agent has no business holding a checkout of the
  operator's repository; it runs in its own group's home
  (`agentStateHome(<the group's user>)`), which is also the only directory that
  user can write in. This is a deliberate departure from what a board `/spawn`
  does.
- Nothing synthetic is said while the agent is born: the typing indicator is
  already started when the message is received, and the first words are the
  profile's.

### What a guest may not do

**No commands at all.** Not "no operator commands":
`commandRequiresOperator` is an allowlist of the privileged ones, and what it
leaves open (`/stop`, `/tools`, `/new`…) is still the cockpit's machinery. A
`/anything` from a guest DM gets one plain line and never reaches the
dispatcher. A guest is never an operator and never the owner; `isOperator` is
untouched.

### What the operator sees, and the one risk they accepted

The agent appears in the group and is driven from the web like any other —
including from a browser signed in with the instance password, since the
instance is a member. **The web echo stays visible in the guest's DM** — the
operator's decision, taken knowingly: it is also the way to speak to the person.
The consequence is stated here rather than engineered away: an instruction typed
in the cockpit ("tell them we won't refund") is printed verbatim in the
stranger's DM. If that becomes a problem in use, the fix is a per-channel echo
switch or a note prefix, and it is a separate change.

## Left to the builder

- Where the guest spawn reads the configuration: a marker on the frame resolved
  server-side, or a dedicated internal path. The rule to preserve either way —
  group and profile come from the config, never from the wire.
- Which of the bridge's own messages a guest should see, and in what words
  (constraint 8). The list is short and reading it once is the work.
- Whether DM reattachment is lifted out of the board-group early return, or the
  reconcilers are reordered (constraint 10). Either is fine; leaving it is not.
- The panel's copy and layout, and the refusal text outside multi-tenant.

## Verification

Pure, unit-tested: the new `dmGate` verdict over every combination of owner /
sender / option; the configuration refusal when a field is missing; the
command refusal; the guest callback acceptance.

Asserted end to end, on a free port, never on 3789: that a guest's channel comes
out of the spawn with **`group` equal to the configured one** and the configured
profile. Invariant 24 exists because a field accepted in `start` was never
stored and only a real run showed it; this feature's whole safety rests on that
one field, so a test must observe it rather than infer it.

Not verifiable here, and it must be said in the PR rather than implied: the
**real Telegram round trip**. The bot token is keyed by launch directory and a
second instance would steal the long-poll from the live cockpit, so the final
confirmation — a stranger's DM producing an agent in the group — is the
operator's, on their own instance.
