// A generic READ-ONLY window on the Google APIs the cockpit already holds a
// grant for: one GET, on an allowlist of hosts and path prefixes, each mapped
// to the OAuth area that must be held for it. It exists so that an agent can
// read what no dedicated command covers (labels, attendee responses,
// revisions, formulas, speaker notes, a document's structure…) without the
// cockpit growing one action per field. It never writes: no other method, no
// body, no redirect followed, binary and media refused (the download path owns
// those), the answer capped. Every call is audited by URL — never by body —
// and handed to the agent as untrusted content. Design: src/google-actions.ts
// (`api.get`), docs/architecture.md "Google: the read-only passthrough".
import type { GoogleArea } from "./connected-accounts.js";
import { GoogleError, GoogleInputError, MAX_FILE_CHARS, cappedBytes, truncateBody, type FetchFn } from "./google.js";

/** Where a GET may go, and the area that must be held for it. Exact host,
 *  path PREFIX on the normalised path. Gmail is the person's own mailbox only. */
export const PASSTHROUGH_ROUTES: readonly { host: string; prefix: string; area: GoogleArea }[] = [
  { host: "gmail.googleapis.com", prefix: "/gmail/v1/users/me/", area: "gmail_read" },
  { host: "www.googleapis.com", prefix: "/gmail/v1/users/me/", area: "gmail_read" },
  { host: "www.googleapis.com", prefix: "/calendar/v3/", area: "calendar" },
  { host: "www.googleapis.com", prefix: "/drive/v3/", area: "drive" },
  { host: "docs.googleapis.com", prefix: "/v1/documents/", area: "drive" },
  { host: "sheets.googleapis.com", prefix: "/v4/spreadsheets/", area: "drive" },
  { host: "slides.googleapis.com", prefix: "/v1/presentations/", area: "drive" },
];

/** A response larger than this is refused, not cut: narrow it with `fields=`. */
export const PASSTHROUGH_MAX_BYTES = 2 * 1024 * 1024;
/** What the agent is handed of it, at most. */
export const PASSTHROUGH_MAX_CHARS = 2 * MAX_FILE_CHARS;

const CONTROL = /[\u0000-\u001f\u007f]/;
const ALLOWED = PASSTHROUGH_ROUTES.map((r) => `https://${r.host}${r.prefix}…`).join(", ");

/**
 * Is this URL one the passthrough may GET, and under which area? Refused
 * before any token is fetched: anything off the allowlist, a scheme other
 * than https, credentials or a port in the URL, an encoded slash or a dot
 * segment (a path must not be able to mean something else to Google than to
 * this check), media and uploads (`drive download` owns those), a JSONP
 * callback, a key or token in the query.
 */
export function passthroughPlan(raw: unknown): { url: string; area: GoogleArea } {
  if (typeof raw !== "string" || !raw.trim()) throw new GoogleInputError("Give the Google API URL to read (--url https://…googleapis.com/…).");
  if (raw.length > 4096 || CONTROL.test(raw)) throw new GoogleInputError("That URL is too long or contains a control character.");
  // The path is judged RAW: `new URL` would resolve `..` (and `%2e%2e`) and keep `%2F`.
  const rawPath = raw.split(/[?#]/)[0]!;
  if (/%2f|%5c|\\|%2e/i.test(rawPath) || /\/\.\.?(\/|$)/.test(rawPath)) throw new GoogleInputError("That URL has an encoded slash or a dot segment — write the path plainly.");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GoogleInputError("That is not a URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw new GoogleInputError("Only a plain https:// Google API URL can be read.");
  const route = PASSTHROUGH_ROUTES.find((r) => r.host === u.hostname && u.pathname.startsWith(r.prefix));
  if (!route) throw new GoogleInputError(`Only these Google APIs can be read this way: ${ALLOWED}`);
  const q = u.searchParams;
  for (const k of ["access_token", "key", "oauth_token", "callback", "uploadType", "upload_id"]) {
    if (q.has(k)) throw new GoogleInputError(`The '${k}' parameter is not accepted here.`);
  }
  const alt = q.get("alt");
  if (alt !== null && alt !== "json") throw new GoogleInputError("Only JSON answers are read here: for a file's bytes use `drive download`, for its text `drive read`.");
  if (route.prefix === "/drive/v3/" && /\/(export|download)$/.test(u.pathname)) {
    throw new GoogleInputError("Exports and downloads go through `drive download` (bytes into your working directory) or `drive read` (text).");
  }
  u.hash = "";
  return { url: u.toString(), area: route.area };
}

export interface PassthroughResult {
  url: string;
  contentType: string;
  /** The answer as text — JSON re-indented — cut at `PASSTHROUGH_MAX_CHARS`. */
  text: string;
  truncated: boolean;
}

/** The GET itself. The token goes only to a host `passthroughPlan` allowed,
 *  and a redirect is never followed (it would carry the request elsewhere). */
export async function passthroughGet(token: string, url: string, fetchFn: FetchFn, cap = PASSTHROUGH_MAX_BYTES): Promise<PassthroughResult> {
  const res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new GoogleError("Google answered with a redirect, which is not followed here.", 502, false);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: { message?: unknown } };
      detail = typeof j.error?.message === "string" ? `: ${j.error.message.replace(/\s+/g, " ").slice(0, 300)}` : "";
    } catch {
      /* no JSON body */
    }
    throw new GoogleError(`Google API read failed (${res.status})${detail}`, res.status);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^(application\/json|text\/)/.test(contentType)) {
    await res.body?.cancel().catch(() => {});
    throw new GoogleInputError(`That answer is not text (${contentType || "no type"}) — for a file's bytes use \`drive download\`.`);
  }
  const bytes = await cappedBytes(res, cap, () => new GoogleInputError(`That answer is over ${cap / 1024 / 1024} MB — narrow it (fields=, maxResults=, pageSize=, a smaller range).`));
  let text = bytes.toString("utf8");
  if (contentType === "application/json") {
    try {
      text = JSON.stringify(JSON.parse(text), null, 1);
    } catch {
      /* left as it came */
    }
  }
  const cut = truncateBody(text, PASSTHROUGH_MAX_CHARS);
  return { url, contentType, text: cut.body, truncated: cut.truncated };
}
