# WhatsApp step 3 — media in, files out, voice notes, questions, the unreadable message: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WhatsApp guest can send pictures, documents, voice notes and videos, receives the files their agent hands over, answers their agent's questions by number, and is asked ONCE to resend a first message that arrived unreadable — the last step of the design.

**Architecture:** The seam gains `downloadMedia(id)` and `sendFile(to, file)`; the adapter keeps the raw library message of a recent media message in memory just long enough to download it. The bridge downloads a medium the moment it arrives into a STAGING file beside the inbox (the raw message does not survive a restart, the file does), records it in the inbox, and on delivery copies it into the agent's group media directory — exactly Telegram's per-group rule (`mediaDirFor`, invariant 60) — then runs Telegram's own pipelines: `transcribe` + `heardNotice` for a voice note, `lookAtVideo` for a video, `attachmentPrompt` for the rest. Questions become numbered lists answered by a pure parser (`parseDialogReply`) that yields the same `choose` / `toggle` / `confirm` / `freetext` frames Telegram's keyboard does. Every line the bridge says about itself is `guestNotice`'s.

**Spec:** `docs/superpowers/specs/2026-11-23-whatsapp-open-dm-design.md`, "Suggested order of work", step 3, and "A person's message" / "The agent's answers". Step 2's plan: `docs/superpowers/plans/2026-11-24-whatsapp-guests-text.md`.

## Global Constraints

- `CLAUDE.md` rules (English, why-comments, docs in the same PR, side port only, never 3789).
- Telegram helpers are imported where they live (`attachmentPrompt`, `transcribe`, `heardNotice`, `lookAtVideo`, `telegramPhotoable`), never copied; Telegram's behaviour and tests unchanged.
- Media land in the agent's group media directory (`mediaDirFor`, the server's `mediaDirForSession`), never in a shared place; files out are read with the AGENT's rights (`readAgentFile`, the server's `readSessionFile`).
- **The bridge still never writes first.** Its only exception is a guest NOTICE to someone who wrote within the last minutes (`replyAllowed`, fed by inbound messages only) — the unreadable-message line, a refused medium — and the one line that says a bound conversation was closed. Everything an agent says still needs a binding (`sendAllowed`).
- The library is installed without `sharp`/`jimp`: inbound downloads do not need them; outbound images go out without a preview thumbnail (the library catches the failure itself). Said in the README, never a failure.
- Inbound size: 50 MB, checked on the declared size before downloading and on the bytes after. Neutral fixtures; no real number.

## Review Focus

- An unreadable message never enters the inbox nor the seen list, so the library's own resend (same id) is processed normally; the notice goes at most once per person per 10 minutes, never when the door is shut.
- A medium received and not yet delivered survives a restart (staging file + inbox entry); its staging file is removed with the entry's acknowledgement.
- A multi-select answer toggles exactly the difference between what is checked and what was asked, one toggle at a time (each waits for the server's re-broadcast), then confirms.
- A file the agent hands over goes only to a binding, as an image when WhatsApp previews it, a document otherwise.

### Task 1: Pure rules
`src/wa-guests.ts`: `inboundVerdict` learns `media` and `unreadable` verdicts (with `replyTo`); `replyAllowed(recent, to, now)`; `WaMedia` on `WaInbound`. `src/wa-format.ts`: `dialogMessage(d)` (question, body, `1. label` lines, how to answer), `parseDialogReply(d, text)` → `choose` | `toggles` (the set difference) | `freetext` | `need-text` | `invalid`, `waMediaFileName(id, media)`. `src/tg-guests.ts`: `guestNotice` gains `unreadable`, `too-large`, `media-failed`, `voice-failed`, `dialog-single`, `dialog-multi`, `dialog-text`, `dialog-again`, `need-text`, `ended`. Tests first.

### Task 2: The seam
`downloadMedia(id)`, `sendFile(to, {data, name, mime, image, caption?})` on `WaTransport`, the worker, the fake (holds media bytes, records sent files) and the adapter (`inboundOf` describes image/document/audio(ptt = voice)/video and their captions; a bounded map of raw messages; `downloadMediaMessage` with the reupload hook; image vs document send). Handle passes them through while connected. Tests first.

### Task 3: The bridge
Media: download at receipt into `whatsapp-state/<key>/media/` (0700/0600) with the size cap, inbox entry carries the staging path; on delivery wait for the agent's session, copy into `mediaDirFor(sessionId)`, voice → transcribe (echo `heardNotice`, `voice: true`; failure → `voice-failed`), video → `lookAtVideo`, else `attachmentPrompt`. Files out: `stream-tool` `SendUserFile`/`ShadokFile` → `readAgentFile` → `sendFile`. Questions: numbered list, replies parsed, sequential toggles then confirm, free text in two steps or one, `dialog-again` otherwise. Unreadable: one notice, nothing stored. Stopped: the `ended` line, then close. Tests first, end to end against the fake transport and the fake server socket.

### Task 4: Server wiring + neutral reader error, browser check, docs
`readSessionFile`'s "too large for Telegram" becomes neutral. Wire `mediaDirFor`, `readAgentFile`, `multiTenant` into the bridge; the fake route `deliver` takes a medium. Browser check on a side instance. README, architecture, the invariant 77 neighbour note on replies, CLAUDE.md row, spec status.
