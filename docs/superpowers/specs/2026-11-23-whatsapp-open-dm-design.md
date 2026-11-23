# WhatsApp: anyone who writes to the instance's number gets their own agent

Design, drafted 2026-11-23 and checked once against the code by a reader in
the builder's seat. Approved 2026-11-23. Status: step 1 (the seam, linking and
the panel) implemented; steps 2 and 3 not yet.

## Intent

Telegram already has open DMs
([design](2026-11-11-telegram-open-dm-design.md)): a stranger who writes to the
bot gets a dedicated agent, in a restricted group and on a profile an admin
chose, and always lands on the same one. The requester wants **the same thing
on WhatsApp** — in their words, "the same as with Telegram, except it is
WhatsApp": conversations in DM, **one contact = one agent**, open to anyone who
has the number.

One instance links ONE WhatsApp number. Each person who writes to it talks to
an agent of their own. The operator reads those conversations in the cockpit,
inside the configured group, and can take the hand. As with Telegram, shadok
provides the plumbing and the profile provides the job.

This is the WhatsApp twin of Telegram's `dm-only` mode: there is no board
group, no owner and no operator on the WhatsApp side. Every DM is a guest's,
including the admin's own.

## Why an unofficial client

Decided by the requester, with the alternatives in front of them. The official
Cloud API was ruled out for three reasons that are properties of the API, not
of our code: free-form messages are only allowed for 24 hours after the
person's last message (a cron report or an agent notification falls outside
it), its terms have barred general-purpose AI assistants since January 2026,
and it needs a business account, a dedicated number and a public webhook per
instance.

So the instance connects as a **linked device** of an ordinary WhatsApp
account, the way WhatsApp Web does. That is outside WhatsApp's terms of use.
The consequence is accepted and must be SAID to the admin in the panel: the
number can be restricted or banned, so it must be a number one can afford to
lose.

## What a throwaway spike measured (2026-11-23)

A script linked a test number with the candidate Node library and answered DMs.
These are observations, not assumptions; the design leans on each of them.

1. **Pairing by code is broken** in the current release of that library against
   today's servers (a known, unmerged upstream fix). **Pairing by QR code
   works**, first try. The QR payload rotates: the first lives about a minute,
   the following ones about twenty seconds.
2. Right after the scan the server closes the stream with "restart required"
   and the client must reconnect at once; that is the normal end of linking,
   not a failure.
3. **A first message can arrive with no content.** The server delivered the
   stanza with an `unavailable` marker instead of a ciphertext: the sender's
   phone had not encrypted for the freshly linked device. The library asked the
   account's own phone to resend it and got no answer. Three messages in a row
   were lost this way. **As soon as the linked device had written to that
   sender once, every later message arrived readable.** Whether this hits every
   new sender or only the minutes after linking is NOT yet known.
4. Senders are addressed by an opaque **LID** (`…@lid`), not by their phone
   number; the phone number came along as a separate attribute.
5. Text both ways, an inbound voice note (ogg/opus) and an inbound photo all
   worked, each under a second. Outbound files were not exercised.
6. A relaunch on the stored session reconnected in about a second with no QR.
7. How long a link holds unattended is being measured (48 hours); the result
   decides the library (see "The library").

## Goals

1. An admin links a WhatsApp number to the instance from the cockpit, sees
   whether the link is alive, and can unlink it.
2. An admin opens the door by naming **a restricted group** and **a profile**.
   Both or nothing, exactly like Telegram's option.
3. A DM from anyone spawns an agent on that profile, in that group, bound to
   that sender.
4. **The same person always lands on the same agent**, with its history, for as
   long as the channel exists.
5. The person can send text, pictures, documents and voice notes, receives the
   agent's answers and the files it hands over, and can answer the questions
   their agent asks.
6. The operator sees and drives the agent from the web like any other; what
   they type there appears in the person's chat (the Telegram decision, kept).
7. A link that died says so in the panel — never a "connected" that is not.

## Non-goals

- **No WhatsApp groups, no status, no channels/newsletters, no calls.** A
  message from any of those reaches nothing and gets no answer.
- **No owner, no board, no commands.** Nothing typed in WhatsApp reaches the
  command dispatcher; `/spawn`, `/secret`, `/login` and friends stay in the
  cockpit and on Telegram.
