# A prompt from an agent says so — in the chat and in the receiving transcript

Date: 2026-11-02
Status: validated, implemented

## The report

> "On an instance, an agent sent a message to another agent, and it appeared as
> sent *by me*. I think the subject is pilotctl not sending the header when it
> is an agent."

Right file, wrong piece — and the difference matters, because the obvious fix
produces a bug that looks almost identical and reads as deliberate.

## What was actually happening

pilotctl **does** send a header: `x-shadok-session-key`, its own. And
`currentAccount` (`src/server.ts`) deliberately maps that key to the **bootstrap
admin** — correct for AUTHORISATION (an agent may do what the human may), and
precisely why attribution must not reuse it: "forward the account" would have
signed an agent's message **with the human's name**.

What was missing is that pilotctl never said WHERE it speaks from. `openSession`
sent `{type:"start", …}` with no `origin`, where the web sends `"web"`, Telegram
`"telegram"`, the crons `"cron"`. From there:

- `promptAuthor` (`src/accounts.ts`) only trusts the session's own name when
  `origin === "web"`; otherwise it takes what the frame claimed — and pilotctl
  claims nothing. The echo therefore carried **neither `from` nor `origin`**.
- `echoAuthor` (`public/echo-author.js`) resolves that exact pair to `"you"`,
  and `isOwnPrompt` to *yours*. On purpose: a web prompt with no account is the
  person driving a cockpit that has one human.

Measured on the pure core before touching anything:

```
pilotctl today (no origin, no from)   label="you"                  own(right side)=true
web, me                               label="admin"                own(right side)=true
telegram, named                       label="Alexandre · telegram" own(right side)=false
cron                                  label="cron"                 own(right side)=false
```

**The second half, which the screenshot could not show, is the worse one.** The
`⟦platform · time · sender⟧` context header handed to the TUI was gated on
`web|telegram|cli`. With no origin, the receiving agent got a **bare user
message**: nothing told it a peer was talking, so it answered as though the owner
of the cockpit had spoken. An agent obeying "the human said so" when a sibling
said it is a trust bug, not a cosmetic one.

## The fix

- **pilotctl introduces itself**: `callerOrigin(env)` — `SHADOK_SESSION_ID` set
  means we run inside a piloted session (`"agent"`), a human's shell means
  `"cli"`. The same signal `buildStartMsg` already uses for parent linking, so
  there is nothing to configure. Applied in `openSession`, the single door every
  pilotctl command goes through, and overridable by an explicit `origin`.
- **The server resolves the NAME, the frame never does**: `agentNameForKey`
  turns the signing session key into the agent's cockpit tab name
  (`channelLabel`), resolved ONCE at connect like `me` and `callerPeer`.
  `promptAuthor` gains an `agent` branch that follows the WEB rule — a `from` in
  the frame is discarded. An agent writes its own frames; it is exactly the
  caller whose claim cannot be taken.
- **The receiving agent is told**: `"agent"` joins the context-header gate, so
  the TUI gets `⟦agent · 2026-11-02 15:40 · Shadok-Boss⟧`. `loadHistory` already
  parses that header back into `origin`/`from`, so a replayed history shows the
  same label as the live echo with no client change.
- **The audit log stops crediting a person who did nothing**: `spawnActor` gets
  an `agent` branch, for the same reason its `parent` branch exists. Without it,
  declaring an origin would have reclassified an agent's respawn from
  `via: "system"` to `via: "api"`, actor `admin` — a quieter version of the same
  lie.

The client needed **no change**: `echoAuthor` already renders
`"Shadok-Boss · agent"` and puts the bubble on the left. That is the shape of a
well-placed pure core, and it is also why the bug survived — the decision was
right, it was simply never given the facts.

## What is deliberately NOT touched

The HIDDEN machine paths. A cron fire and a parent notification carry their own
mark, are not "someone speaking", and reach the TUI through `driveChannel` with
`origin: "cron"` — so they match no header gate and show no bubble. Giving them
a sender would un-hide them.

## Verification

Pure cores: `promptAuthor` (agent branch, and a claimed name discarded),
`echoAuthor` / `isOwnPrompt` (label and side), `spawnActor`, `callerOrigin`.
The two pilotctl tests were confirmed to FAIL against the unfixed client before
being made to pass. 1419 tests green, tsc clean.

`spawn.test.mjs` asserted the start frame with `deepEqual` and broke — kept
broken until the assertions were updated to include `origin: "cli"`, which is now
a real assertion rather than a silent omission.

End to end against a REAL server (isolated HOME, free port, never 3789, stub
`claude` recording what is typed into its pane), because a field accepted in
`start` is not a field consumed (invariant 26) — 7/7:

- the echo says `origin: "agent"` and `from: "Shadok-Boss"`;
- the name the frame claimed (`from: "Alexandre"`) is **discarded**;
- the TUI really received `⟦agent · 2026-11-02 15:40 · Shadok-Boss⟧`;
- control, same session from the web: `["web", "admin"]` and
  `⟦web · … · admin⟧` — so "agent" is a decision, not the new default.

One harness flaw worth recording: the stub read its log path from the
environment, and the pane tmux opens does **not** inherit the server's
environment, so `tee` died with an empty argument and the first run reported no
header while the server log plainly showed one. The defect was in the test. Test
panes were cleaned up with `tmux kill-session -t sk-<id>` on their own ids —
never `kill-server`, which once took 21 sibling agents down.
