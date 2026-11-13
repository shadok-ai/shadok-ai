// Google client, twin of src/linkedin.ts: token refresh through the broker,
// then plain `fetch` calls for Calendar, Drive (drive.file), Docs, Sheets and
// Gmail drafts/send — no Google client library. Every call goes through an
// injected fetch so tests never touch the network. A token is only ever put in
// an Authorization header (or the broker's refresh body); it never enters an
// error message. Design:
// docs/superpowers/specs/2026-11-13-connected-accounts-google-design.md §3–4.
import { createHash, randomBytes } from "node:crypto";
import type { ConnectedAccount } from "./connected-accounts.js";

export type FetchFn = typeof fetch;

const TIMEOUT_MS = 30_000;
const deadline = () => AbortSignal.timeout(TIMEOUT_MS);

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export class GoogleError extends Error {
  status: number;
  /** The grant is dead (`invalid_grant`, or a 401 on a fresh token): reconnect. */
  expired: boolean;
  constructor(message: string, status: number, expired = status === 401) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
    this.expired = expired;
  }
}

/** A request the agent got wrong (a bad address, a line break in a subject, a
 *  malformed date): refused before Google is called, in our own words. */
export class GoogleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleInputError";
  }
}

/**
 * A request that LEAVES the account (a send, an event write) was sent and got
 * no answer. It may well have gone through: the caller must say "check before
 * retrying", never "it failed".
 */
export class GoogleOutcomeUnknownError extends Error {
  constructor() {
    super("Google did not answer the request.");
    this.name = "GoogleOutcomeUnknownError";
  }
}

async function failure(what: string, res: Response): Promise<GoogleError> {
  let detail = "";
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw) as { error?: { message?: unknown } | string; error_description?: unknown };
      const m = typeof j.error === "object" && j.error ? j.error.message : (j.error_description ?? j.error);
      detail = typeof m === "string" ? m : "";
    } catch {
      detail = raw;
    }
    detail = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    /* no body */
  }
  return new GoogleError(`Google ${what} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
}

const bearer = (token: string, json = false): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  ...(json ? { "Content-Type": "application/json" } : {}),
});

async function getJson<T>(what: string, url: string, token: string, fetchFn: FetchFn): Promise<T> {
  const res = await fetchFn(url, { headers: bearer(token), signal: deadline() });
  if (!res.ok) throw await failure(what, res);
  return (await res.json()) as T;
}

async function sendJson<T>(
  what: string,
  method: "POST" | "PATCH" | "PUT",
  url: string,
  token: string,
  body: unknown,
  fetchFn: FetchFn,
  outbound = false,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, { method, headers: bearer(token, true), body: JSON.stringify(body), signal: deadline() });
  } catch (e) {
    if (outbound) throw new GoogleOutcomeUnknownError();
    throw e;
  }
  if (!res.ok) throw await failure(what, res);
  return (await res.json().catch(() => ({}))) as T;
}

/** An id that goes into a URL path: Google's are URL-safe words. */
function pathId(what: string, id: unknown): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new GoogleInputError(`That is not a valid ${what} id.`);
  return id;
}

// ---- access token --------------------------------------------------------

export interface TokenStore {
  get(id: string): ConnectedAccount | undefined;
  patch(id: string, patch: Partial<ConnectedAccount>): void;
}

export function needsRefresh(a: Pick<ConnectedAccount, "expiresAt">, now: number): boolean {
  return a.expiresAt - now < REFRESH_MARGIN_MS;
}

export const RECONNECT_REASON = "Google no longer accepts this account's authorisation.";

/**
 * The account's access token, refreshed through the broker when it has under
 * 5 minutes left. Google access tokens last about an hour and refreshing needs
 * the client secret, which only the broker holds (`POST /google/refresh`).
 * ONE refresh per account at a time: every caller that arrives meanwhile
 * awaits the same promise. `invalid_grant` marks the account expired, so every
 * later call refuses with the reconnect sentence instead of asking again.
 */
export class GoogleTokens {
  private inflight = new Map<string, Promise<string>>();
  constructor(private deps: { broker: string; fetchFn: FetchFn; store: TokenStore; now: () => number }) {}

  accessToken(accountId: string): Promise<string> {
    const a = this.deps.store.get(accountId);
    if (!a || a.provider !== "google") return Promise.reject(new GoogleError("That Google account is no longer connected.", 410, false));
    if (a.status === "expired") return Promise.reject(new GoogleError(RECONNECT_REASON, 401, true));
    if (!needsRefresh(a, this.deps.now())) return Promise.resolve(a.token);
    const running = this.inflight.get(accountId);
    if (running) return running;
    const p = this.refresh(a).finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, p);
    return p;
  }

  private async refresh(a: ConnectedAccount): Promise<string> {
    if (!a.refreshToken) {
      this.deps.store.patch(a.id, { status: "expired", updatedAt: this.deps.now() });
      throw new GoogleError(RECONNECT_REASON, 401, true);
    }
    let res: Response;
    try {
      res = await this.deps.fetchFn(`${this.deps.broker}/google/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: a.refreshToken }),
        signal: deadline(),
      });
    } catch {
      throw new GoogleError("The connector could not be reached to renew Google access — try again in a moment.", 502, false);
    }
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };
    if (!res.ok) {
      if (j.error === "invalid_grant") {
        this.deps.store.patch(a.id, { status: "expired", updatedAt: this.deps.now() });
        throw new GoogleError(RECONNECT_REASON, 401, true);
      }
      throw new GoogleError(`Google access could not be renewed (${res.status}) — try again in a moment.`, 502, false);
    }
    if (typeof j.access_token !== "string" || !j.access_token) throw new GoogleError("Google access could not be renewed — try again in a moment.", 502, false);
    const lifetime = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
    this.deps.store.patch(a.id, {
      token: j.access_token,
      expiresAt: this.deps.now() + lifetime * 1000,
      ...(typeof j.scope === "string" && j.scope.trim() ? { scopes: [...new Set(j.scope.split(/\s+/).filter(Boolean))] } : {}),
    });
    return j.access_token;
  }
}

