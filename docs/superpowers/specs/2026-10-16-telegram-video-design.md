# A video shared in Telegram reaches the agent — and is actually seen

## The report

> "I get the impression shadok doesn't see videos shared from Telegram. I'm
> sending you one right after this message."

The video was sent. Nothing happened: no answer, no warning, no trace. The
agent never learned a message had arrived at all.

## What was happening

`handleMessage` opens with

```ts
const att = attachmentOf(msg);
if (typeof msg.text !== "string" && !att) return;
```

and `attachmentOf` only ever looked at three fields: `voice`, `photo`,
`document`. A Telegram video is none of them — it arrives as `msg.video`, with
its caption in `msg.caption` and **no `msg.text` at all**. So the guard on the
second line dropped the whole message, in silence, before any binding was
touched.

The same hole swallowed four more shapes:

| Field | What the user sent |
|---|---|
| `video` | a video, from the gallery or the camera |
| `animation` | a GIF (Telegram stores it as a soundless mp4) |
| `video_note` | a round "telescope" video |
| `audio` | a music/audio file |
| `sticker` | a sticker |

This is the exact failure the voice-note comment in `attachmentOf` already
warns about ("so the message was dropped in silence, which is exactly the
failure this codebase keeps paying for") — the fix at the time added `voice`
to the list instead of changing what the list is for.

## Recognising it is not enough: a video has to become readable

Handing `[Attached file: /media/AQAD.mp4]` to the agent trades a silent drop
for an honest dead end. Claude Code's `Read` opens images, PDFs and text — not
an mp4 — and this container has **no `ffmpeg` on `PATH`**, so an agent that
tries to help itself fails too.

Two things already in the repo change the picture. The voice pipeline
(`src/whisper.ts`) provisions, on demand, a **static ffmpeg** and a local
whisper.cpp. So a video can be turned into things an agent genuinely reads:

- **stills** — a handful of frames as JPEGs, which is vision, i.e. *seeing* it;
- **speech** — the audio track transcribed, which is the narration most shared
  clips carry.

## Design

### `src/video.ts` (new)

Pure planners plus the two ffmpeg calls:

- `frameTimestamps(durationSec, max)` — evenly spaced instants, one frame per
  ~5 s, capped (6 alone, 2 per video in an album), always at least one. Taken
  at the MIDDLE of each slice, never at `0`: the first frame of a video is
  routinely black, and a black still is a frame budget spent on nothing.
  Telegram gives us `duration`, so this needs no `ffprobe`.
- `hasAudioStream(stderr)` — does the file carry an audio track? Read off
  ffmpeg's own stream listing rather than guessed, per invariant 27: a silent
  screen recording and a failed conversion must not produce the same notice.
- `extractFrames` / `probeAudio` — the impure halves, both over the ffmpeg
  that `ensureFfmpeg` provisions.

`ensureFfmpeg` is split out of `ensureWhisper` in `src/whisper.ts`, keeping its
single-flight discipline: ffmpeg is downloaded **once per process** whoever
asks first. Two provisioners writing `${dest}.part-${pid}` from the same pid is
precisely the `ENOTEMPTY`-shaped race that file already documents. The split
also means a video with no speech costs an ~80 MB ffmpeg download and never the
~600 MB whisper install.

### The prompt

One pure function keeps rendering it (`attachmentPrompt`), so the whole shape
is unit-testable:

```
[Attached video: /media/AQAD.mp4 (0:18)]
Stills from it — read these images to see the video:
[Attached image: /media/AQAD-f1.jpg] frame 1/4 at 0:02
[Attached image: /media/AQAD-f2.jpg] frame 2/4 at 0:07
[Attached image: /media/AQAD-f3.jpg] frame 3/4 at 0:11
[Attached image: /media/AQAD-f4.jpg] frame 4/4 at 0:16
⟦heard in the video⟧ "watch the badge when I switch tabs"
look at the badge
```

The "read these images" line is load-bearing: without it a model that is told
about an mp4 answers that it cannot watch videos, and the stills next to it go
unread.

### What is deliberately NOT transcribed

- **Longer than 2 minutes** (`VIDEO_TRANSCRIBE_MAX_SEC`): whisper runs at
  roughly 1.4x realtime on the default model, and the agent's turn cannot start
  until the prompt is sent. The prompt then SAYS the audio was left unheard,
  so the agent can offer to listen rather than assume silence.
- **An album**: several videos transcribed serially would stall a single
  message for minutes. Stills only, and the prompt says so.
- **A silent clip**: nothing to say, so nothing is said.

### Degraded paths say so, in Telegram

- **Over 20 MB** — the Bot API's own `getFile` ceiling, which no code on our
  side can lift. The notice names the medium and both sizes, and suggests the
  two things that work (a shorter clip, or sending it as a file link).
- **No stills** (unsupported platform, a download that failed, a broken clip) —
  the agent still gets the path and the user is told the stills are missing.

A `sticker` stays dropped, and that is a decision rather than an oversight: a
sticker is a reaction, and starting a whole agent turn on an emoji-equivalent
costs more than it tells anyone.

## Tests

`test/video.test.ts` covers `frameTimestamps` (unknown duration, a 2-second
clip, the cap, the album budget, mid-slice placement), `hasAudioStream` (a real
ffmpeg stream listing, with and without audio) and `clock`.
`test/telegram.test.ts` gains the five message shapes above, the truthful
extension (`mediaExtension`), and the rendered video prompt.
