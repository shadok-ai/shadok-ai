# Follow a session when Claude Code forks its transcript id

**Date:** 2026-08-26
**Status:** built — content-based (transcript lineage root). The process-based
`/proc` design below was tried first and **abandoned**; the reason is kept because
it is the trap a future rewrite would fall into again.

## Problem (observed on a production instance)

A shadok channel keys everything by a fixed `sessionId`: the tmux pane
(`sk-<id>`), the transcript the tail reads (`<id>.jsonl`), and the channel
record. That holds until Claude Code **forks its session id mid-flight**:

- the agent's transcript grew to **8 MB**, and a turn hit **"Prompt is too
  long"** (the request exceeded the context window);
- the live `claude` in the pane then continued under a **new session id**
  (a fresh `<newid>.jsonl`), leaving `<oldid>.jsonl` frozen at the error;
- shadok still tails `<oldid>.jsonl` → the **chat freezes** on "Prompt too long"
  and shows no updates, while the **terminal (TUI) is fine** — it follows the
  live process, which writes the new transcript.

Exactly the reported symptom: chat frozen, terminal OK.

## The trap that makes the obvious fix WRONG

"When the tracked transcript freezes while the pane is alive, adopt the newest
`.jsonl` in the cwd's project dir" is unsafe: **agents can share a cwd.** On a
containerised instance every agent runs in `/workspace`, so *all* their
transcripts live in `~/.claude/projects/-workspace/`. "Newest in the dir" could
be a *sibling agent's* transcript — adopting it would show one agent's content
in another's chat. A data-integrity disaster across the fleet.

## What the transcripts actually record (the ground truth)

Inspecting a real fork pair settled the design. Every
Claude Code record carries **two** ids:

- `sessionId` (camelCase) — the file's OWN id, equal to its filename.
- `session_id` (snake_case) — the lineage **ROOT**: the id of the FIRST session
  in a compaction/fork chain, **constant across every fork**.

Measured:

| file | own `sessionId` | root `session_id` |
|---|---|---|
| old `15f1efac.jsonl` (frozen) | `15f1efac` | `15f1efac` (== own) |
| new `94f5df2b.jsonl` (live fork) | `94f5df2b` | **`15f1efac`** (the root) |
| any sibling agent's file | its own id | its own id (== own) |

So the fork points **back** at the root, and a sibling never does. The new file
mentioned the old id 41×; the old file never mentioned the new one. That gives a
signal that is **safe under a shared cwd** and needs no OS-specific machinery.

## Why NOT the process/`/proc` approach (tried first, abandoned)

The first design read the file the pane's `claude` process held open via
`/proc/<pid>/fd`, reasoning that the live process ties the new transcript to
*this* pane unambiguously. It was implemented, then a probe against a real live
session showed the flaw: **Claude Code does not hold the transcript open.** It
opens-appends-closes per write, so a session at idle (and most of the time
during work) has **no `.jsonl` fd at all**. A periodic fd scan almost always
sees nothing — the detection would essentially never fire. `/proc` is also
Linux-only, so macOS got nothing. The content signal above has neither problem.

## Design (as built)

1. **Decouple the tail from the session id.** `Live.tailId?: string` — the
   transcript the content tail follows; defaults to `id`. The tail resolves its
   path from `sessionFilePath(cwd, s.tailId ?? s.id)`. The tail setup, once
   inline in `attachPilot`, is factored into `startContentTail(s)` so it can be
   restarted on a re-point. Control (submit/screen) stays on the pane, untouched.

2. **`src/forktrace.ts` — pure detection over transcript content.**
   - `rootIdFromChunk(chunk)` — the snake `session_id` from a slice of JSONL.
   - `idFromTranscriptName(name)` — the own id from a `<uuid>.jsonl` filename.
   - `rootIdOfFile(file)` — bounded HEAD read (1 MB) → the file's lineage root.
   - `forkTarget(candidates, tailId, myRoot)` — pure pick: the NEWEST candidate
     whose `root === myRoot` and whose `id !== tailId`. Same-lineage only (no
     sibling); newest so a multi-step chain jumps to the live tip.
   - `detectFork(myFile, tailId, myRoot)` — lists the tracked file's directory,
     considers only files **newer** than `myFile` (the fork post-dates the
     freeze; while the agent works normally ITS file is newest, so the common
     case opens no transcript), reads each one's root, and returns the target.

3. **Re-point in the screen watcher.** Every ~15 s (`forkTick % 50` at 300 ms),
   `maybeFollowFork(s)`:
   - `myRoot = s.rootId ??= rootIdOfFile(<tailId file>) ?? s.id` (cached; the
     original session's root is its own id, hence the fallback);
   - `detectFork(...)`; if it returns a new id, set `s.tailId`, **seed the new
     file's tail position to 0** (`seedTailPos`, so its unseen backlog replays
     rather than starting at EOF — still capped by `MAX_CATCHUP`), restart the
     content tail, and broadcast a one-line note that the chat re-attached.

