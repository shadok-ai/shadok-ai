# Delivering agent-sent files (SendUserFile) — 2026-09-24

## Problem

An agent under shadok can hand the user a file with the harness `SendUserFile`
tool (a generated HTML page, a report, a chart). In the TUI that shows as a
`[file] /abs/path (15.9KB)` footer line, but the web cockpit only rendered it as
a folded, path-less tool activity, and Telegram showed nothing — so the file the
agent said it "sent" was unreachable from either surface.

## What the transcript records

`SendUserFile` writes two lines:
- a `tool_use`, `name: "SendUserFile"`, `input.files = [<abs paths>]`;
- a `tool_result` whose `toolUseResult.attachments[]` carry `{path, size,
  media_type}`.

Either carries the absolute path; `sentFilePaths` reads both.

## Design

Read the file paths off the existing stream/transcript — no new agent-facing
surface. Deliver per platform:

- **Web** — a card in the transcript. An **image** renders inline (`<img
  src="/download?session=&path=">`) with a small download link; anything else is
  a **download card** (`<a download>`). Served by `GET /download`.
- **Telegram** — an **upload**, not a link (so no public URL is needed and it
  works for a loopback / proxied / tailnet instance): `sendPhoto` when Telegram
  previews the type inline, `sendDocument` otherwise.

### Plumbing

- `src/download.ts` (pure, tested): `toolFiles`, `fileCard`, `isImageFile` /
  `telegramPhotoable` / `contentTypeFor`, and `sentFilePaths(transcript)`.
- `tail.ts` emits `files` on the tool event for a `SendUserFile`; `server.ts`
  forwards them on `stream-tool` as `{path,name,image}[]`.
- `loadHistory` emits a `role:"file"` turn so the card **survives a reload**
  (other tool blocks stay dropped as noise).
- `public/index.html`: `addFileCard` (live via `addToolLine`, replayed via the
  `history` case).
- `telegram.ts`: `sendUserFile` in the `stream-tool` case.

### Security (GET /download)

The path is **never trusted**. It is served only if it appears in that session's
transcript as a sent attachment (`sentFilePaths`), so the endpoint can't be
walked into `/etc/passwd` or another agent's scratch files. The response is
neutralised for an agent-authored HTML/SVG: `Content-Disposition: attachment`
(non-images) + `X-Content-Type-Options: nosniff` + `Content-Security-Policy:
sandbox` — so even navigating straight to the URL cannot run script in the
cockpit's origin (which would reach the auth cookie). A raster image is served
`inline`; the chat's `<img>` renders it regardless of disposition.

## Verified

- Endpoint: 400 (no params) / 404 (unknown session) / **200 + bytes** for a file
  the transcript recorded as sent / **403** for any other path (a real
  never-sent file and `/etc/passwd`).
- Web: image → `<img>` + download link, other → download card, not a folded tool
  line; replays from history.
- Telegram: `sendPhoto` / `sendDocument` wired (photoable vs document by type).