// ---- identity, revoke ----------------------------------------------------

export async function fetchUser(token: string, fetchFn: FetchFn): Promise<{ sub: string; email: string }> {
  const j = await getJson<{ sub?: string; email?: string }>("profile lookup", "https://openidconnect.googleapis.com/v1/userinfo", token, fetchFn);
  if (!j.sub) throw new GoogleError("Google profile lookup returned no account id.", 502, false);
  return { sub: j.sub, email: j.email ?? "" };
}

/** Disconnect revokes at Google (no client secret needed). The token rides in
 *  the form body, never the URL. Best effort: true when Google took it. */
export async function revokeToken(token: string, fetchFn: FetchFn): Promise<boolean> {
  try {
    const res = await fetchFn("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: deadline(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- mail: addresses, RFC 2047, the RFC 2822 builder ---------------------

export interface MailFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface MailAttachment {
  name: string;
  mime: string;
  bytes: Buffer;
}

export const MAX_SUBJECT = 500;
export const MAX_RECIPIENTS = 100;
export const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

const ADDR_SPEC = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
// Any control character, CR and LF first: in a header field one of them ends
// the field and starts another — the header-injection door.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `a@b.c` or `Display Name <a@b.c>` → its parts; null for anything else. */
export function parseAddress(raw: string): { name: string; addr: string } | null {
  const s = raw.trim();
  const m = /^(.*)<([^<>]+)>$/.exec(s);
  const addr = (m ? m[2] : s).trim();
  if (!ADDR_SPEC.test(addr)) return null;
  let name = m ? m[1].trim() : "";
  if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  if (/[<>]/.test(name)) return null;
  return { name, addr };
}

const isPlainAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/**
 * RFC 2047 encoded-words for a header value. Each word is at most 75
 * characters, so the UTF-8 is cut at 45 bytes per word, on a character
 * boundary (a word must decode on its own), and the words are folded.
 */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk: string[] = [];
  let size = 0;
  const flush = () => {
    if (chunk.length) words.push(`=?UTF-8?B?${Buffer.from(chunk.join(""), "utf8").toString("base64")}?=`);
    chunk = [];
    size = 0;
  };
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (size + n > 45) flush();
    chunk.push(ch);
    size += n;
  }
  flush();
  return words.join("\r\n ");
}

/** An unstructured header value (Subject): as written when plain ASCII, else RFC 2047. */
export function encodeHeaderText(text: string): string {
  return isPlainAscii(text) && !text.includes("=?") ? text : encodeWords(text);
}

function formatAddress(a: { name: string; addr: string }): string {
  if (!a.name) return a.addr;
  const name = isPlainAscii(a.name) ? `"${a.name.replace(/[\\"]/g, "\\$&")}"` : encodeWords(a.name);
  return `${name} <${a.addr}>`;
}

function addressList(field: string, list: readonly string[]): { name: string; addr: string }[] {
  return list.map((raw) => {
    if (typeof raw !== "string" || CONTROL.test(raw)) throw new GoogleInputError(`A ${field} address contains a line break or control character.`);
    const a = parseAddress(raw);
    if (!a) throw new GoogleInputError(`'${raw.slice(0, 80)}' is not an email address (use a@b.c or Name <a@b.c>).`);
    return a;
  });
}

const strings = (v: unknown): string[] | null =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

/**
 * The mail fields an agent supplied, checked: the agent gives FIELDS, never
 * raw MIME, so a subject or an address with a line break is refused here
 * rather than becoming a second header. Throws `GoogleInputError`.
 */
export function mailFieldsVerdict(raw: { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; body?: unknown }): MailFields {
  const to = strings(raw.to);
  const cc = strings(raw.cc);
  const bcc = strings(raw.bcc);
  if (!to || !cc || !bcc) throw new GoogleInputError("to, cc and bcc must be lists of email addresses.");
  if (to.length + cc.length + bcc.length === 0) throw new GoogleInputError("The email has no recipient.");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new GoogleInputError(`An email takes at most ${MAX_RECIPIENTS} recipients.`);
  if (typeof raw.subject !== "string" || !raw.subject.trim()) throw new GoogleInputError("The email has no subject.");
  if (CONTROL.test(raw.subject)) throw new GoogleInputError("The subject contains a line break or control character.");
  if ([...raw.subject].length > MAX_SUBJECT) throw new GoogleInputError(`The subject is longer than ${MAX_SUBJECT} characters.`);
  if (typeof raw.body !== "string" || !raw.body.trim()) throw new GoogleInputError("The email body is empty.");
  const fmt = (field: string, list: string[]) => addressList(field, list).map(formatDisplay);
  return { to: fmt("To", to), cc: fmt("Cc", cc), bcc: fmt("Bcc", bcc), subject: raw.subject.trim(), body: raw.body };
}

/** How an address is shown on the card and kept in the draft: readable, not encoded. */
function formatDisplay(a: { name: string; addr: string }): string {
  if (!a.name) return a.addr;
  // A name with a comma (or another separator) is quoted, or every later
  // split of the list would read it as two recipients.
  const name = /[,;:"<>()[\]@\\]/.test(a.name) ? `"${a.name.replace(/[\\"]/g, "\\$&")}"` : a.name;
  return `${name} <${a.addr}>`;
}

const wrap76 = (b64: string) => b64.replace(/.{76}/g, "$&\r\n").replace(/\r\n$/, "");

/** An attachment's name as it goes in a header: no path, no control character. */
export function attachmentName(raw: string): string {
  const name = raw.split(/[\\/]/).pop() ?? "";
  if (!name || CONTROL.test(name)) throw new GoogleInputError("An attachment name is empty or contains a line break or control character.");
  return name;
}

function dispositionParams(name: string): string {
  if (isPlainAscii(name)) return `filename="${name.replace(/[\\"]/g, "\\$&")}"`;
  // RFC 2231 for the name Gmail and every current client read.
  return `filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/**
 * The RFC 2822 message Gmail is handed (then base64url, `rawMessage`). Built
 * here, server-side, from checked fields. No `From`: Gmail sets it to the
 * account. The body is UTF-8 text in base64, so no line of it can be read as
 * a header or a boundary.
 */
export function buildMime(fields: MailFields, attachments: readonly MailAttachment[] = [], boundary = `shadok-${randomBytes(12).toString("hex")}`): string {
  const head: string[] = [];
  const list = (field: string, v: string[]) => {
    if (v.length) head.push(`${field}: ${addressList(field, v).map(formatAddress).join(",\r\n ")}`);
  };
  list("To", fields.to);
  list("Cc", fields.cc);
  list("Bcc", fields.bcc);
  if (CONTROL.test(fields.subject)) throw new GoogleInputError("The subject contains a line break or control character.");
  head.push(`Subject: ${encodeHeaderText(fields.subject)}`, "MIME-Version: 1.0");
  const text = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(fields.body, "utf8").toString("base64"))];
  if (!attachments.length) return [...head, ...text].join("\r\n") + "\r\n";
  const parts = [`--${boundary}`, ...text];
  for (const at of attachments) {
    const name = attachmentName(at.name);
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(at.mime) ? at.mime : "application/octet-stream";
    parts.push(
      `--${boundary}`,
      `Content-Type: ${mime}`,
      `Content-Disposition: attachment; ${dispositionParams(name)}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(at.bytes.toString("base64")),
    );
  }
  parts.push(`--${boundary}--`);
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n") + "\r\n";
}

