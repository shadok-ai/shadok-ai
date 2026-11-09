// Pure helper for the composer's file upload (paste / drag-and-drop). ESM:
// loaded by the browser (bridged to window) AND imported by test/upload.test.ts.
//
// Why it exists: `attachFile` POSTs to /paste and calls `r.json()`. A reverse
// proxy (nginx, default `client_max_body_size` 1 MB) rejects an oversized body
// with its OWN error page — `413 text/html` — which never reaches our JSON
// route. `r.json()` on that HTML threw `Unexpected token '<', "<html>…"`, and
// the composer surfaced the raw parser error instead of a plain "too large".
// The server itself accepts up to PASTE_LIMIT (50 MB), so this is always the
// proxy, and the fix is to read the STATUS, not the body.

/**
 * Should the caller refuse to parse this /paste response, and with what message?
 * Returns null for a JSON response (success OR our `{error}` body — the caller's
 * existing `r.json()` path handles both); otherwise a human string, because a
 * non-JSON response is a proxy/gateway page, never something to `JSON.parse`.
 * @param {number} status - the HTTP status
 * @param {string|null|undefined} contentType - the response Content-Type header
 */
export function uploadFailure(status, contentType) {
  if (/json/i.test(contentType || "")) return null; // ours — let the caller read it
  if (status === 413) return "too large (over the server's upload limit)";
  return `upload failed (HTTP ${status || "?"})`;
}
