# Telegram → Claude Code: attachments (images & files)

**Date:** 2026-07-23
**Status:** agreed (brainstorm with the user)

## Problem

Today the Telegram bridge ignores any message with no text (`handleMessage`:
`if (typeof msg.text !== "string") return;`). Sending a photo or a file into a
chat/topic bound to a Claude Code session does nothing. The user wants dropping
an image (or any file) into Telegram to be the equivalent of "pasting" it into
the Claude Code session.

## The approach chosen

**A file path in the prompt** (approach A from the brainstorm). The bridge
downloads the attachment through the Telegram Bot API, saves it to disk, then
sends an ordinary text prompt containing the absolute path. Claude Code reads the
file itself (the Read tool for images/PDF/text, Bash for the rest).

Rejected:
- **Simulating a TUI paste (Ctrl+V)**: a machine-global clipboard → collisions
  between parallel sessions, fragile, breaks headless.
- **Saving into the session's cwd/worktree**: pollutes the diff, risks an
  accidental commit.

Everything lives in `src/telegram.ts` (+ a possible helper). **No change to the
server or to the WS protocol** — we go through the existing `prompt` message.

## Behaviour

| Sent on Telegram | Result |
|---|---|
| A photo with a caption | One prompt: `[Attached image: /path]` + the caption |
| A photo with no caption | One prompt: just `[Attached image: /path]` |
| A document (any type: PDF, .txt, .zip, an image "as a file"…) | One prompt: `[Attached file: /path]` (+ any caption) |
| An album (`media_group_id`) | **A single** prompt grouping every path (+ the album's caption) |
| A file over 20 MB | Reply `⚠️ file too large (Telegram bot limit: 20 MB)`, nothing sent to Claude |
| A failed download | An explicit `⚠️` reply, nothing sent to Claude |

Plain text keeps being handled exactly as today.

## Technical details

- **Photo**: `msg.photo` is an array of sizes → take the last one (the highest
  resolution).
- **Document**: `msg.document` (any `mime_type`, unfiltered).
- **Download**: `getFile(file_id)` → GET
  `https://api.telegram.org/file/bot<token>/<file_path>`. The 20 MB limit is
  `getFile`'s, on Telegram's side — detect it through `msg.document.file_size` /
  `photo.file_size` before the call when possible, and handle the `getFile` error
  otherwise.
- **Storage**: `~/.shadok-ai/media/` (the `~/.shadok-ai/` convention, like
  secrets/channels). Name: `<file_unique_id>-<original_name>` (the original name
  kept to give Claude context; the `file_unique_id` prefix avoids collisions). An
  unnamed photo: `<file_unique_id>.jpg`. The original name is sanitised
  (basename, no `/`).
- **The generated prompt**: an absolute path, e.g.
  `[Attached file: /Users/alex/.shadok-ai/media/AQAD…-report.pdf]\n<caption>`.
  Claude decides how to read it depending on the type.
- **Albums**: the messages of one `media_group_id` arrive separately (the caption
  usually on only one). A buffer per `media_group_id` with a ~1.5 s timer rearmed
  on each photo; on expiry, a single prompt with every path and the caption
  found.
- **Typing**: the optimistic "typing" heartbeat starts on reception, as for a
  text message (download included).
- **Purge**: when the bridge starts, files in `~/.shadok-ai/media/` modified more
  than 30 days ago are deleted.

## Error handling

- A failed `getFile` or a non-200 download → a Telegram reply
  `⚠️ could not download <name> (<reason>)`; nothing is sent to the session; the
  typing stops.
- One failed file within an album does not prevent the others from being sent
  (the prompt lists what succeeded, the reply reports the failure).

## Tests / verification

- Build (`npm run build`), restart the server in tmux, then a manual end-to-end
  check: a photo with a caption, a photo without one, a PDF document, an image
  "as a file", an album of 2–3 photos, a file over 20 MB.
- Check that the Claude session does read the file (the turn answers about the
  content of the image/document).
