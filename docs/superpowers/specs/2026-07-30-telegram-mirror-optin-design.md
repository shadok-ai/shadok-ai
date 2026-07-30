# Telegram mirroring becomes a choice, per channel

*2026-07-30*

## Today

`reconcileWebChannels` (every 5 s) creates a topic for **every** channel with no
Telegram binding. Starting an agent from the web therefore makes a topic appear
whether you want it or not — and the board group fills up with channels you never
meant to follow on your phone.

## The intended behaviour

- **A channel created on the web is not mirrored by default.** The creation popin
  carries a checkbox, **unchecked**.
- **The channel menu (right-click) turns mirroring on and off** at any time.
  Turning it on creates the topic and replays recent history (`backfill`, already
  in place); turning it off **deletes the topic**, after confirmation.
- **A badge on the tab** says whether the channel is mirrored, like the crons' ⏰.
  Both badges shrink (10 px → 9 px).
- **A channel created from Telegram is mirrored by definition**: it reaches the
  web already configured, nothing to tick.

## Architecture

### Intent, kept apart from the binding (`src/channels.ts`)

`Channel` gains `mirror?: boolean` — what the user **wants**. The `telegram`
field stays what **is** (the topic actually bound). Both are needed: without an
explicit intent, "not mirrored yet" and "deliberately not mirrored" are
indistinguishable, and the loop would recreate the very topic we just deleted.

```ts
export function isMirrored(c: Channel): boolean {
  return c.mirror ?? !!c.telegram;
}
```

Falling back to `!!c.telegram` is what makes the **migration** free: a channel
that already has a binding stays mirrored without writing anything, so a running
install doesn't change behaviour on deploy.

It also makes the field robust to a client that ignores it (`mirror` is
client-owned, hence absent from an old tab's PUT): with no intent, the binding
decides — which is right in both directions, on and off.

### A loop that converges (`src/telegram.ts`)

`reconcileWebChannels` now handles both directions:

| state | action |
|---|---|
| wanted, no topic | create the topic + bind it (with `backfill`) |
| explicitly not wanted, topic present | close the bridge, delete the topic, forget the binding |
| otherwise | nothing |

Declarative: the web only flips `mirror`, and the loop catches up. No dedicated
endpoint, and the state survives a page reload — a lost `POST` would otherwise
leave a ghost topic.

The channel itself **survives** being un-mirrored: only the binding is cleared
(`telegram: null`). It's a web channel; it never depended on Telegram.

**Deleting demands an EXPLICIT intent** (`c.mirror === false`), never
`isMirrored`'s fallback. A client that ignores the field — an old tab, a script —
must not be able to destroy a conversation by omitting a key.

This is not theoretical caution: in repro, the web's **boot** restore path
didn't apply `mirror`, its first `persistChannels` pushed `mirror:false` back,
and the loop deleted the topic of a **Telegram-born** agent. Both fixes are
needed — restore the field *and* obey only an explicit intent. Creating a topic
is reversible; deleting one is not.

### Channels born in Telegram

`persist()` writes `mirror: true` alongside the binding, **once**. It must never
re-assert it: `persist` runs on every `ready`, and overwriting a `mirror: false`
chosen from the web would make the topic come back in a loop, right after it was
deleted.

## The interface (`public/index.html`)

- **Creation popin**: a `.check` checkbox like the worktree one, unchecked, sent
  in `start` (`mirror: true`) and persisted by the server on `ready`.
- **Right-click menu**: one item whose label states the action *and* its cost —
  "✈️ Mirror to Telegram" / "✈️ Stop mirroring (deletes the topic)", with a
  confirmation for turning it off, since that destroys the conversation.
- **Badge**: a `.tg` on the tab when the channel is mirrored. `.cron` and `.tg`
  drop to 9 px.
- **Restore**: `mirror` comes from the server registry on every pass, like the
  crons — so a toggle made on another device lights the badge here within
  seconds. **Both** restore paths must apply it: the boot one (from `/channels`
  or `localStorage`) and the periodic sync. Forgetting the first is enough to
  overwrite the registry.

## Tests

`isMirrored` carries the unit tests: explicit intent both ways, migration from an
existing binding, neither present.

The rest (creating and deleting a topic) is verified in repro on the Telegram
bench, like the previous fixes.