export const rawMessage = (mime: string) => Buffer.from(mime, "utf8").toString("base64url");

/** RFC 2047 encoded-words back to text (what a Gmail header may carry). */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toLowerCase() === "b"
            ? Buffer.from(data, "base64")
            : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return new TextDecoder(charset.split("*")[0]).decode(bytes);
      } catch {
        return whole;
      }
    });
}

/** The addresses of a header value, in order: `a@b.c`, lower-cased. */
export function addrSpecs(headerValue: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  const push = () => {
    const m = /<([^<>]+)>/.exec(cur);
    const addr = (m ? m[1] : cur).trim().toLowerCase();
    if (addr) out.push(addr);
    cur = "";
  };
  for (const ch of headerValue) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !quoted && depth === 0) push();
    else cur += ch;
  }
  push();
  return out;
}

/** What a mail IS for the approval comparison: recipients, subject, body, attachment names. */
export interface MailContent {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: string[];
}

const normBody = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\s+$/, "");

/**
 * The hash a card's snapshot and Gmail's current draft are compared by:
 * recipient addresses (display names do not change who receives it), subject,
 * body (line endings and trailing whitespace aside — Gmail rewrites both),
 * attachment names.
 */
export function mailFingerprint(m: MailContent): string {
  const specs = (l: readonly string[]) => l.flatMap((x) => addrSpecs(x));
  const canon = { to: specs(m.to), cc: specs(m.cc), bcc: specs(m.bcc), subject: m.subject.trim(), body: normBody(m.body), attachments: [...m.attachments] };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/div|\/p)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * A Gmail message (`format=full`) as `MailContent`: what the draft says NOW,
 * after whatever the person did to it in Gmail. The text/plain part is the
 * body; a draft Gmail rewrote as HTML only falls back to its text.
 */
