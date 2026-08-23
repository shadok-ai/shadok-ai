# Telegram: answering a question in free text (`freetext`)

*2026-07-28*

## The problem (reproduced, not assumed)

`AskUserQuestion` always adds a **"Type something"** option: a free-text answer.
The web handles it (`public/index.html`, the `freetext-row`: an input that sends
`{type:"freetext", n, text}`). The server handles it too (`server.ts`,
`case "freetext"`: digit → paste the text → Enter).

**The Telegram bridge did not.** `parseCallback` only produced `choose` /
`toggle` / `confirm`, so the "4. Type something" button sent a `choose 4`: the
TUI opened its input area, received an empty Enter, and **rejected the tool**.

Reproduced on the debug server (port 3799, bot `@shadokaitest_bot`), the tool's
result:

```
The user doesn't want to proceed with this tool use. The tool use was rejected
```

And on the Telegram side: **nothing**. No error message, the keyboard still
showing as if it were waiting. The user clicks into the void and the turn is
dead.

## The intended behaviour

Pressing "Type something" opens an input: the bot asks for the answer (with
`force_reply`, so the phone's keyboard opens on its own), and the channel's next
message is sent back to the server as `freetext` — not as a new prompt.

Nothing else moves: ordinary options stay `choose`/`toggle`.

## Architecture

### Recognising the option (`src/telegram.ts`)

```ts
export function isFreetextOption(label: string): boolean; // /^type something/i
```

**Exactly the web's rule** (`index.html:2002`): both clients must agree on what a
free-text option is, otherwise the same dialog behaves differently depending on
the screen. One place to change should the rule evolve.

### The keyboard and the callback

`dialogKeyboard` emits `f:<n>` instead of `d:<n>` for those options;
`parseCallback` recognises `^f:(\d+)$` → `{kind:"freetext", n}`.

The prefix stays one character: `callback_data` is capped at 64 bytes by
Telegram, and a long label must never come close to it.

### Waiting for the answer

`Bridge` gains `awaitingFreetext?: { n: number }`.

- **callback `f:n`** → send nothing to the server; arm `awaitingFreetext` and
  post a prompt with `reply_markup: { force_reply: true }`.
- **the next text message** (in `handleMessage`, before the prompt is sent) →
  `{type:"freetext", n, text}`, then disarm.
- **a command stays a command**: `/stop` must work even while waiting for text.
  So the interception only applies to a message that is not a command.
- **disarming** on `turn-done`, `dialog` and `exited`: an orphan wait would turn
  an ordinary prompt into an answer to a dead question.

### The guard on sending the keyboard

The dialog's `sendMessage` went through neither `chunk()` nor a fallback, where
`sendPart` retries as plain text. Checked against the API: beyond 4096
characters Telegram answers `Bad Request: message is too long` → **no keyboard
and no visible error**. So we truncate the question's text, and a failed send is
**said** in the channel instead of leaving the turn mute.

## Out of scope

- **"Chat about this"**: the web does not treat it as a free-text option either —
  handling it specially here would put the two clients out of step. To be settled
  separately, for both at once.
- Pressing a button from an automated test: the Bot API does not allow it (only a
  real client can emit a `callback_query`). The tests cover the pure functions,
  and the end-to-end reproduction goes through `/ws`.

## Tests

- `isFreetextOption`: "Type something", "Type something else", case-insensitive;
  an ordinary option is not free text.
- `dialogKeyboard`: the free-text option carries `f:`, the others `d:`/`t:`, and
  the multi-select's Submit button stays `s`.
- `parseCallback`: `f:4` → `{kind:"freetext", n:4}`, and invalid forms stay
  `null`.
