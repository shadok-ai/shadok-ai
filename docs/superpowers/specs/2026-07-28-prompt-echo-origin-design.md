# Telegram sees prompts sent from elsewhere, and knows where they came from

*2026-07-28*

## The problem

A Telegram channel only showed the agent's **answers**. A prompt sent from the
web cockpit did not appear there: on the phone, the agent seemed to be talking to
itself, with no way to know which request it was answering.

Since channel crons (#79), it is worse: a cron sends its prompt down the same
path as a human. Its answer therefore landed in the topic with nothing to say it
came from an automatic trigger.

## What already existed

`server.ts` broadcasts `prompt-echo` **excluding the sender**:

```ts
broadcast(session, { type: "prompt-echo", text }, ws);
```

So the Telegram bridge already received prompts coming from other clients — it
simply had no `case` for them. Two things were missing: displaying it, and
knowing **who** spoke.

## The fix

### The origin travels with the echo

A client declares its origin on connecting: `{type:"start", origin:"web"}`. The
server remembers it for the life of the connection and attaches it to the echo.

| client | origin |
|---|---|
| `public/index.html` | `web` |
| the crons' internal client (`fireCron`) | `cron` |
| the Telegram bridge itself | `telegram` |
| everything else (pilotctl, CLI…) | absent |

Declarative and not guessed: the server cannot infer who is at the other end of a
WebSocket, and a heuristic would one day be wrong on the case that matters.

### The rendering (`promptEchoLabel`, pure)

A header, then the prompt's text:

```
👤 web
Answer exactly PONG and nothing else.
```

- `web` → `👤 web` · `cron` → `⏰ cron` · `cli` → `⌨️ cli`
- origin **absent** → `👤` alone. Marking without lying beats a message that
  would look like it came from the agent.
- unknown origin → `👤 <name>`: it is shown as is rather than erased.
- `auto: true` (the pace guard's resume) → `⚙️ auto-resumed`. That is nobody: it
  comes from the server.

A bot cannot post under the user's name — hence the mark rather than an
impersonation.

## No loop

Telegram never delivers a bot its own messages, and the server already excludes
the sender: a prompt coming from Telegram does not come back into its own
channel.

## Tests

`promptEchoLabel` carries the tests (each known origin, an unknown origin, a
missing origin, the automatic resume). The full chain is verified by
reproduction on the Telegram bench.
