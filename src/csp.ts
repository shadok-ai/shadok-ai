/**
 * The cockpit's Content-Security-Policy, and the nonce injection into the page.
 *
 * Why a CSP here: the transcript renders **Markdown produced by the agent**,
 * i.e. content derived from what the agent read (a file in a cloned repo, a web
 * page, a Telegram message). `marked` lets raw HTML through. With no guard, an
 * `<img onerror=…>` planted in a README runs inside the cockpit — which can
 * create a cron, hence run a shell command. Sanitising (DOMPurify, client-side)
 * is the first barrier; the CSP is the one that still holds when the sanitiser
 * has a hole.
 *
 * Everything here is pure; the wiring lives in server.ts.
 */

/**
 * Marker hardcoded in `public/index.html`, replaced by the real nonce on every
 * request.
 *
 * A literal string replacement, not a tag rewrite: we want neither to parse
 * HTML nor to risk "nonce-ing" a `<script` that happens to sit inside a
 * JavaScript string. As a bonus the marker makes the requirement visible in the
 * source — a future script block without it will not run, which shows up
 * immediately.
 */
export const NONCE_PLACEHOLDER = "__CSP_NONCE__";

/**
 * The policy served with every page.
 *
 * - `script-src`: **no `unsafe-inline`**. That is the directive that matters —
 *   it neutralises `<img onerror>`, injected `<script>` and `javascript:`. The
 *   page's two inline blocks carry the nonce; injected HTML cannot guess it (it
 *   is drawn afresh on every request).
 * - `style-src` keeps `unsafe-inline`: the page has one large inline stylesheet
 *   and `style=` attributes all over. The nonce does not cover attributes, so
 *   requiring it would mean rewriting the whole client for little gain — style
 *   injection alone does not give code execution.
 * - `img-src` allows `data:`: the favicon is an SVG data-URI, and the
 *   notification pip rewrites it on the fly.
 * - `connect-src 'self'` covers the WebSocket: `'self'` also applies to a
 *   `ws://` on the same host and port.
 * - `base-uri`/`object-src`/`frame-ancestors` at `none`: nothing to rewrite,
 *   nothing to embed, and no clickjacking on a UI that drives agents.
 */
export function cspHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Replace every marker with this request's nonce. */
export function injectNonce(html: string, nonce: string): string {
  return html.split(NONCE_PLACEHOLDER).join(nonce);
}