- **No cap on the number of guests, no queue, no per-person block, no arrival
  notification** — the Telegram decisions, unchanged, for the same reasons.
- **No pairing by phone-number code** while it is broken upstream. The panel
  shows the QR code directly, which removes the reason to want it.
- **No second number per instance.** Nothing can stop the same account from
  being linked to two instances — both would answer — so the panel and the
  README say not to, and that is all.
- **No message editing.** Telegram edits a provisional message in place; here
  every message is sent once.
- **No reading of what the account's owner types from their own phone** into a
  guest's chat. Only the sender's messages are prompts.
- **No change in Telegram's behaviour.** Helpers that are already exported and
  transport-neutral (`chunk`, `makeSendQueue`, `makeTyping`, `promptFrame`,
  `attachmentPrompt`, `isStalePreface`, the transcription and video paths) are
  imported from where they live. What both bridges need but is closed inside
  `startTelegram` today (the file hand-over, the wait for a session's media
  directory, the stream and dialog handling) may be lifted into a shared module
  — moved, not rewritten, with Telegram's tests green and untouched. Copying it
  is the worse choice: the two copies would drift.
- **Mono-tenant instances are not served.** A restricted group cannot exist
  there, so the whole feature is refused with the existing capability refusal,
  like Telegram's option.

## Anti-goals — failures even if it "works"

- **A WhatsApp binding stored in the Telegram field.** `Channel.telegram`
  carries a numeric `chatId`, and code all over the system reads its SIGN:
  `isHomeChannel`, `mergeChannels`, `reattachDmBridges`,
  `adoptOwnerFromBindings`, `reconcileWebChannels`. A phone number written
  there would be reattached as a Telegram chat, could make a WhatsApp sender
  the Telegram owner, or — negative — become an undeletable home channel. The
  binding gets its own field and the Telegram code never sees it.
- **A guest's agent landing anywhere but the configured group.** Same rule as
  Telegram: resolved from the configuration by the server, asserted, and a
  resolution that does not produce the configured group refuses to answer at
  all (the `guest-group` failure), never a fallback to the commons.
- **One person, two agents.** A sender may be seen under a LID and under a
  phone-number address. Keying the binding on whichever shows up would give the
  same person a second agent with no history the day the addressing changes.
- **A dead link shown as alive**, or a link that silently stops receiving.
- **A message lost across a server restart.** The server restarts on every
  auto-update; what arrives meanwhile must be answered once the bridge is back.
- **The account's credentials within an agent's reach.** The stored session IS
  the WhatsApp account. It never enters an agent's environment and lives where
  a guest group's Unix user cannot read it.
- **A stranger's text read as something the server wrote** (invariant 61), or a
  WhatsApp sender believed about who they are on any ground but the connection.
- **The bridge writing first.** It never opens a conversation with a number
  that has not written to it. What it MAY do, as on Telegram, is write again
  later to someone who has: an agent's scheduled report, a notification, the
  operator typing in the cockpit. There is no path that takes a number as input
  and sends to it.
- **A stranger driving Claude Code itself.** The server submits a message that
  starts with a command name bare, so the terminal runs it: `/clear` would erase
  the continuity this feature promises, `/login` or `/model` are worse. Telegram
  guests are stopped by `guestCommandRefusal`; this bridge has no dispatcher to
  stop them, so the protection must be built (see "A person's message").
- **A guest's conversation published elsewhere.** A WhatsApp channel must never
  be offered "Mirror to Telegram", nor be picked up by the loop that creates a
  board topic for a mirrored web channel.
- **Telegram behaviour changing** because WhatsApp was added.

## Constraints

1. **Transport seam.** Everything that knows the library sits behind one narrow
   interface (`link`, connection-state events, inbound-message events,
   `sendText`, `sendFile`, `setTyping`, `unlink`, `stop`). The bridge and the
   server import the interface, never the library. Two reasons: the library is
   not chosen yet, and a fake transport is the only way to test the bridge end
   to end without a phone.
2. **The library is not a hard dependency of the server.** It is loaded when
   WhatsApp is configured; an install without it, or a library that fails to
   load, leaves the cockpit and Telegram untouched and shows a plain reason in
   the panel.
3. **Session storage** lives under `~/.shadok-ai/whatsapp/<instance key>/`,
   mode 0700, on the data volume, so a container recreate does not unlink the
   number. One instance, one session; the existing per-launch-dir lock already
   prevents two servers on one directory.
