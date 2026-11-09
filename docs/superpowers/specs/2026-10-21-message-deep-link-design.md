# Link to a message — design

## Intent

A user wants to point a colleague at one message in an agent's conversation:
"look at this". The recipient **already has access to this cockpit** (an
account, the password, or the same person on another device). Out of scope:
public / read-only links for outsiders, Telegram, messages older than the
loaded history.

Success: hover a bubble → 🔗 → a URL is in the clipboard; opening that URL
(after the usual login) lands on the right agent, scrolled to that message,
highlighted.

## What exists today

- The URL carries no state at all: no hash, no `pushState`. Which agent is open
  lives only in the client.
- Messages carry no identifier on the wire. Every `.jsonl` line has a `uuid`,
  but neither `history` nor `stream-*` forwards it.
- `loadHistory` merges consecutive assistant blocks into one turn, and keeps
  only the last 100 turns (`slice(-100)`).
- A human prompt shown live is the server's own `prompt-echo`, sent BEFORE the
  transcript has the line — so live, a user bubble has no uuid to show yet.

## Design

### 1. Message id = the transcript `uuid` of the bubble's FIRST block

Derived, never stored (the transcript already holds it). One bubble may merge
several blocks; its id is the first one's, which is the same live and on replay
because both paths already share the merge boundaries (`afterInternal`).

- `HistoryTurn.ids?` — the uuid of EVERY `.jsonl` line folded into the turn (live, each text block is its own bubble; the replay merges them, so the client finds a link by membership, `[data-msg-ids~=uuid]`).
- `TailEvent` `text` / `tool` gain `uuid?` (the line's), forwarded as `msgId`
  on `stream-text` / `stream-tool`. The client sets `data-msg-id` on a bubble
  when it creates it, from the first block's `msgId`.
- User prompts: the tail emits `{ kind: "user", uuid, at }` when it reads a
  VISIBLE human prompt line (same filter as `loadHistory`'s: not cron, not agent
  notification, not injected). The server broadcasts `prompt-id { msgId }`; the
  client stamps the most recent user bubble that has no id yet. Until then that
  bubble simply shows no 🔗 (≈1s).

All fields optional: an old transcript or an older server just yields bubbles
without a link button.

### 2. The URL

`<location.origin><location.pathname>#agent=<full sessionId>&msg=<uuid>`

- Origin from `location`, so it is right behind a TLS proxy.
- The FULL session id, never the 8-char display prefix (invariant 36: a short
  id is not a session id).
- A hash, not a query: it never reaches the server or a proxy log, and the
  login redirect keeps it in the same tab only if we carry it — see §4.

### 3. Client

Pure module `public/deep-link.js` (ESM, bridged + stubbed per invariant 10,
imported by `test/deep-link.test.ts`):

- `buildMessageLink(base, sessionId, msgId)` → string.
- `parseMessageLink(hash)` → `{ agent, msg } | null` (refuses anything
  malformed, never throws).

In `index.html`:

- A 🔗 button on each bubble with a `data-msg-id` (user and agent), shown on
  hover (always visible on `pointer: coarse`). Click → `navigator.clipboard`
  (fallback: a selectable prompt) + a short toast "Link copied".
- On load and on `hashchange`: parse; wait until the channel restore is done;
  find the tab whose `sessionId` matches → activate it; once its `history` is
  rendered, `scrollIntoView` the bubble and add a `.msg-flash` class for ~2s;
  then `history.replaceState` the hash away so a reload does not jump again.
- Not found:
  - no such agent on this cockpit → banner "This agent is not on this cockpit
    (closed, or another instance)".
  - agent found, message not in the rendered history → banner "This message is
    older than the history shown".

### 4. Login

The login page is a separate route. Check that a redirect to `/login` and back
preserves the hash (browsers keep a fragment across a 302 when the Location has
none); if it does not, stash it in `sessionStorage` before the redirect and
restore it after.

## Tests

- `test/deep-link.test.ts`: build/parse round trip, malformed hashes refused.
- `loadHistory`: `id` is the first block's uuid on a merged assistant turn, and
  set on user turns; absent when the line has no uuid.
- tail: `text` carries `uuid`; a visible user prompt emits `user`, a cron /
  agent / injected one does not.
- Live == replay: the id of a merged bubble streamed live equals the replayed
  turn's `id`.
- `test/esm-bridge.test.ts` covers the new bridged names.
- Browser, side by side on a free port: copy a link, open it in a fresh tab,
  screenshot the highlighted bubble; console clean (CSP, module imports).

## Docs

README (user-visible feature), CLAUDE.md (protocol: `msgId`, `prompt-id`,
`HistoryTurn.id`; new module row), `docs/architecture.md` if the protocol
section lists stream fields.
