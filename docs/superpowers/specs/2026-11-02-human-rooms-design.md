# Rooms: channels with no agent, for people to talk

Status: **design, awaiting approval.** Nothing here is built.
Points the author settled are marked **[CALL]**; points left to the reviewer
are marked **[OPEN]**.

## Intent

Today every entry in the agents column is a `claude` process. The cockpit is
where a team works, though, and part of the work is people talking: deciding
who picks something up, sharing a screenshot, agreeing before an agent is
launched. Teams do that elsewhere (Slack, a WhatsApp group, a Telegram chat
outside the board), so a conversation about the agents takes place away from
them.

A **room** is a channel with no agent: a chat thread between the accounts of
this instance, on the web and optionally mirrored to a Telegram topic. It sits
in the same column, in the same groups, and looks like the other channels.
It **never** spawns a process, consumes no quota and has nothing to resume.

Word choice: the code and the UI say **room**. The UI already says *agent* for
a channel, and calling a room "a channel without an agent" in the UI would make
the column's title wrong.

## Non-goals (v1)

- **An agent reading or posting in a room.** v1 is people only. Agents have
  no tool to reach a room, and a session key is refused by every room route.
  A room an agent reads becomes a way to inject prompts into it, and that path
  needs its own design (see "Later: bringing an agent in").
- **Threads, reactions, edits, mentions with notifications, search.** A room
  is a flat, append-only list of messages. Each of those features can be added
  later without changing the storage.
- **Voice transcription.** A Telegram voice note in a mirrored room is stored
  as an audio file. Transcription exists so an agent can act on what was said
  (`src/whisper.ts`), and a room has no agent.
- **Turning a room into an agent, or an agent into a room.** These are two
  different objects. Creating an agent from a room is a later action on the
  room (see "Later").

## The load-bearing decision: rooms are NOT rows in the channel registry

**[CALL]** Rooms live in their own registry (`src/rooms.ts`), with their own
endpoints. They are not a `Channel` with a `kind` field and a fake
`sessionId`.

The shortcut is tempting: the column, groups, mute, Telegram binding and
persistence already work for channels. But the channel registry *is* the
answer to "which agents exist", and every consumer reads it that way. A row
with no process behind it either gets a `claude` spawned for it or confuses
something else:

| Consumer | What it would do with a room row |
|---|---|
| `openLink` (client) | sends `start` with `resume: <id>` → `claude --resume` on an unknown id opens the session picker in a new pane (invariant 36, "a short id is not a session id") |
| `reconcileWebChannels` / `shouldReattachBridge` (telegram.ts) | opens a bridge with `resumeId` → spawns an agent behind the mirrored topic |
| `firstAgentPlan` (`channelCount`) | an instance whose only entry is a room never gets its lead agent |
| `resolveSessionTarget`, cron fire, `driveChannel` | a cron could be attached to a room and "fired" into a spawn |
| `linkRefusal` / `childrenOf` (kinship) | a room becomes a valid parent to notify |
| ledger `seenFor` pruning, staleness sweep, `/live`, Telegram `/list` | all list it as an agent |
| `mergeChannels`' "never erase live/Telegram" rule | keeps it by mistake, or drops it, depending on which branch matches |

Each row is a small check, but they would all need the same check, and
forgetting any one of them spawns an agent behind a room: the one thing a room
must never do. A separate registry makes that mistake impossible. The cost is
some duplicated plumbing (a list endpoint, a group field, a mute flag), and
the client keeps it in one place (see "Web client").

## Data model

```
~/.shadok-ai/rooms/<instanceKey>.json          the room list (600)
~/.shadok-ai/rooms/<instanceKey>/<roomId>.jsonl the messages, append-only (600)
```

Keyed by launch dir like channels, crons and the ledger (`instanceKey`,
`src/paths.ts`).

