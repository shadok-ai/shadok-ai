# Follow a session when Claude Code forks its transcript id

**Date:** 2026-08-26
**Status:** design — the safe detection is process-based, NOT content-based.

## Problem (observed on correctsms, the "Apple Ads" agent)

A shadok channel keys everything by a fixed `sessionId`: the tmux pane
(`sk-<id>`), the transcript the tail reads (`<id>.jsonl`), and the channel
record. That holds until Claude Code **forks its session id mid-flight**:

- the Apple Ads transcript grew to **8 MB**, and a turn hit **"Prompt is too
  long"** (the request exceeded the context window);
- the live `claude` in the pane then continued under a **new session id**
  (a fresh `<newid>.jsonl`), leaving `<oldid>.jsonl` frozen at the error;
- shadok still tails `<oldid>.jsonl` → the **chat freezes** on "Prompt too long"
  and shows no updates, while the **terminal (TUI) is fine** — it follows the
  live process, which writes the new transcript.

Exactly the reported symptom: chat frozen, terminal OK.

## The trap that makes the obvious fix WRONG

"When the tracked transcript freezes while the pane is alive, adopt the newest
`.jsonl` in the cwd's project dir" is unsafe: **agents can share a cwd.** On
correctsms every agent runs in `/workspace`, so *all* their transcripts live in
`~/.claude/projects/-workspace/`. "Newest in the dir" could be a *sibling
agent's* transcript (e.g. Lettrio's) — adopting it would show one agent's
content in another's chat. A data-integrity disaster across the fleet.

Content heuristics don't save it either: the fork transcript need not carry a
structural parent link (the observed `94f5df2b` started as a fresh session), and
"references the old id" also matches unrelated mentions.

## The one reliable signal: the pane's own open file

The fork is, by definition, **the transcript the pane's live `claude` process is
writing**. The shadok server runs as root inside the container, so it can read
`/proc` and follow the pane's process tree to the `.jsonl` it holds open. That
ties the new transcript to *this* session unambiguously — never to a sibling.

- **Linux/Docker only** (where it matters — a fleet of agents in one container).
  On macOS there is no `/proc`; the detection no-ops and we fall back to a
  surfaced warning (below).

## Design

1. **Decouple the tail from the session id.** Add `tailId?: string` to `Live`
   (the transcript the tail follows; defaults to `id`). The content tail resolves
   its path from `sessionFilePath(cwd, s.tailId ?? s.id)`. Factor the tail setup
   (today inline in `attachPilot`) into `startContentTail(s)` so it can be
   restarted on a re-point. Control (submit/screen) stays on the pane — untouched.

2. **Expose the pane pid.** `TmuxPilot.panePid()` via
   `tmux display-message -p "#{pane_pid}"`; `PtyPilot` exposes `this.proc.pid`.

3. **Detect the live transcript (pure core + a thin /proc reader).**
   - `transcriptIdFromFd(target)` — pure: parse a `/proc/<pid>/fd/*` symlink
     target, return the `<uuid>` iff it is a `…/projects/…/<uuid>.jsonl`. Tested.
   - `liveTranscriptId(pid)` — walks the pane's process descendants, reads their
     open fds, returns the transcript id the tree holds open (or null off-Linux).

4. **Re-point, guardedly.** In the screen watcher (throttled, only while the
   tracked transcript looks stale — no growth for N s while the pane is up):
   call `liveTranscriptId(panePid)`. If it differs from `s.tailId ?? s.id`:
   - set `s.tailId` to it, restart the content tail (fresh `startOffset` on the
     new file — starts at EOF, so no history flood; `loadHistory` already replays
     history on reload), and broadcast a one-line note that the chat re-attached.
   - Also update the **channel's `sessionId`** to the live id and rename the pane
     `sk-<old>`→`sk-<new>`, so a later restart resumes the *working* (small)
     session, not the 8 MB one it will only fork again. (This is the half that
     stops the fork from recurring every reboot.)

5. **Fallback (no /proc, or nothing found): surface, don't freeze silently.**
   When the tracked transcript is stale while the pane is active and we cannot
   identify the live one, broadcast a clear note: "context full — this agent may
   have started a fresh session; check the terminal / reload," instead of a
   silently frozen chat.

## Why not just prevent the fork

Shadok can't stop Claude Code auto-compacting / starting fresh on overflow, and
it can't shrink an 8 MB transcript for it. Following the fork is the robust cure;
proactively warning as the context gauge nears 100% is a separate, additive
improvement (the gauge data already exists — `src/context.ts`).

## Verification plan

- Unit: `transcriptIdFromFd` (valid path → id; a non-transcript fd → null) and
  the "should re-point?" decision (live id differs, is non-null, tracked is stale).
- End to end on a Linux box: a session whose `claude` is made to write a second
  transcript in the same dir → the tail follows the pane's file, never a
  sibling's. Confirm a sibling agent's transcript in the same cwd is NOT adopted.

## Out of scope (follow-ups)

- Proactive "context almost full" warning from the gauge.
- A cleaner upstream: ask Claude Code for the current session id directly, if a
  future version exposes it (removes the /proc dependency).
