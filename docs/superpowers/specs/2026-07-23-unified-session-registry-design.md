# Unified session registry — design

Date: 2026-07-23 · Status: approved

## Goal

One server ⇒ **one list of sessions**, whatever the interface. A session
spawned from Telegram appears as a web channel and vice-versa; both drive the
same live session. Today the web keeps a channel list and Telegram keeps a
separate chat→session binding file, and neither writes the other's — so they
look like different sessions.

## Decision (locked)

**Fold the Telegram binding into the channel record — a single registry.** Each
channel optionally carries `telegram: { chatId, threadId? }`. The separate
`…-telegram.json` bindings file is migrated in and retired. The instance's board
group (`…-telegram-group.json`) stays separate — it's instance-level, not a
session.

## Data model

`channels/<encoded cwd>.json` — the one registry:

```jsonc
[
  {
    "sessionId": "…",
    "cwd": "…",
    "name": "…",
    "branch": null,
    "repo": "…",
    "group": null,
    "telegram": { "chatId": -100…, "threadId": 40 }   // present iff bound to a chat/topic
  }
]
```

`threadId` absent ⇒ bound to a group's General / a DM. `telegram` absent ⇒
web-only session.

## Authority — the server owns the list

The erosion bug (invariant #6) came from the **browser** owning the list and
PUTting it whole. To unify safely, the **server** becomes the source of truth:

1. **Upsert on start.** When any session reaches `ready` (web or Telegram), the
   server upserts its channel `{ sessionId, cwd, name, branch, repo }`. So every
   session lands in the one list regardless of origin.
2. **Telegram sets its binding.** The in-process Telegram bridge upserts the
   same channel with `telegram: { chatId, threadId }` and a name (the topic
   name), on `ready`.
3. **Client edits are metadata only.** The browser still PUTs the list, but the
   server **merges** instead of replacing:
   - server-owned fields (`telegram`, `cwd`, `branch`, `repo`) are preserved
     per `sessionId` — a browser that doesn't know about `telegram` can't strip
     it;
   - client-owned fields (`name`, `group`, order) are taken from the payload;
   - a stored channel the client omitted is **kept** if its session is live or
     it has a `telegram` binding (never erase Telegram/live sessions).

This keeps the browser mostly as-is (still PUTs), while making erosion
structurally impossible for server-owned sessions.

## Components

| File | Change |
|---|---|
| `src/channels.ts` | `Channel` gains `telegram?`. New `upsertChannel(partial)`, `removeChannel(id)`, `mergeClientChannels(client, keep)` (field-preserving merge). `migrateTgBindings()` folds the old `…-telegram.json` in once. `loadTgGroup/saveTgGroup` unchanged. `load/saveTgBindings` removed. |
| `src/telegram.ts` | Routing derives from the registry: `bridgeFor` finds the resume id by matching `telegram.{chatId,threadId}` in `loadChannels()`. `persist()` → `upsertChannel({sessionId, cwd, name, telegram})`. `/list` reads channels; `/end` clears the binding / removes the channel. |
| `src/server.ts` | Upsert a channel on `ready`. `PUT /channels` merges (server-owned fields + keep live/telegram) instead of overwriting. `removeChannel` on explicit stop. |
| `public/index.html` | Renders `/channels` as today (Telegram sessions now appear as tabs). Small badge (📱) on telegram-bound channels. PUT unchanged (server merges). |

## Migration

On server start (once): if `…-telegram.json` exists, for each
`{ sessionId, chatId, threadId }` call `upsertChannel({ sessionId, telegram:{…} })`,
then rename the old file to `…-telegram.json.migrated` so it's not re-applied.
Existing web channels keep working; existing Telegram bindings become channel
fields.

## Behaviour after

- `/spawn foo` in Telegram → a channel appears in the web UI (name "foo",
  telegram badge), pilotable from both, streaming shared.
- A web session has no `telegram` until (future) it's pushed to a topic — out of
  scope here; the hook (`telegram` field) is in place.
- `/list` in Telegram and the web channel list show the **same** sessions.

## Testing

- `channels`: `upsertChannel` merge semantics (create, update, preserve
  server-owned fields), `mergeClientChannels` (keeps live/telegram, applies name/
  group, preserves telegram), `migrateTgBindings` (folds bindings, idempotent).
- `telegram`: `bridgeFor` resolves the resume id from a channel's telegram
  binding (pure lookup over a channel list fixture).
- Regression: a browser PUT that omits a Telegram channel must not drop it.

## Non-goals

- Pushing a web session to a new Telegram topic from the browser (the data model
  supports it; the UI action is a later increment).
- Cross-launch-dir unification (still one registry per launch directory).