export function parseGmailMessage(payload: GmailPart | undefined): MailContent {
  const rawHeader = (name: string) => (payload?.headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name)?.value ?? "";
  const header = (name: string) => decodeWords(rawHeader(name));
  const split = (v: string) => {
    const out: string[] = [];
    let quoted = false;
    let depth = 0;
    let cur = "";
    for (const ch of v) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === "<") depth++;
      else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
      if (ch === "," && !quoted && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  let plain: string | null = null;
  let html: string | null = null;
  const attachments: string[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename) {
      attachments.push(p.filename);
      return;
    }
    const data = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : null;
    if (p.mimeType === "text/plain" && data !== null && plain === null) plain = data;
    else if (p.mimeType === "text/html" && data !== null && html === null) html = data;
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const body = plain ?? (html !== null ? htmlToText(html) : "");
  // Shown the way the card shows an agent's own fields (`Name <addr>`), not
  // with the quoting the raw header happens to carry.
  // Split on the RAW header, decoded afterwards: an encoded name may hold a
  // comma ("Dupré, Jean"), which decoded first would read as two recipients.
  const shown = (name: string) =>
    split(rawHeader(name)).map((raw) => {
      const x = decodeWords(raw);
      const a = parseAddress(x);
      return a ? formatDisplay(a) : x;
    });
  return { to: shown("to"), cc: shown("cc"), bcc: shown("bcc"), subject: header("subject"), body: normBody(body), attachments };
}

// ---- Gmail ---------------------------------------------------------------

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function createGmailDraft(token: string, raw: string, fetchFn: FetchFn): Promise<{ id: string }> {
  const j = await sendJson<{ id?: string }>("draft creation", "POST", `${GMAIL}/drafts`, token, { message: { raw } }, fetchFn);
  if (!j.id) throw new GoogleError("Gmail created the draft but returned no id.", 502, false);
  return { id: j.id };
}

export async function updateGmailDraft(token: string, draftId: string, raw: string, fetchFn: FetchFn): Promise<{ id: string }> {
  await sendJson("draft update", "PUT", `${GMAIL}/drafts/${pathId("draft", draftId)}`, token, { message: { raw } }, fetchFn);
  return { id: draftId };
}

/** The draft as it is now, or null when it no longer exists (deleted, or already sent). */
export async function getGmailDraft(token: string, draftId: string, fetchFn: FetchFn): Promise<MailContent | null> {
  const res = await fetchFn(`${GMAIL}/drafts/${pathId("draft", draftId)}?format=full`, { headers: bearer(token), signal: deadline() });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure("draft lookup", res);
  const j = (await res.json()) as { message?: { payload?: GmailPart } };
  return parseGmailMessage(j.message?.payload);
}

export async function sendGmailDraft(token: string, draftId: string, fetchFn: FetchFn): Promise<{ id: string }> {
  const j = await sendJson<{ id?: string }>("send", "POST", `${GMAIL}/drafts/send`, token, { id: pathId("draft", draftId) }, fetchFn, true);
  return { id: j.id ?? "" };
}

/** True when the draft is gone afterwards (deleted now, or already absent). */
export async function deleteGmailDraft(token: string, draftId: string, fetchFn: FetchFn): Promise<boolean> {
  const res = await fetchFn(`${GMAIL}/drafts/${pathId("draft", draftId)}`, { method: "DELETE", headers: bearer(token), signal: deadline() });
  if (res.ok || res.status === 404) return true;
  throw await failure("draft deletion", res);
}

export async function sendGmailMessage(token: string, raw: string, fetchFn: FetchFn): Promise<{ id: string }> {
  const j = await sendJson<{ id?: string }>("send", "POST", `${GMAIL}/messages/send`, token, { raw }, fetchFn, true);
  return { id: j.id ?? "" };
}

// ---- Calendar ------------------------------------------------------------

const CAL = "https://www.googleapis.com/calendar/v3/calendars";

export interface EventFields {
  title: string;
  /** `YYYY-MM-DD` (all day) or an ISO date-time. */
  start: string;
  end: string;
  timeZone?: string;
  attendees: string[];
  location?: string;
  description?: string;
}

export interface EventView extends EventFields {
  id: string;
  allDay: boolean;
  link?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const hasOffset = (s: string) => /(Z|[+-]\d{2}:\d{2})$/.test(s);

function timeZoneOk(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One event time, checked: a date (all day) or a date-time that says which
 *  zone it is in — by its own offset or by `timeZone`. */
/** Is the calendar day of `v` (its first 10 characters) a day that exists?
 *  `Date.parse` accepts 2026-02-31 and rolls it over; Google refuses it. */
function realDay(v: string): boolean {
  const [y, m, d] = v.slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A comparable instant; a wall-clock time is read as UTC, which orders two
 *  times of the same zone correctly. */
const roughInstant = (v: string) => Date.parse(DATE_RE.test(v) ? `${v}T00:00:00Z` : hasOffset(v) ? v : `${v}Z`);

function eventTime(what: string, v: unknown, tz: string | undefined): { date: string } | { dateTime: string; timeZone?: string } {
  if (typeof v !== "string" || !(DATE_RE.test(v) || DATETIME_RE.test(v)) || !realDay(v) || Number.isNaN(roughInstant(v)))
    throw new GoogleInputError(`The event's ${what} must be a date (YYYY-MM-DD) or a date-time (YYYY-MM-DDTHH:MM, with an offset or a time zone).`);
  if (DATE_RE.test(v)) return { date: v };
  if (!hasOffset(v) && !tz) throw new GoogleInputError(`The event's ${what} has no offset: give a time zone (e.g. Europe/Paris).`);
  const dateTime = /T\d{2}:\d{2}($|Z|[+-])/.test(v) ? v.replace(/(T\d{2}:\d{2})/, "$1:00") : v;
  // A time that carries its own offset IS an instant: a zone sent beside it
  // would not move it, only make the card's "(zone)" label a lie. The zone is
  // sent only for a wall-clock time, where it is what fixes the instant.
  return hasOffset(v) ? { dateTime } : { dateTime, timeZone: tz };
}

/**
 * The fields of an event write, checked and normalised. `partial` (an update)
 * accepts any subset; a create needs title, start and end. Throws `GoogleInputError`.
 */
export function eventFieldsVerdict(raw: Record<string, unknown>, partial = false): Partial<EventFields> {
  const out: Partial<EventFields> = {};
  const text = (k: "title" | "location" | "description", max: number) => {
    const v = raw[k];
    if (v === undefined || v === null) return;
    if (typeof v !== "string") throw new GoogleInputError(`The event's ${k} must be text.`);
    if (k !== "description" && CONTROL.test(v)) throw new GoogleInputError(`The event's ${k} contains a line break or control character.`);
    if ([...v].length > max) throw new GoogleInputError(`The event's ${k} is longer than ${max} characters.`);
    out[k] = k === "description" ? v : v.trim();
  };
  text("title", 500);
  text("location", 500);
  text("description", 8000);
  if (raw.timeZone !== undefined && raw.timeZone !== null) {
    if (typeof raw.timeZone !== "string" || !timeZoneOk(raw.timeZone)) throw new GoogleInputError(`'${String(raw.timeZone).slice(0, 60)}' is not a time zone (use an IANA name such as Europe/Paris).`);
    out.timeZone = raw.timeZone;
  }
  for (const k of ["start", "end"] as const) {
    if (raw[k] === undefined || raw[k] === null) continue;
    eventTime(k, raw[k], out.timeZone);
    out[k] = raw[k] as string;
  }
  if (raw.attendees !== undefined && raw.attendees !== null) {
    const list = strings(raw.attendees);
    if (!list) throw new GoogleInputError("attendees must be a list of email addresses.");
    if (list.length > MAX_RECIPIENTS) throw new GoogleInputError(`An event takes at most ${MAX_RECIPIENTS} attendees.`);
    out.attendees = addressList("attendee", list).map((a) => a.addr);
  }
  if (!partial) {
    if (!out.title) throw new GoogleInputError("The event has no title.");
    if (!out.start || !out.end) throw new GoogleInputError("The event needs a start and an end.");
    out.attendees = out.attendees ?? [];
  }
  if (out.start && out.end) {
    if (DATE_RE.test(out.start) !== DATE_RE.test(out.end)) throw new GoogleInputError("The event's start and end must both be dates, or both date-times.");
    // Compared only when both say the same kind of time (two offsets, or two
    // wall-clock times of the one zone); a mix is left to Google.
    if (hasOffset(out.start) === hasOffset(out.end) && roughInstant(out.end) <= roughInstant(out.start)) {
      throw new GoogleInputError(
        DATE_RE.test(out.start) ? "An all-day event's end is the day AFTER its last day (a one-day event on the 20th ends on the 21st)." : "The event ends before it starts.",
      );
    }
  } else if (partial && (out.start || out.end)) {
    throw new GoogleInputError("To move an event give both its start and its end.");
  } else if (partial && out.timeZone) {
    // A zone alone changes nothing Google is sent: the card would show a
    // change and the event would stay as it was.
    throw new GoogleInputError("To change an event's time zone give its start and its end too.");
  }
  if (partial && Object.keys(out).length === 0) throw new GoogleInputError("Nothing to change: give at least one field.");
  return out;
}

function eventBody(f: Partial<EventFields>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (f.title !== undefined) b.summary = f.title;
  if (f.location !== undefined) b.location = f.location;
  if (f.description !== undefined) b.description = f.description;
  if (f.start !== undefined) b.start = eventTime("start", f.start, f.timeZone);
  if (f.end !== undefined) b.end = eventTime("end", f.end, f.timeZone);
  if (f.attendees !== undefined) b.attendees = f.attendees.map((email) => ({ email }));
  return b;
}

interface GEvent {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: { email?: string }[];
}

export function eventView(e: GEvent): EventView {
  const allDay = !!e.start?.date;
  return {
    id: e.id ?? "",
    title: e.summary ?? "",
    start: e.start?.date ?? e.start?.dateTime ?? "",
    end: e.end?.date ?? e.end?.dateTime ?? "",
    ...(e.start?.timeZone ? { timeZone: e.start.timeZone } : {}),
    allDay,
    attendees: (e.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.htmlLink ? { link: e.htmlLink } : {}),
  };
}

const calUrl = (calendarId: string, tail = "") => {
  if (typeof calendarId !== "string" || !calendarId || CONTROL.test(calendarId) || calendarId.length > 256) throw new GoogleInputError("That is not a valid calendar id.");
  return `${CAL}/${encodeURIComponent(calendarId)}/events${tail}`;
};

/** An RFC 3339 instant for a list window; a bare date-time is read as UTC. */
function instant(what: string, v: unknown): string {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new GoogleInputError(`'${String(v).slice(0, 40)}' is not a date for ${what} (use YYYY-MM-DD or an ISO date-time).`);
  return new Date(DATE_RE.test(v) || hasOffset(v) ? v : `${v}Z`).toISOString();
}

export async function listEvents(
  token: string,
  o: { calendarId?: string; from?: unknown; to?: unknown; max?: number },
  fetchFn: FetchFn,
  now = Date.now(),
): Promise<EventView[]> {
  const q = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(Math.max(Math.trunc(o.max ?? 25) || 25, 1), 100)),
    timeMin: o.from === undefined ? new Date(now).toISOString() : instant("--from", o.from),
    timeMax: o.to === undefined ? new Date(now + 7 * 24 * 3600_000).toISOString() : instant("--to", o.to),
  });
  const j = await getJson<{ items?: GEvent[] }>("calendar listing", `${calUrl(o.calendarId ?? "primary")}?${q}`, token, fetchFn);
  return (j.items ?? []).map(eventView);
}

/** The event as it is now, or null when it does not exist (or was cancelled). */
export async function getEvent(token: string, calendarId: string, eventId: string, fetchFn: FetchFn): Promise<EventView | null> {
  const res = await fetchFn(calUrl(calendarId, `/${pathId("event", eventId)}`), { headers: bearer(token), signal: deadline() });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw await failure("event lookup", res);
  const j = (await res.json()) as GEvent & { status?: string };
  return j.status === "cancelled" ? null : eventView(j);
}

// `sendUpdates=all`: the attendees are mailed about what happened to the
// event — which is exactly what the approval card says will happen.
export async function insertEvent(token: string, calendarId: string, f: EventFields, fetchFn: FetchFn): Promise<EventView> {
  return eventView(await sendJson<GEvent>("event creation", "POST", `${calUrl(calendarId)}?sendUpdates=all`, token, eventBody(f), fetchFn, true));
}

export async function patchEvent(token: string, calendarId: string, eventId: string, f: Partial<EventFields>, fetchFn: FetchFn): Promise<EventView> {
  return eventView(await sendJson<GEvent>("event update", "PATCH", `${calUrl(calendarId, `/${pathId("event", eventId)}`)}?sendUpdates=all`, token, eventBody(f), fetchFn, true));
}

export async function deleteEvent(token: string, calendarId: string, eventId: string, fetchFn: FetchFn): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${calUrl(calendarId, `/${pathId("event", eventId)}`)}?sendUpdates=all`, { method: "DELETE", headers: bearer(token), signal: deadline() });
  } catch {
    throw new GoogleOutcomeUnknownError();
  }
  // Already gone is what a delete wanted.
  if (!res.ok && res.status !== 404 && res.status !== 410) throw await failure("event deletion", res);
}

// ---- Drive, Docs, Sheets (drive.file: the app's own files only) ----------

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  link?: string;
}

export async function listFiles(token: string, o: { max?: number }, fetchFn: FetchFn): Promise<DriveFile[]> {
  const q = new URLSearchParams({
    pageSize: String(Math.min(Math.max(Math.trunc(o.max ?? 50) || 50, 1), 200)),
    orderBy: "modifiedTime desc",
    q: "trashed = false",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  const j = await getJson<{ files?: { id?: string; name?: string; mimeType?: string; modifiedTime?: string; webViewLink?: string }[] }>(
    "file listing",
    `https://www.googleapis.com/drive/v3/files?${q}`,
    token,
    fetchFn,
  );
  return (j.files ?? []).map((f) => ({
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}),
    ...(f.webViewLink ? { link: f.webViewLink } : {}),
  }));
}