```ts
interface Room {
  id: string;            // "r_" + 16 random hex chars: never a UUID, so it can never be mistaken for a session id
  name: string;
  group?: number | null; // same group ids as channels (one column, one set of groups)
  muted?: boolean;       // per room, like a channel's mute
  createdBy: string;     // account name; server-owned
  createdAt: number;
  telegram?: TgBinding | null; // server-owned, like a channel's
  mirror?: boolean;            // intent, same meaning as Channel.mirror
  archivedAt?: number;         // closed rooms are archived, never deleted (see "Closing")
}

interface RoomMessage {
  id: string;            // random, unique within the room
  ts: number;            // server clock
  author: string;        // display name: the account for web, the sender for Telegram
  account?: string;      // set when the server KNOWS the account (a web session, or a linked Telegram user)
  origin: "web" | "telegram";
  text: string;
  files?: { path: string; name: string; image: boolean }[]; // MEDIA_DIR paths, same shape as fileCard
  tgMessageId?: number;  // for the mirror: dedup and future replies
}
```

Why JSONL for the messages: appending a message is one `appendFile` and never
rewrites the history, the same reason as the secret audit log
(`src/secret-audit.ts`). Two server processes never rewrite each other's
lines. A truncated last line (a crash mid-write) is skipped on read, not
fatal.

The room *list* is a small JSON file rewritten atomically, like
`channels/<enc>.json`. It follows invariant 6: it is **never** replaced from
a client's whole list. Every write is one targeted operation (create, rename,
move, mute, archive), so a stale tab cannot erase a room. This is
deliberately not the `PUT /channels` model, which has needed `mergeChannels`,
`SERVER_OWNED`, dedup and the instance-key gate to survive.

## Server

### HTTP

