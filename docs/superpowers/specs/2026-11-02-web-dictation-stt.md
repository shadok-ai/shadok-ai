# Dictate a prompt on the web (speech-to-text in the composer)

Status: built. Web composer (`public/index.html`) + one server endpoint
(`src/server.ts` → `POST /transcribe`), reusing `src/whisper.ts` whole.

## Problem

shadok already runs **local** speech-to-text (whisper.cpp) for Telegram voice
notes — but only there. On the web the only way into an agent was typing. The
ask: a microphone button beside *Send* so a prompt can be dictated, landing on
the same local pipeline (nothing leaves the machine).

## Decisions

- **Reuse `transcribe` unchanged.** The voice-note path already provisions
  ffmpeg / whisper.cpp / a model on first use, is single-flight, and returns a
  typed `{ok} | {ok:false, kind}`. The web endpoint is thin glue over it: write
  the browser's clip to a temp file, `transcribe`, return the text. No second
  STT path to keep in sync.

- **The clip is transient — temp dir, deleted in `finally`.** Unlike `/paste`,
  a dictation is spoken *input*, not a file to hand the agent, so it never lands
  in `MEDIA_DIR` (which is served and purged). `ffmpeg` sniffs the container by
  content, so the temp extension is cosmetic; `audioClipExtension` still gives
  it a truthful one (pure, tested) for the common `MediaRecorder` outputs.

- **The text lands in the composer, EDITABLE — never auto-sent.** A transcription
  can mishear, and an instruction acted on in silence is worse than one not
  given (the reason the Telegram path echoes `heardNotice` before acting). On
  the web the composer itself is that checkpoint: the user reads and corrects
  before pressing Send. Dictation appends at the cursor, same flow as typing.

- **Browser-origin only, like `/paste`.** The route records the mic and writes a
  file — a script/curl on loopback has no business there. `requestFromBrowser`
  (stricter than the WS origin guard) gates it; a no-`Origin` caller gets 403.

- **The web UI stays English; the whisper notices stay French.** The French
  notices (`🎙 je n'ai rien compris…`) are Telegram chat copy. The endpoint
  returns only `kind` (`empty`/`failed`/`unavailable`) and the client maps it to
  its own short English UI copy, so neither surface borrows the other's language.

- **Degrade, don't throw, where the mic is unavailable.** `getUserMedia` needs a
  secure context (localhost/HTTPS) and `MediaRecorder`; where the API is absent
  the button hides itself rather than failing on first click. A denied
  permission shows a transient one-line status in the composer, not a dead
  button.

## UX

A 🎙 button sits between the 📎 and *Send*. Click to start (it turns into a red
stop square with a running `m:ss` timer, pulsing); click to stop → a spinner
while whisper runs → the text appears in the composer. A 5-minute hard cap stops
a forgotten recording. First use on a fresh instance pays the same one-time
whisper install as the voice notes; the spinner covers the wait.

## Trade-offs / scope

- **No live/streaming transcription** — one clip, one round-trip. Streaming would
  mean a very different pipeline; dictating a prompt does not need it.
- **No separate "preparing STT" state** beyond the spinner. The first-use install
  can take minutes, but it is a once-per-instance event and the voice-note path
  already carries the same cost; a dedicated endpoint/signal for it was not worth
  the surface.
- The success path depends on whisper being installable on the host — the exact
  constraint the voice notes already live with (`ffmpegAsset` refuses an unknown
  platform rather than guessing).

## Verification

- `audioClipExtension` unit tested (`test/whisper.test.ts`): the MediaRecorder
  mime types, mime parameters, case, and the unknown-type → `webm` fallback.
- Full suite green (`npm test`).
- Real server (free port): `POST /transcribe` with the whisper.cpp `jfk.wav`
  sample returns the exact JFK quote; a no-`Origin` POST is 403.
- Browser (Playwright, Chromium fake audio capture = `jfk.wav`): the mic button
  shows, records (red + timer), stops, shows the working spinner, and the real
  transcription lands in the composer ("And so, my fellow Americans, …"), button
  back to idle, zero console errors. Prod on 3789 untouched (401 throughout).