const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

function titleOk(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new GoogleInputError("A title is required.");
  if (CONTROL.test(v) || [...v].length > 300) throw new GoogleInputError("The title is too long or contains a line break.");
  return v.trim();
}

export async function createDoc(token: string, title: unknown, fetchFn: FetchFn): Promise<{ id: string; name: string; link: string }> {
  const name = titleOk(title);
  const j = await sendJson<{ documentId?: string }>("document creation", "POST", DOCS, token, { title: name }, fetchFn);
  if (!j.documentId) throw new GoogleError("Google created the document but returned no id.", 502, false);
  return { id: j.documentId, name, link: `https://docs.google.com/document/d/${j.documentId}/edit` };
}

interface DocBody {
  title?: string;
  body?: { content?: { paragraph?: { elements?: { textRun?: { content?: string } }[] } }[] };
}

export async function readDoc(token: string, id: string, fetchFn: FetchFn): Promise<{ id: string; name: string; text: string }> {
  const j = await getJson<DocBody>("document read", `${DOCS}/${pathId("document", id)}`, token, fetchFn);
  const text = (j.body?.content ?? []).flatMap((c) => (c.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "")).join("");
  return { id, name: j.title ?? "", text };
}

export async function appendDoc(token: string, id: string, text: unknown, fetchFn: FetchFn): Promise<void> {
  if (typeof text !== "string" || !text) throw new GoogleInputError("There is no text to append.");
  await sendJson("document update", "POST", `${DOCS}/${pathId("document", id)}:batchUpdate`, token, { requests: [{ insertText: { text, endOfSegmentLocation: {} } }] }, fetchFn);
}