| Route | Who | What |
|---|---|---|
| `GET /rooms` | any signed-in account | the non-archived list, plus a **derived** `unread` / `lastTs` per room for the caller (never stored, invariant 6's rule) |
| `POST /rooms` | browser, signed in | create `{name, group?, mirror?}` → the room |
| `PATCH /rooms/:id` | browser, signed in | `name`, `group`, `muted`; `mirror` **admin-only**, like a channel's (see the `channels.ts` row in CLAUDE.md) |
| `POST /rooms/:id/archive` | browser, signed in | close it (see "Closing") |
| `GET /rooms/:id/messages?before=<ts>&limit=` | any signed-in account | paged history, newest last |

Every write carries `x-shadok-instance` and is refused **409** on a mismatch
(`channelWriteAllowed`'s rule, invariant 35). A stale tab from another launch
dir must not create rooms here.

**Who counts as "signed in".** **[CALL]** A person: a web account (or the GUI
password's admin when no accounts exist), or the internal Telegram client
posting on behalf of a Telegram sender. **Not** an agent's
`x-shadok-session-key` and **not** a peer. Both authenticate as accounts
today (the bootstrap admin, a member). Rooms check the principal itself, the
way `/2fa*` uses `cookieAccount` (invariant 46). This is what makes "people
only" true and not just a convention. With no password at all (a local
single-user cockpit) everything is open, as it is for the rest of the
cockpit.

### WebSocket

Rooms reuse `/ws`, so the origin guard, the heartbeat and the auth gate apply
without new code. A connection is **either** an agent link **or** a room link,
decided by its first message:

- client → server: `room-join {roomId}`; then `room-post {roomId, text, files?, clientId}`
- server → client: `room-history {roomId, messages}` (the last page),
  `room-message {roomId, message, clientId?}`, `room-error {code, error}`

A socket that sent `room-join` and then sends `start`, or the reverse, is
refused. This is the server-side half of the separation above: no code path
from a room's socket reaches `createSession`.

The **author comes from the session, never from the frame**: `promptAuthor`'s
rule (`src/accounts.ts`). A `room-post` carrying an `author` field has it
ignored. The Telegram client is the one exception, and it is the same exception
as today: it names the Telegram sender, with the account resolved through the
Telegram ↔ account link when one exists
(`2026-10-29-telegram-account-link-design.md`).

`clientId` lets the posting tab replace its optimistic bubble with the stored
one 1-for-1. That is the same idea as the live preview being replaced by the
tail's block, and it avoids showing a message twice.

`room-post` refusals: empty text with no files, over 16 kB of text, unknown or
archived room. Each comes back as `room-error` with a `code`. The client hands
the text back to the composer (invariant 42's rule: a refused message is never
lost).

### Telegram mirror

A room can mirror into a topic of the board group, created with
`createForumTopic` like an agent's.

**Inbound is where the danger is.** `handleMessage` ends in
`bridgeFor(key, …)`, and a bridge *is* a session: an unknown topic gets an
agent. So the room lookup must come **before** `bridgeFor`, as the first step
after the command dispatcher: `findRoomByTopic(chatId, threadId)` → store the
message, done. A test pins it: a message into a room's topic never opens a
WebSocket to `/ws` with `start`.

Commands in a room topic (`/spawn`, `/restart`, `/secret`…) answer "this topic
is a room — there is no agent here". `/spawn` in particular must not quietly
put an agent into the topic.

**Outbound**: a web message is sent to the topic as `<b>author</b>\n<text>`,
through the bridge's serial send queue (`makeSendQueue`), so it has the same
deadlines and the same 429 handling. Messages that came *from* Telegram are
never sent back (`origin === "telegram"`). Files go through
`sendPhoto` / `sendDocument` like a `SendUserFile` card.

**Reconciling**: `reconcileWebChannels` gets a twin loop over rooms
(`mirror` → create topic, explicit `mirror === false` → delete topic). It has
the same declarative design and the same "only an explicit false deletes"
rule. Its key difference: it **never opens a bridge**.

**[OPEN]** Should a room ever be mirrored to a DM? Probably not: a DM is one
person, so a room with one person in it is a note. v1 allows topics only.

### Attachments

Web: the same `/paste` upload (`attachFile`, the 📎 / paste / drop chips) and
`/media/:name` to display them. These are user-supplied files in `MEDIA_DIR`,
and the traversal guard is the gate, exactly as today. Telegram: the existing
`downloadAttachment` into `MEDIA_DIR`, with the same 20 MB Bot API ceiling and
the same `tooLargeNotice`. A video is stored as a file. Its stills
(`src/video.ts`) exist for an agent and are not extracted.

### Closing

**[CALL]** Closing a room **archives** it: it leaves the column, its mirrored
topic is closed (not deleted), and the JSONL stays. Nothing deletes a room's
messages in v1. A conversation between people is the kind of record you want
back the week after, and "an agent's worktree is never lost" (invariant 5) has
the same reason. An admin-only hard delete can come later if anyone needs it.

**[OPEN]** Should archived rooms be listable and reopenable from the UI in v1
(the way `/recover` offers past sessions), or only on disk until someone asks?

### What rooms do not touch

Pace guard, crons, the ledger and its push, kinship, staleness, the preprompt,
`/live`, `firstAgentPlan`, the sign-in gate (a room works on an instance that
is not signed in to Claude: nothing runs `claude`). A test asserts the
negative: creating a room and posting in it leaves `loadChannels()` and the
`sessions` map unchanged.

## Web client

### One column, two kinds of entries

The column renders a merged, ordered view of `tabs` (agents) and `rooms`, so
both go into one group. Each kind keeps its own store and its own sync:
`syncChannels` stays untouched, and a `syncRooms` reads `GET /rooms` on the
same 4 s poll. The only shared code is the row rendering and the group filter
(`resolveGroupView`).

A room row has a 💬 avatar and **no** state LED (there is no busy/idle/waiting
to show). It has an unread badge instead.

To keep the separation from section 1 on the client as well, a room is **not**
a tab object: `active` can be an agent tab or a room, and every code path that
assumes an agent (`active.ws.send({type:"prompt"})`, the diff, the engine
room, the context gauge, the agent menu) is guarded on the kind. That is the
invariant 18 discipline ("`active` can be null") applied to a second shape.
The implementation should add one helper, `activeAgent()` → the tab or null,
and replace bare `active.` uses that mean "the agent". It should not sprinkle
`kind` checks.

### Creating

The creation popin (`#setupOverlay`) opens with the profile grid. A first
card, **💬 Room — no agent, for people to talk**, sits before the profiles.
Picking it collapses the agent-only options (cwd, worktree, model, effort,
secrets) and leaves name, group and, for an admin, "Also in Telegram". "Start"
becomes "Create room". A group's `＋` opens the same popin with the group
preselected.

### Inside a room

The ordinary chat, minus everything that belongs to an agent:

- Bubbles: your own on the right, others on the left with `echoAuthor`'s
  label (the #326 layout). Markdown goes through `marked` + `DOMPurify`, the
  same as an agent's (invariant 13). A person can paste HTML just as an agent
  can quote it.
- Composer: text and attachments. No `!` shell mode, no stop button, no
  interrupt, no queue (`sendQueue` exists because an agent can be busy, and a
  room never is).
- Header: name, group, mute, archive, and "Also in Telegram" for an admin. No
  profile, model, effort, diff, engine room or reload.
- History is paged: the last page on join, older pages on scroll-up
  (`GET /rooms/:id/messages?before=`).

### Unread and notification

A room's unread count is per account (a `lastRead` per account per room,
stored next to the room list and moved forward on view). `notifyState`
(`public/notify.js`) gains one input: an unmuted room with unread messages
makes the favicon pip appear. It **does not** blink. Blinking means "an agent
is waiting for your answer", and a chat message is not that. Keeping the two
signals apart is the reason both exist.

## Later: bringing an agent in (not v1, but the shape is reserved)

The obvious next request is "ask the agent about this message". The shape that
fits the rest of the cockpit is **a letter, not a member**. It is the
"talk" rule of the multi-tenant spec, applied to a room:

- A **"Send to agent…"** action on a message (or a selection) posts it as a
  prompt to a chosen agent, with a header `⟦room <name> · time · who⟧`,
  through the existing loopback (`driveChannel`), like a cron or a parent
  notification.
- The agent answers **in its own channel**. A "↪ answered in <agent>" line in
  the room links there (`buildMessageLink`). The agent never reads the room
  and never posts in it.

This keeps rooms people-only and keeps agents single-context, and it needs no
new authority. **[OPEN]** for after v1: whether an agent may *post* to a room
(e.g. a cron's daily report), which would make rooms the "announcement
channel" variant mentioned in the conversation that led to this spec.

## Multi-tenant fit

A room carries `group` like an agent, so when the group ACL of
`2026-10-29-multi-tenant-scoped-isolation-design.md` ships, rooms fall under
the same rule: **see/post = your own groups + public**. `GET /rooms` filters by
the caller and every room route checks it. Until then, rooms are visible to
every account of the instance, exactly like agents today. Rooms never run
anything, so they need none of the OS-user part of that design.

## Tests

Pure, in `test/rooms.test.ts`:
- id shape (`r_…`, never UUID-shaped), create / rename / move / mute /
  archive, the list file never rewritten from a client list;
- JSONL append and paged read, including a truncated last line;
- `unread` derivation per account;
- `room-post` refusals (empty, oversized, archived, unknown);
- author taken from the session, a frame's `author` ignored.

Boundary tests (the ones that protect the reason for this design):
- creating a room and posting in it leaves `loadChannels()` and `sessions`
  unchanged, and spawns nothing;
- a socket that joined a room is refused `start`, and the reverse;
- every room route refuses an `x-shadok-session-key` and an `x-shadok-peer`;
- a Telegram update into a room's topic is stored and opens **no** bridge (a
  fake bot + the real `handleMessage`);
- `/spawn` in a room topic is refused;
- `firstAgentPlan` still spawns the lead on an instance that has only rooms.

Then in a real browser, side by side on a free port (CLAUDE.md, "Running
YOUR build"): create a room in a group, post from two accounts in two tabs,
reload, check history and unread. Also check that the agent tabs next to it
behave exactly as before, and that the console is free of CSP and bridge
errors (invariants 10, 12).

## Docs that ship with it

- `CLAUDE.md`: a `src/rooms.ts` row, the WS messages and HTTP routes in the
  protocol section, and one invariant: *a room is not a channel; nothing that
  reads the channel registry may ever see one* (with the consumer table above,
  condensed).
- `README.md`: rooms as a user-visible feature.
- `docs/architecture.md`: the separate registry and why.

## Open decisions, in one place

1. Archived rooms: reopenable from the UI in v1, or on disk only?
2. DM mirroring: refused in v1 (author's lean), or allowed?
3. After v1: may an agent *post* to a room (announcements), and under which
   principal?