4. **Identity of a sender.** The binding key is one canonical id per person.
   Prefer the LID when the transport knows it, and resolve a phone-number
   address to its LID before looking a channel up; store the phone number
   beside it for display only. The id is untrusted input: anything derived from
   it for a path is REBUILT from digits (`wa-<digits>`), never sanitised — the
   rule `guestWorkDirName` already follows, extended rather than bypassed.
5. **Own identity on the wire.** The WhatsApp bridge connects to our server
   with the internal cookie AND its own per-process secret, which yields its
   own connection fact and its own origin, `whatsapp`. It is never taken from
   the frame. Every place that enumerates origins must learn it — at least the
   context-header gate (`⟦whatsapp · time · name⟧`), `promptAuthor` (whose
   `from` is believed), the spoken-message flag (honoured only for `telegram`
   today) and the secret audit's `spawnActor`. A socket that proves neither
   secret and sends `guest: true` or `origin: "whatsapp"` gains nothing.
6. **Guest rules are reused, not copied.** `guestSpawnPlan`, `guestPatchFlow`,
   `guestEnableRefusal`, `guestGroupChoices`, `withInstanceMember` and
   `guestNotice` already express the feature; they learn that a second bridge
   exists. The WhatsApp setup is stored separately from Telegram's, and the
   server picks the setup by which secret the socket proved. Two real traps:
   `guestKey` is typed as a number today, and **membership of the instance in
   the group is shared** — the instance leaves a group only when neither setup
   still targets it.
7. **The registry decides a resume** (invariant 1) and **a browser sync must
   never drop a bridge-bound row** (invariant 6): the new binding field is
   server-owned and joins `mergeChannels`' keep-rule.
8. **Reattach** (invariant 7): at boot and in the periodic loop, a channel with
   a WhatsApp binding, no bridge and a live agent gets its bridge back. Never
   for an idle channel — that would respawn an agent under every past guest.
9. **The page's CSP** allows no external script or image. The QR code is
   rendered from the payload by the server or by code shipped with the page.
   The payload is served only to a signed-in admin's browser: an agent's
   session key passes some admin GETs, and must never obtain it.
10. **Multi-tenant AND migrated.** The existing refusal only looks at the
    deployment mode. On a multi-tenant instance whose groups are not migrated
    yet, commons agents still run as the server's own user and could read the
    stored session. The feature is refused there too.
11. **A message is not acknowledged into thin air.** The library acknowledges
    on receipt, while a prompt can sit in memory for the seconds an agent takes
    to spawn. What was received and not yet submitted survives a restart (a
    small persisted inbox with the seen ids, or a deferred acknowledgement),
    and the fake transport models acknowledgement and offline delivery — or the
    restart test proves nothing.
12. **Ending is explicit.** A channel closed in the cockpit loses its binding;
    the person's next message starts a new agent. An inferred absence (a link
    that dropped, a session that expired) never ends an agent (invariant 72).

## How — the parts decided here

### Linking, and the panel

The Telegram panel is a token field. This one is a journey with states, and the
panel shows exactly one of them at a time:

| State | What the admin sees |
|---|---|
| Not linked | What linking means, the ban warning, a "Link a number" button |
| Linking | The QR code, refreshed by itself at each rotation, the three steps to do on the phone, a cancel button; expires back to "Not linked" if nobody scans |
| Connected | The account's name and number, linked since when, connected since when |
| Reconnecting | Same identity, "connection lost N minutes ago, retrying" |
| Unlinked remotely | Why (removed from the phone, session closed by WhatsApp), and "Link again" |
| Unavailable | The library is missing or failed to load, with the reason |