export async function createSheet(token: string, title: unknown, fetchFn: FetchFn): Promise<{ id: string; name: string; link: string }> {
  const name = titleOk(title);
  const j = await sendJson<{ spreadsheetId?: string }>("spreadsheet creation", "POST", SHEETS, token, { properties: { title: name } }, fetchFn);
  if (!j.spreadsheetId) throw new GoogleError("Google created the spreadsheet but returned no id.", 502, false);
  return { id: j.spreadsheetId, name, link: `https://docs.google.com/spreadsheets/d/${j.spreadsheetId}/edit` };
}

function rangeOk(v: unknown): string {
  if (v === undefined || v === null || v === "") return "A1:Z1000";
  if (typeof v !== "string" || CONTROL.test(v) || v.length > 200) throw new GoogleInputError("That is not a valid range (use A1 notation, e.g. Sheet1!A1:D20).");
  return v;
}

export async function readSheet(token: string, id: string, range: unknown, fetchFn: FetchFn): Promise<{ id: string; range: string; rows: unknown[][] }> {
  const j = await getJson<{ range?: string; values?: unknown[][] }>("spreadsheet read", `${SHEETS}/${pathId("spreadsheet", id)}/values/${encodeURIComponent(rangeOk(range))}`, token, fetchFn);
  return { id, range: j.range ?? "", rows: j.values ?? [] };
}

/** Rows of plain cells. Written RAW: a cell starting with `=` stays text, so
 *  an agent cannot plant a formula that reads or fetches on the person's behalf. */
export function rowsVerdict(v: unknown): (string | number | boolean)[][] {
  const cell = (c: unknown) => typeof c === "string" || typeof c === "number" || typeof c === "boolean";
  if (!Array.isArray(v) || !v.length || !v.every((r) => Array.isArray(r) && r.every(cell)))
    throw new GoogleInputError("Rows must be a non-empty JSON array of arrays of text, numbers or booleans.");
  if (v.length > 1000) throw new GoogleInputError("At most 1000 rows per append.");
  return v as (string | number | boolean)[][];
}

export async function appendSheet(token: string, id: string, range: unknown, rows: unknown, fetchFn: FetchFn): Promise<{ updatedRange: string }> {
  const values = rowsVerdict(rows);
  const url = `${SHEETS}/${pathId("spreadsheet", id)}/values/${encodeURIComponent(rangeOk(range))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const j = await sendJson<{ updates?: { updatedRange?: string } }>("spreadsheet append", "POST", url, token, { values }, fetchFn);
  return { updatedRange: j.updates?.updatedRange ?? "" };
}
