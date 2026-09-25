# Voice messages on Telegram — design

**Status:** decided 2026-09-25. Inbound only (you speak, the agent reads).

## Where it stops today

`attachmentOf` (`src/telegram.ts`) recognises `photo` and `document` and returns
`null` for anything else. A `msg.voice` therefore produces nothing at all: the
message is dropped **in silence**, which is the failure shape this codebase
keeps paying for.

## What the chain needs

1. **Receive** — recognise `msg.voice`, download it like a document (the path
   exists).
2. **Decode** — Telegram sends OGG/Opus; a transcriber wants 16 kHz mono PCM.
   `ffmpeg` is NOT in the image.
3. **Transcribe** — whisper.cpp, locally.
4. **Give it back** — the text becomes the prompt, the audio stays beside it.

Ruled out, so nobody tries: handing the audio to the agent (Claude models do not
read audio), and Telegram's own transcription (a Premium *user* feature; the Bot
API does not expose it to bots — the one thing to re-check before building).

## Decisions

Taken by the user, 2026-09-25:

| | |
|---|---|
| Model | `ggml-medium-q5_0.bin`, **514 MB** (measured, not recalled) |
| Provisioning | **on demand**, at the first voice message — never at boot |
| Feedback | the first use says an install is running |
| Model location | **shared** between containers |
| ffmpeg | a **static** binary, not `apt` |

### Why on demand is the right call

The live VPS builds its images from a host-side Dockerfile of its own, not the
repo's (see CLAUDE.md). Anything baked into the repo image would reach no
running instance. A download at first use reaches every instance the moment it
updates, with nothing to rebuild — and costs nothing on instances that never
receive a voice message.

### What "shared" can and cannot mean

shadok cannot create a share between containers. It can only make the path
configurable — `SHADOK_WHISPER_DIR`, defaulting to `~/.shadok-ai/whisper/` on
the mounted volume — and write there. Mounting one host directory into several
containers stays an operator gesture; without it this degrades, correctly and
silently, to one copy per container (514 MB each).

Disk, checked rather than assumed: the `vps1 disk space` ledger row is still
**in-progress** (the September cleanup worked, the ~4 GB/15 min growth was never
explained). At the time of writing the host is at 63%, 147 GB free, so ten
copies would be affordable — but one copy is the point of sharing.

## Design

### Provisioning, single-flight and loud

Three things are installed, not one: the static ffmpeg, the whisper.cpp binary
(`make` and `g++` are already in the image), and the model.

`src/tmux-install.ts` is the precedent and the shape to copy: best effort, never
blocks anything, and on failure says what is wrong instead of degrading in
silence.

**Single-flight is not a nicety.** A second voice message arriving during the
install must not start a second one — that is exactly how the first-boot
`ENOTEMPTY` happened (two npm installs racing, invariant 32). Same rule as
`ensureClaudeOnce` and `claudeUpdateInFlight`.

**Failure is announced once and then stops.** A install that cannot complete
(no network, no disk, a refused binary) posts one message naming the reason and
disables transcription until the next restart. Retrying on every message would
turn each voice note into a failed 514 MB download.

### What the user sees

First voice message, before anything else:

> 🎙 première fois : j'installe la transcription (~500 Mo), je te réponds dès
> que c'est prêt.

Then, on every voice message, **what was understood, echoed back**:

> 🎙 « ajoute un test pour le cas vide »

That echo is the load-bearing part of the feature, not a courtesy. A
transcription can be wrong, and an instruction that was misheard and then acted
on silently is far worse than a voice message that was ignored. The user sees
what the agent received and can correct it in the next message.

An empty or failed transcription says so; it never falls through as silence.

## Out of scope

- **Outbound** (the agent replying in voice) — a separate engine, deliberately
  not now.
- `video_note` (the round video bubbles) — same pipeline if wanted later.
- Choosing the model from the GUI. The file is a path; changing it later is a
  download, not a code change.

## What cannot be verified without the user

The provisioning, the decode and the transcription can be exercised on a bench
with a sample file. A real Telegram voice message — its actual container,
bitrate and duration — cannot. The last mile needs one voice note from the user,
and this design does not pretend otherwise.