Below the state, when a number is linked: the **open-DM settings** (restricted
group and profile pickers, both or nothing, same pickers and same refusals as
Telegram's), an on/off switch, and **Unlink**, which logs the device out on
WhatsApp's side and deletes the stored session.

Admin-only, and every write is browser-only, like `PUT /telegram`. The state is
read by polling while the panel is open; the QR payload is never logged.

The "restart required" close that follows a scan is part of linking: the panel
goes from Linking to Connected without ever showing a failure.

### The binding

A channel gains a server-owned `whatsapp` binding holding the linked account
it belongs to and the canonical sender id (plus the phone number, for display).
It has its own lookup, its own reattach rule and its own place in
`mergeChannels`. `telegram` stays what it is. A channel has at most one of the
two, and that is enforced: a WhatsApp-bound row is skipped by the Telegram
mirror loop and its tab offers no "Mirror to Telegram". The tab shows a
WhatsApp mark where a Telegram-bound one shows Telegram's.

Because the binding names the account, **unlinking keeps the agents** and
linking the same number again resumes them, while linking a DIFFERENT number
starts everyone afresh — nobody lands on a history that belongs to another
number.

The channel is named after the sender's WhatsApp display name, as Telegram
guests are named after theirs.

### A person's message

- Ignored outright: groups, status, newsletters, calls, the account's own
  messages, history replays, anything already seen (dedup on the message id).
- A DM opens (or resumes) that person's bridge. A new one sends the guest
  marker and the sender id; the server resolves group and profile from the
  WhatsApp guest configuration, creates the guest's own directory, asserts the
  group, and spawns with no worktree — the Telegram path, with a second
  trusted bridge.
- Text is the prompt. A picture or a document is saved to the agent's media
  directory and announced with the existing attachment line. A voice note is
  transcribed with the existing transcription and marked as spoken. A video
  goes through the existing video path. A caption rides with its file.
- Typing shows while the agent works.
- **An unreadable first message** (finding 3) gets ONE plain line asking the
  person to send it again — which is also what makes their next message
  readable. At most once per person per few minutes, so it can never loop. If
  the content arrives later through the library's own resend, it is processed
  normally and the dedup keeps it single.
- **Nothing a guest types is a command.** The bridge neutralises a leading
  command name so the text reaches the agent as text, and — because a bridge is
  not where a guarantee should live — the server refuses to submit a bare slash
  command from the `whatsapp` origin. Both have a test.
- An unreadable message never spawns an agent; only a readable one does.
- **The door switched off** means silence: no agent is spawned and no line is
  sent, to new people and to known ones alike. Telegram answers "this bot is
  private"; here every automatic reply to a stranger is a risk for the number.
  Existing agents are kept and answer again when the door reopens.

### The agent's answers

- Markdown becomes WhatsApp's own formatting (bold, italic, strikethrough,
  monospace, quotes, lists); headings become bold lines, links become
  `text (url)`, tables become plain lines. Long answers are cut at paragraph
  boundaries. No HTML, and nothing an agent writes can be read as markup the
  bridge did not intend.
- A file the agent hands over (`ShadokFile` / `SendUserFile`) is read with the
  agent's rights through the existing reader and sent as a picture when it is
  one, as a document otherwise. The size cap is the reader's own (50 MB); its
  error text names Telegram today and becomes neutral.
- **Questions.** WhatsApp has no reliable buttons on this path, so a dialog is
  a numbered list. The person answers with the number; for a multiple choice,
  several numbers; for an option that takes free text, the number and then the
  text, or directly a sentence when the dialog has exactly one free-text
  option. Anything else gets one line restating how to answer. The parsing is a
  pure function with tests; it produces the same `choose` / `toggle` /
  `confirm` / `freetext` frames Telegram's keyboard does.
- Every line the bridge says about itself (busy, stopped, unreadable message,
  how to answer) goes through the one guest-wording door, `guestNotice`, which
  gains those occasions. Fixed English and no cockpit vocabulary, as on
  Telegram: WhatsApp gives no language signal to do better with.
- A busy agent is handled as Telegram does (`shouldPreempt`).
- What the operator types in the cockpit reaches the person labelled as it is
  on Telegram (`promptEchoLabel`).
- Sends go through one queue per conversation, in order, with a small spacing.

### Connection life

Reconnect with backoff on any drop except a logout. A logout moves the panel to
"Unlinked remotely" and stops retrying; the stored session is kept until the
admin links again or unlinks. Messages the server holds while we are away are
delivered on reconnect and handled then (anti-goal: nothing lost across a
restart). Each state change writes one log line; none carries a message body
or a full number.

### The library

Behind the seam, so the choice does not shape the rest. The candidates:

- a Node WebSocket library: an ordinary npm dependency, light, which the spike
  ran on. Against it: little recent upstream activity, a release candidate for
  months, pairing by code broken and unfixed;
- a Go library that is far more actively maintained and is the reference
  implementation of this protocol. Against it: a helper binary to build and
  ship per platform, in a product distributed through npm.
