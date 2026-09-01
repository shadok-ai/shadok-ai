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

/**
 * Marqueur de version dans les URL des modules ESM de la page.
 *
 * `index.html` est servi par une route dynamique — donc toujours frais — alors
 * que les modules passent par `express.static`. Un navigateur a pu apparier une
 * page NEUVE, qui importe `secretUsers`, avec un `profile-card.js` ANCIEN qui ne
 * l'exporte pas : l'import échoue, et comme un bloc module est tout-ou-rien, les
 * dix-neuf fonctions du pont disparaissent d'un coup (cf. invariant 10).
 *
 * Mettre la version dans l'URL rend l'appariement impossible : une page d'une
 * version donnée ne peut demander que les modules de cette version.
 */
export const ASSET_VERSION_PLACEHOLDER = "__ASSET_V__";

export function injectAssetVersion(html: string, version: string): string {
  // La version vient du package.json et finit dans une URL : on l'encode, sinon
  // un caractère malheureux casserait l'import qu'elle est censée protéger.
  return html.split(ASSET_VERSION_PLACEHOLDER).join(encodeURIComponent(version));
}

export const INSTANCE_KEY_PLACEHOLDER = "__INSTANCE_KEY__";

// The launch-dir key namespaces the client's localStorage channel cache. It has
// to be present SYNCHRONOUSLY at parse time: fetching it from /defaults leaves a
// window where an early persist writes the un-namespaced (cross-dir) cache key —
// the very leak this closes. So the server stamps it into the page like the
// nonce. instanceKey() only ever yields [a-zA-Z0-9-]; we sanitise anyway, since
// the value lands inside a JS string literal.
export function injectInstanceKey(html: string, key: string): string {
  return html.split(INSTANCE_KEY_PLACEHOLDER).join(key.replace(/[^a-zA-Z0-9-]/g, ""));
}
