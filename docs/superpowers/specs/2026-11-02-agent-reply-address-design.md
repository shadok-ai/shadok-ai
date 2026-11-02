# A name is not an address — the agent header carries one

Date: 2026-11-02
Status: validated, implemented
Follows: `2026-11-02-agent-prompt-attribution-design.md` (PR #375)

## The question that found the hole

> "Does the receiving agent have enough information to talk to the other agent?
> Doesn't it need its id or something?"

PR #375 made an agent's prompt arrive labelled `⟦agent · 15:40 · Shadok-Boss⟧`.
That answers *who spoke*. It does not answer *how to speak back*, and the two are
not the same question.

## Where it stood

**Answering the turn needed nothing, and still doesn't.** `pilotctl prompt <id>`
blocks until the turn ends and hands the answer back to the caller — the
conversation is already a round trip. That is the common case and it was never
broken.

**Reaching the sender later had no path.** Three facts, each small, together a
dead end:

- the header gives a **name**, every tool takes an **id**;
- nothing makes cockpit tab names unique — `channels.ts` carries scars from two
  channels both called `general` — so a name is not even a reliable key to look
  up;
- the automatic `🤖 [agent]` reports go to whoever **spawned** the agent, which
  is not necessarily whoever just prompted it. A lead prompting an agent it did
  not create is outside that loop entirely.

`GET /channels` does expose `name` + `sessionId` to any agent holding its session
key, so it was *possible* — but nothing said so, and it would still have resolved
a name that is not unique.

**And the document the receiving agent actually reads was wrong.**
`context/pilot-prompt.md`, injected into every session, said "A **human** message
may open with a one-line context header". PR #375 updated the README, CLAUDE.md
and architecture.md and missed the one file that talks to the agent. So the fix
shipped a header whose meaning the reader had been taught to misread — it worked
only because a model infers "agent" from the word in the line, which is inference
standing in for instruction.

## What changed

**The header ends with the sender's short session id.**

```
⟦agent · 2026-11-02 15:40 · Shadok-Boss · b1c347bc⟧
```

Eight hex characters, because `resolveResumeId` already resolves a prefix — and
refuses an ambiguous one rather than guessing — and because every other id the
cockpit prints is that length.

**It is split back OFF before the name is read.** `parsePromptMeta` returns
`ref` separately from `who`, and `who` is what the client turns into a bubble's
label (`classifyUserLine` → `from` → `echoAuthor`). An address left inside the
name would have been printed in the chat on every reload, forever after. The
live echo never carried it in the first place: the echo gets the author, the
header gets author + address.

The split rule is deliberately **narrow**: `agent` platform, exactly 8 hex, last
field only. A header's `who` is "everything past the time" precisely so a sender
whose name contains " · " survives, and a greedier rule would eat into it. A
field that does not match is name, not address.

**A ref with no name is dropped** rather than written: it would land where the
name is read and parse back as one.

**The pilot prompt now teaches all three things**: that `agent` means a sibling
and not the human (and that where a peer contradicts the human, the human wins),
that the last field is a reply address, and that answering the current turn needs
none of it. The `shadok-ai-agents` skill documents the same from the other end.

## Verification

Pure cores (`promptMetaHeader`, `parsePromptMeta`, `classifyUserLine`): the
round trip, a name containing " · " next to an address, an id-shaped last field
on a non-agent platform (**not** split), a name that merely looks like a second
field (not split), and the no-name case. 1423 tests green, tsc clean.

End to end against a real server (isolated HOME, free port, never 3789, stub
`claude` recording what its pane is typed), **8/8** — the five from PR #375 plus:

- the TUI received `⟦agent · 2026-11-02 17:12 · Shadok-Boss · 11111111⟧`, the
  address being the caller's own session id;
- the live echo still carries `from: "Shadok-Boss"` and **no** address.

The replayed-history half is covered by the `classifyUserLine` unit test rather
than the harness: the stub writes no `.jsonl`, so there is no transcript to
replay, and that function is the decision the replay actually makes.

Test panes cleaned up with `tmux kill-session -t sk-<id>` on their own ids.