## Out of scope (deliberate follow-ups)

- **Resume the live (small) session on restart.** Today a reload still resumes
  `s.id` (the 8 MB original), which will just fork again. Resuming the lineage
  tip instead is a natural next step, kept separate to limit blast radius.
- **Proactive "context almost full" warning** from the gauge (`src/context.ts`)
  before the fork happens.
- A cleaner upstream: a Claude Code that exposes its current session id directly.

## Verification

- Unit (`test/forktrace.test.ts`): the pure pickers, plus fs-level `rootIdOfFile`
  and `detectFork` against real fixture files in a temp dir — fork followed,
  sibling ignored, quiet no-op. Full suite green (693).
- Ground truth: field semantics confirmed on TWO instances (a real fork pair
  + a normal session on shadok-self, where root == own id).

## 2026-10-19 — a fork is left, the session's own transcript never is

Found in production, on an agent whose chat had been silent **live** for over an
hour while every page reload showed the conversation perfectly, and whose
siblings on the same instance were fine.

The measurement that named it: the tail's stored position sat at 51.78 MB on
`<fork>.jsonl` (= that file's full size, nothing left to read) while
`<own-id>.jsonl` grew past 56 MB, 3.5 MB of it written after the tail last
advanced. The agent had gone back to writing its ORIGINAL transcript, and the
tail was reading a file nothing appends to any more.

Two things put it there, and the second is what made it permanent.

- A context overflow forked the transcript, and the tail followed — working as
  designed.
- `--resume` brings a session back to its OWN id. Every restart respawns that
  way (`restartSession`), so Claude Code starts appending to the original file
  again and the fork becomes the dead one. But the own id was in the `seen` set
  by then, and `seen` is one-way: the tail could never come back.

The symptom is worth stating, because it is what a user actually reports and it
names no subsystem: **live is broken, reload is fine, and only this agent**.
Everything live (the chat) comes from the tail; everything replayed comes from
`loadHistory`, which is keyed by the channel's own session id — so the two read
different files and only one of them is the live one.

Both halves are now closed:

- `detectFork` takes an `ownId` that the `seen` exclusion does not cover. Anti-flap
  still holds for every other id; the session's own transcript is never abandoned
  for good.
- `restartSession` clears the whole fork trail (`tailId` / `tailSeen` / `rootId`)
  before respawning, since the process it spawns resumes `s.id` by construction.

One trap in the fix: coming home must NOT `seedTailPos(file, 0)`. Seeding 0 is
right for a fork (never shown in chat), and would have dumped a 56 MB transcript
into the chat here. Home keeps its stored position, which `startOffset` caps via
`MAX_CATCHUP` anyway.

## Refinement — a fork in ANOTHER project directory (*2026-11-06*)

`detectFork` scanned only the frozen file's OWN directory (`path.dirname(myFile)`).
That holds when a session keeps one cwd for life, but not when the cwd DRIFTS —
and a long-lived agent routinely drifts: it is created in a worktree, the
worktree is later pruned (invariant 5), and the session is resumed at the repo
root. Claude Code derives the project dir from the cwd it is LAUNCHED with, so
the context-overflow continuation is written under the repo-root project dir,
while the frozen original sits under the worktree one. Same lineage root,
different directory — and a one-directory scan is blind to it. The chat freezes
at the overflow point while the TUI runs on; the exact "live broken, reload
fine, only this agent" symptom above, one layer deeper.

`sessionFilePath` already dodges this drift for the *id* — it takes the newest
`<id>.jsonl` found under ANY project dir (`newestTranscriptById`) rather than the
cwd-derived path. `detectFork` now does the equivalent for the *fork scan*: the
caller (`maybeFollowFork`) passes every project dir under the session's
transcript home, and the scan walks them all. The root-match is unchanged and is
what keeps this safe — a sibling agent's transcript has a different lineage root
and is never adopted, no matter which directory it sits in — so widening the
search cannot mis-attribute across the boundary. The cost (a readdir per project
dir, then a head-read only of files NEWER than the frozen one) is paid solely on
a stalled, working session every ~12.5 s, the same gate as before.

### Still open — the orphan resume (cwd drift's other half)

This refinement follows a fork whose lineage root is intact. It does NOT cover
the case where the resume itself mints a FRESH lineage: when `--resume <id>` runs
at a cwd whose project dir does not contain `<id>.jsonl` (the worktree is gone),
Claude Code cannot find the session and starts a NEW one with its own root. That
orphan shares no root with the channel, so root-matching cannot attribute it, and
the shared repo-root cwd rules out "newest in the dir" (a sibling would be
adopted). Preventing it belongs upstream — resume where the transcript can be
found, or pin the session id — and is a separate, larger change (invariant 1).
