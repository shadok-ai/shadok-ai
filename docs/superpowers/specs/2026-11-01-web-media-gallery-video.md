# Web media gallery & inline video

Status: built. Web only (`public/index.html` + `src/download.ts` + `src/server.ts`).

## Problem

The cockpit rendered **images** as first-class media — inline in the chat, and
(since the media gallery) as a grid of thumbnails with a full-size lightbox. A
**video** in a conversation (a user attachment, a Telegram clip, a file an agent
sent) was a dead end on the web: it fell through to a download chip, and the
gallery — which scanned `<img>` — never listed it. The admin's report was exactly
that: *"y a pas les vidéos dedans."*

The goal is **media parity**: a video behaves like a photo — it plays inline in
the chat, it appears in the gallery, and a gallery tile opens it full-size.

## Decisions

- **Video is a file type, detected by extension**, mirrored on both sides:
  `VIDEO_EXT` in `download.ts` (`isVideoFile`, web-playable containers only —
  mp4/m4v/webm/ogv/mov) and `VIDEO_RE` in the client (`isVideoPath`). Kept in
  sync by hand; both are short explicit lists. `FileCard` gains `video`, so an
  agent-sent clip renders inline without the client re-deriving the type — with
  an extension fallback for a card replayed from history before the field
  existed.

- **The server serves video `inline`, with HTTP Range.** `contentTypeFor` now
  maps the video types, and a video (like a raster image) is served
  `Content-Disposition: inline` so a `<video>` plays rather than downloads. Both
  `/download` and `/media` go through one `serveStaticFile` helper that honours a
  single `Range` header (206 + `Content-Range`, 416 on an out-of-bounds range,
  `Accept-Ranges: bytes`). Range is what lets a `<video>` **seek**, and is what
  **Safari demands before it will play one at all**. `parseByteRange` is the
  pure, tested core; only the one-range `bytes=start-end` / `bytes=N-` /
  `bytes=-N` forms a browser actually sends are honoured.

- **Inline video keeps native controls; the gallery is the "view full-size"
  path.** The transcript's delegated click opens images in the viewer but does
  NOT match a `<video>` — clicking an inline clip must play/pause it, not hijack
  into the viewer. The gallery tile (a muted first-frame `<video>` with a ▶
  badge) is where a click opens the full-size player.

- **The gallery reads the DOM, in document order.** One `querySelectorAll` over a
  combined image+video selector keeps tiles chronological and de-dupes by `src`,
  so newly streamed media simply shows up next time the gallery opens — no
  separate media model to keep in sync (the same choice the image-only gallery
  made).

- **The viewer (lightbox) holds both an `<img>` and a `<video>`**, one shown per
  open. Opening a video autoplays it (swallowing the autoplay-policy rejection —
  the controls remain); closing pauses AND `load()`s it to stop buffering. Esc
  precedence is unchanged: the viewer closes before the gallery, which closes
  before the terminal claims the key.

## Trade-offs / scope

- The **composer paste preview** still shows a named chip for a pending video
  (not a thumbnail). The clip still sends and renders inline in the chat; a
  preview thumbnail there was deliberately left out as not worth the extra
  `<video>` lifecycle in the chip strip.
- `src/video.ts` is unrelated: it extracts stills for the AGENT to "see" a
  Telegram clip. This feature is about the HUMAN viewing media in the web chat.

## Verification

- `parseByteRange` + `isVideoFile` + `contentTypeFor` + `fileCard.video` unit
  tested (`test/download.test.ts`).
- Real server (free port): `video/mp4` + `inline` + `Accept-Ranges`; `Range`
  → 206 with the right `Content-Range`/slice; out-of-bounds → 416.
- Browser (Playwright, a real ffmpeg-made mp4): inline player in the chat for
  both an agent file card and a user attachment; the gallery lists 2 videos
  (▶ tiles) beside 2 images; a video tile opens the viewer and plays; an image
  tile shows the image; Esc pauses+closes. Zero console errors.