- A browser-driving library (a full Chromium per instance) and stand-alone
  gateways (one more service to run) are not candidates.

**Decision rule:** the Node library if the 48-hour run shows no unexplained
loss of inbound messages and no drop it does not recover from by itself.
Otherwise the Go helper — but a binary shipped inside an npm-distributed
product is a packaging decision of its own, so that outcome goes back to the
requester before anything is built on it. Either way the seam, the fake
transport and everything above them are identical.

## Suggested order of work

Each step ends in something that can be verified on its own.

1. The seam, a fake transport, the session store, linking and the panel's
   states. Verifiable: link, see Connected, kill the link from the phone, see
   it said, unlink.
2. The binding, the guest configuration, text both ways, reattach and resume.
   Verifiable with the fake transport end to end, then on a real number.
3. Media in, files out, voice notes, questions, the unreadable-message line.

## Left to the builder

- The names of the new module(s), config fields, endpoints and WS fields.
- Whether the QR code is drawn by the server or by a small encoder shipped with
  the page, within constraint 9.
- The exact spacing of the send queue and the backoff curve.
- How the canonical id is resolved when only a phone-number address is known
  and the transport cannot map it — as long as the same person never gets two
  agents, and a test says so.
- Where the shared-membership rule of constraint 6 lives.
- The directory name: a `wa-` twin of `guestWorkDirName`, rebuilt from the
  digits of the id with any device suffix dropped first. Whether an id fits a
  JavaScript safe integer is NOT established — treat it as a string of digits.
- Whether the pending inbox of constraint 11 is a file or a deferred
  acknowledgement.

## Calls made while writing this — to confirm or overturn

The requester asked for "the same as Telegram" and these were settled on that
basis rather than asked one by one:

1. An agent may write again, unprompted, to someone who wrote before (cron,
   notification, operator). Never to a number that has not written.
2. A guest's phone number is stored and shown to the members of the guest
   group — the people who already chose to read those conversations — and to
   nobody else.
3. The door switched off is silent, for everyone.
4. Unlinking keeps the agents; a different number starts afresh.
5. An unreadable first message gets one line and spawns nothing.
6. The operator's words reach the person labelled as on Telegram.

## Verification

- Pure rules unit-tested: Markdown conversion, dialog-reply parsing, id
  canonicalisation and the directory name, the inbound filter, the state
  machine of the link, the membership rule shared with Telegram.
- The bridge end to end against the fake transport on a side instance: a first
  message spawns in the configured group and nowhere else; the second lands on
  the same agent; a restart in between loses nothing; a channel closed in the
  cockpit unbinds.
- `test/channels.test.ts` learns that a WhatsApp-bound row survives a browser
  sync and is never treated as a Telegram chat.
- On a real number, in a multi-tenant test container: link by QR from the
  panel, text, picture, document and voice note in, a file out, a single-choice
  and a multiple-choice question answered, a message sent while the server is
  restarting, the link removed from the phone, a relink, then a different
  number.
- One check per anti-goal that the list above does not reach:
  - a guest sending `/clear` and `/login`: the agent receives text, nothing runs;
  - a socket without the bridge's secret sending the guest marker or the
    `whatsapp` origin: refused, and its `from` not believed;
  - the stored session unreadable by a guest group's Unix user (checked on the
    test container, as that user), and the feature refused on a mono-tenant
    and on an unmigrated instance;
  - no code path sends to an id that is not an existing binding;
  - a link that stops receiving WITHOUT a logout (a dead socket) leaves
    "Connected" within a bounded time;
  - the same person seen first under a phone-number address and then under a
    LID lands on one agent, end to end with the fake transport;
  - a WhatsApp-bound channel never gets a Telegram topic;
  - the library absent: the cockpit boots, Telegram works, the panel says why;
  - Telegram and WhatsApp guests on the same group, one switched off: the
    other still spawns.
- Telegram's own tests stay green untouched.

## Docs that ship with it

README (a "WhatsApp" section beside Telegram's, with the ban warning and "one
number, one instance"), `docs/architecture.md` (the seam, the binding, the
link's states, the module rows), `docs/invariants.md` (one binding field per
transport, never a shared one; a bridge with no dispatcher still owes the
command refusal) with its index line in `CLAUDE.md`, and one line in the pilot
prompt so an agent knows the `whatsapp` platform exists in its context header.
