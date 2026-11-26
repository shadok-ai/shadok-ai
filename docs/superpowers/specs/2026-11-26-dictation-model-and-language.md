# Dictation: a model you can pick, a language that follows the conversation

## Problem

Voice notes and the composer's Dictate button both run whisper.cpp with the
`small` model and `-l auto`. People report that it "does not work well". Two
causes, both structural:

- `small` is the least accurate usable model, and changing it took an
  environment variable and a restart — out of reach of whoever runs the cockpit
  from a browser.
- The language is detected from the audio alone, and a dictated instruction is
  a short clip — where that detection is at its weakest.

## Decisions

**The model is a setting.** A closed list (`SPEECH_MODELS`: small, medium,
large-v3-turbo), each pinned by size and SHA-256 at the same Hugging Face
commit. `GET /speech` reports the choice and each model's state; `PUT /speech`
(admin) changes it. The choice is an id, never a file name: it ends up in a
path and a download URL.

**Downloads take care of themselves.** Picking a model starts its download in
the background, with progress in the menu. The toolchain and each model are
separate single-flights, so a change never rebuilds anything. Until the chosen
model is usable — downloading, or failed — the model that last worked keeps
transcribing. `SHADOK_WHISPER_MODEL` keeps its meaning as the model in force
when nobody chose one.

**The language is a second opinion, not an order.** whisper detects first. The
clip is transcribed again only when the detection (a) matches neither what the
person typed in that conversation nor their client's language, and (b) was
unsure of itself. Forcing the expected language up front was rejected: people
do dictate in a language they do not type in, and a wrong forced language is
worse than a wrong detection. Only TYPED prompts feed the expectation — a
transcription made in the wrong language would otherwise vote for its own
mistake.

**The default stays `small`.** The better models cost 3 to 5 times the wait on
a CPU; that trade is the instance's to make, not ours.

## What was measured (one busy 24-core host, real French speech)

| | 4 s clip | 28 s clip | errors on the samples |
|---|---|---|---|
| small | 9 s | 16 s | two wrong phrases |
| medium | 25 s | 51 s | none |
| large-v3-turbo | 42 s | 44 s | none |

- 8 threads against whisper's default 4 nearly halves every time → `whisperThreads`.
- The turbo model with `-nt` dropped every sentence between headings on the long
  clip; with timestamps it is complete → per-model `timestamps`.
- Shrinking the audio context for short clips (`-ac`) is a third faster and
  breaks the text (invented words, "Ita, ita.") → rejected.

## Follow-up: live dictation in the browser

The better models did not make dictation pleasant: the wait IS the complaint,
and a CPU cannot remove it. So the web Dictate button can be handed to the
browser's own recogniser (Web Speech API), which writes while one speaks.

- A third setting, `web`: `server` (default) or `browser`. Opt-in because the
  audio then goes to the browser's maker instead of staying on the instance.
- It only concerns the web button. Telegram and WhatsApp voice notes are files
  and keep using whisper, as does any browser without a recogniser (Firefox).
- A recogniser detects no language, it is told one: `GET /speech/listen`
  answers with the fixed setting, else the conversation's typed language, else
  the client's (`listenLanguage`). Asked ahead of the click so the recogniser
  starts inside it.
- The words land at the cursor and are rewritten as the recogniser revises
  them; never sent by themselves. A send, a keystroke or a change of agent
  drops the dictation, so a late result cannot overwrite the composer.
- A recogniser that fails with anything but silence or a missing microphone is
  not tried again in that page: the next click records for the server.

Verified in a headless browser against a SIMULATED recogniser only — no real
speech went through a real Chrome, Edge or Safari recogniser, and the handling
of a mobile recogniser's repeated final results is written from its documented
behaviour, not observed.

## Not verified

No clip in the test set made whisper detect the wrong language, so the retry was
exercised by giving it a false expectation, never on a genuine misdetection, and
its two thresholds are a judgement. Telegram and WhatsApp voice notes were not
sent for real; they call the same `transcribe`.
