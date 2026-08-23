# Telegram: showing tools or not, per channel

*2026-07-28*

## The problem

Every `stream-tool` the Telegram bridge receives is posted as is
(`src/telegram.ts`, `case "stream-tool"`). On a slightly long turn that drowns
the agent's answer under dozens of `→ Read …` lines, and it is unreadable on a
phone. Conversely, on a channel you are watching, seeing the tools is exactly
what you want.

The choice belongs to the channel, not to the product: it needs a switch **per
Telegram channel**.

## The intended behaviour

- By default a channel **does not show** tools: only the agent's text is posted.
  This changes the current behaviour, deliberately — the noisy default was the
  wrong one.
- `/tools` **toggles** the state and answers with the new one. One tap from the
  phone, no argument to type.
- `/tools on` / `/tools off` force the state explicitly (idempotent).
- The setting belongs to the **topic** (or the DM), and survives `/new`, `/end`
  and a server restart.
- The web cockpit does not change: it keeps showing tools. The setting only
  concerns Telegram's rendering.

## Architecture

### The store (`src/channels.ts`)

`channels.ts` already hosts the small per-launch-directory Telegram stores
(`telegram-group`, `telegram-topics`), written by `writeJson`. We add a fourth,
`…-telegram-tools.json`: the **list of channels where tools are shown**.

```ts
export function loadTgToolKeys(): string[];
export function tgToolsEnabled(key: string): boolean;
export function setTgTools(key: string, on: boolean): void;
```

The key is the `bindKey(chat, threadId)` already used to index the bridges
(`private:<id>`, `group:<id>`, `topic:<id>:<thread>`).

An *allowlist* rather than a `key → boolean` map: the default (off) costs no
entry, the file stays readable at a glance, and a missing or corrupt file
degrades to exactly "everything off" — the intended default.

Telegram thread ids are message ids: never reused. So a key left behind by a
deleted topic cannot come back to life on another channel. No purge —
deliberately out of scope.

### The bridge (`src/telegram.ts`)

`Bridge` gains `showTools: boolean`, initialised in `openBridge` from the store.
A single exit point changes:

```ts
case "stream-tool":
  if (b.showTools) send(b, "→ " + m.name + (m.summary ? "  " + m.summary : ""));
  break;
```

Nothing else in the event loop moves. The field is read on the bridge (rather
than re-read from the store on every event) so as not to touch the disk dozens
of times per turn.

### The command

`/tools` joins `handleMessage`'s command `switch`:

1. resolve the intended state — explicit `on`/`off`, otherwise the toggle of the
   current state read from the store;
2. `setTgTools(key, next)`;
3. propagate to the live bridge when there is one — through `bridges.get(key)`,
   **never** `bridgeFor`: typing `/tools` must not bring a session into being
   (the same precaution as `/stop`);
4. answer with the state.

`parseCommand` is already generic (`/tools on` → `{cmd:"tools", arg:"on"}`):
nothing to change on the parsing side. The line is added to `/help`'s text.

An argument that is neither `on` nor `off` (`/tools yes`) is treated as a toggle
— the command must not turn into a syntax puzzle.

## Tests

- `test/channels.test.ts`: the store's helpers — an absent channel is off, a
  `setTgTools(k, true)` makes it visible, `false` removes it, a key never appears
  twice, an unreadable file reads as "no channel".
- `test/telegram.test.ts`: resolving the intended state from the argument and the
  current state, extracted as a pure function (`nextToolsState(arg, cur)`) so it
  is testable without network or disk.

## Out of scope

- A toggle on the web side: the setting is driven from Telegram only.
- Filtering *which* tools show (by name): a boolean is enough.
- Purging the keys of deleted topics (see above).
