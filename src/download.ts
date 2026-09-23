// Files an agent hands the user via the harness `SendUserFile` tool. The tool
// writes a `tool_use` (name "SendUserFile", input.files = absolute paths) and a
// `tool_result` whose `toolUseResult.attachments[]` carry {path, size,
// media_type}. shadok surfaces those: a download / inline-image card on the web
// (served by GET /download) and an upload on Telegram (sendPhoto / sendDocument).
//
// Pure helpers, tested by test/download.test.ts. No fs here — the callers do IO.

import path from "node:path";

/** The tool that delivers a file to the user. */
export const SEND_FILE_TOOL = "SendUserFile";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"]);
// What Telegram will accept as a PHOTO (inline preview). Narrower than the web's
// <img>: svg/gif/bmp/ico are not photos there, so they go as documents.
const TG_PHOTO_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp",
  ".ico": "image/x-icon", ".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html",
  ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".csv": "text/csv",
  ".txt": "text/plain", ".md": "text/markdown", ".xml": "application/xml", ".zip": "application/zip",
};

const ext = (name: string): string => path.extname(String(name || "")).toLowerCase();

/** Would the web render this inline as an <img>? */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.has(ext(name));
}

/** Should Telegram send this as a photo (inline) rather than a document? */
export function telegramPhotoable(name: string): boolean {
  return TG_PHOTO_EXT.has(ext(name));
}

/** Best-effort Content-Type for GET /download. `image/svg+xml` is served with a
 *  restrictive disposition by the caller — never inline-executed. */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPE[ext(name)] ?? "application/octet-stream";
}

/** The card shape handed to the client / Telegram: enough to render and to build
 *  the download URL, without re-deriving basenames everywhere. */
export interface FileCard {
  path: string;
  name: string;
  image: boolean;
}

export function fileCard(p: string): FileCard {
  const name = path.basename(String(p || ""));
  return { path: String(p || ""), name, image: isImageFile(name) };
}

/** The `files` a SendUserFile tool_use delivered — its `input.files`, kept only
 *  when they are real string paths. Any other tool → none. */
export function toolFiles(name: unknown, input: unknown): string[] {
  if (name !== SEND_FILE_TOOL || !input || typeof input !== "object") return [];
  const files = (input as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files.filter((f): f is string => typeof f === "string" && f.length > 0);
}

/**
 * Every absolute path this transcript delivered to the user via SendUserFile.
 * The GET /download gate: a path is servable ONLY if it appears here, so the
 * endpoint can never be walked into an arbitrary file — it serves back exactly
 * what an agent chose to send. Reads both the tool_use `input.files` and the
 * tool_result `toolUseResult.attachments[].path` (either can carry it).
 */
export function sentFilePaths(transcript: string): Set<string> {
  const out = new Set<string>();
  if (typeof transcript !== "string" || !transcript) return out;
  for (const line of transcript.split("\n")) {
    if (!line.trim() || !line.includes(SEND_FILE_TOOL)) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_use") for (const f of toolFiles(b.name, b.input)) out.add(f);
      }
    }
    const atts = e?.toolUseResult?.attachments;
    if (Array.isArray(atts)) {
      for (const a of atts) if (typeof a?.path === "string" && a.path) out.add(a.path);
    }
  }
  return out;
}
