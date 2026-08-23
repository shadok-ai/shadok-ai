# The tail resumes where it stopped (no more messages lost on a restart)

*2026-07-28*

## The problem

```ts
pos = fs.statSync(file).size; // start at EOF: only stream what comes next
```

`tailSession` starts **at the end of the file**. So everything an agent writes
while no server is up is never broadcast.

This is not a rare case: the server **auto-updates on every merge to `main`** and
reloads. Observed in session, twice within a few minutes:

```
[shadok-ai] auto-update: v0.1.154 → v0.1.155 (installing in background…)
[shadok-ai] auto-update installed v0.1.155; reloading
```

The agents, for their part, survive (tmux) and keep writing during the window.

**The web recovers**: on reload it asks for the history (`loadHistory`), which
re-reads the whole transcript. **Telegram has no replay**: a missed message never
appears. It is a silence, not an error — nothing signals the loss.

## The fix

Remember the position reached, and start from there instead of jumping to the
end.

### The decision, isolated and pure (`src/tail.ts`)

```ts
export function startOffset(size: number, stored: number | null, maxCatchUp?: number): number;
```

| case | start | why |
|---|---|---|
| nothing stored | `size` | a brand-new session: do not replay a resumed transcript |
| `stored > size` | `0` | the file was truncated or replaced — the position is meaningless |
| `size - stored > maxCatchUp` | `size` | too far behind: catching up would dump a wall of text |
| otherwise | `stored` | the case in view: resume after an interruption |

The cap (**1 MB**) bounds the only genuinely awkward scenario: a tmux agent that
worked for hours while the server was away. Beyond it, we fall back on today's
behaviour — and the web keeps the complete history.

### The persistence

One file per session: `~/.shadok-ai/tail/<sessionId>.pos`. The session id is a
UUID, so the name is short and collision-free — encoding the transcript's full
path would exceed the limit of a filename component.

Written **after each read** (hence only once content has been consumed), removed
when the session is destroyed (`destroySession`): a finished session has nothing
to resume.

A failed read or write is never fatal — we fall back on the current behaviour
(starting at the end). Losing the resume point is an annoyance; crashing the tail
would cut all the content.

### Reattaching agents that are still alive (`src/telegram.ts`)

Resuming the read is useless if nobody reads. And a Telegram bridge was only born
at the channel's **next message**: after a restart, a topic stayed dormant, with
no session and no tail, and the catch-up did not happen. Verified by reproduction
— on the first attempt, `/live` returned zero sessions and the message stayed
lost despite the stored position.

So `reconcileOnBoot` reopens the bridges whose agent is **still running**
(`tmuxHasSession("sk-" + sessionId)`). That restriction matters: reopening a
dormant channel would respawn a `claude` for nothing, on every restart and for
every topic never closed.

## What it fixes, and what it does not

**Fixed**: content written during a restart finally reaches Telegram. Verified
end to end — an agent cut mid-turn, the server relaunched, the answer arrives.

**Not fixed**: on reattach, a dialog left pending is re-posted with its preface,
and the anti-duplicate memory (`Live.recentTexts`) is empty in the fresh process.
Same root cause — the broadcast state does not survive the process — but that is
a separate fix, to be done on its own.

## Tests

`startOffset` being pure, it carries the tests: a brand-new session, a truncated
file, a reasonable backlog, an excessive backlog, a position equal to the size.
