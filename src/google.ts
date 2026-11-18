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
  /** A reply: the original's `Message-ID`, and the `References` chain it extends
   *  (`replyTarget`). Without both headers Gmail starts a new conversation, for
   *  the person AND for the recipient's client, whatever the threadId says. */
  inReplyTo?: string;
  references?: string;
  /** The person's Gmail signature (`gmailSignature`), appended by the builder.
   *  Gmail adds it only to mail composed in its web UI, never to mail an API
   *  creates — so without this every agent's email went out unsigned. */
  signature?: MailSignature;
}

/** A Gmail signature: the HTML Gmail stores, and the same as plain text. */
export interface MailSignature {
  html: string;
  text: string;
}

/** The usual signature delimiter ("-- " + newline), so mail clients can fold it. */
const SIGNATURE_DELIMITER = "\n\n-- \n";

/** The text/plain body exactly as built: the body, then the signature. Also
 *  what the approval card shows and fingerprints, so a draft re-read from
 *  Gmail (its text part) still matches the card. */
export function mailPlainBody(f: Pick<MailFields, "body" | "signature">): string {
  return f.signature?.text ? f.body + SIGNATURE_DELIMITER + f.signature.text : f.body;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The text/html body when a signature is added: the agent's text escaped
 *  (never interpreted as markup), then the signature as Gmail renders it. */
export function mailHtmlBody(f: Pick<MailFields, "body" | "signature">): string {
  const body = escHtml(f.body).replace(/\r?\n/g, "<br>\r\n");
  return `<div dir="ltr">${body}</div>\r\n<br>\r\n<div dir="ltr" class="gmail_signature">${f.signature?.html ?? ""}</div>\r\n`;
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
  head.push(`Subject: ${encodeHeaderText(fields.subject)}`);
  if (fields.inReplyTo) {
    // Built from replyTarget's checked ids; re-checked here because a header
    // carrying a line break is a header injection.
    if (!MESSAGE_ID_RE.test(fields.inReplyTo) || CONTROL.test(fields.references ?? "")) throw new GoogleInputError("The message being replied to has an unusable Message-ID.");
    head.push(`In-Reply-To: ${fields.inReplyTo}`, `References: ${fields.references || fields.inReplyTo}`);
  }
  head.push("MIME-Version: 1.0");
  const b64part = (type: string, content: string) => [`Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(content, "utf8").toString("base64"))];
  // With a signature the mail is text + HTML (multipart/alternative): the
  // signature is HTML (links, images, layout) and only an HTML part keeps it.
  // Never `${boundary}-alt`: the outer delimiter would then be a PREFIX of
  // the inner one, and a parser matching by prefix splits the wrong lines.
  const alt = `alt-${boundary}`;
  const text = fields.signature?.html
    ? [`Content-Type: multipart/alternative; boundary="${alt}"`, "", `--${alt}`, ...b64part("text/plain", mailPlainBody(fields)), `--${alt}`, ...b64part("text/html", mailHtmlBody(fields)), `--${alt}--`]
    : b64part("text/plain", mailPlainBody(fields));
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

/** HTML character references back to text (`&amp;` last, so `&amp;lt;` stays `&lt;`). */
export function decodeEntities(s: string): string {
  const cp = (n: number, whole: string) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole);
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (w, h: string) => cp(parseInt(h, 16), w))
    .replace(/&#(\d{1,7});/g, (w, d: string) => cp(Number(d), w))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** An HTML mail body as plain text: no markup, no style or script content.
 *  Never the raw HTML — it is what an agent reads, and hidden markup is where
 *  a hostile mail would put what the person never saw. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(br|\/div|\/p|\/tr|\/li|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/\n{3,}/g, "\n\n");
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

/** `threadId` puts the draft in that conversation (a reply, `replyTarget`). */
const gmailMessage = (raw: string, threadId?: string) => ({ raw, ...(threadId ? { threadId } : {}) });

export async function createGmailDraft(token: string, raw: string, fetchFn: FetchFn, threadId?: string): Promise<{ id: string }> {
  const j = await sendJson<{ id?: string }>("draft creation", "POST", `${GMAIL}/drafts`, token, { message: gmailMessage(raw, threadId) }, fetchFn);
  if (!j.id) throw new GoogleError("Gmail created the draft but returned no id.", 502, false);
  return { id: j.id };
}

export async function updateGmailDraft(token: string, draftId: string, raw: string, fetchFn: FetchFn, threadId?: string): Promise<{ id: string }> {
  await sendJson("draft update", "PUT", `${GMAIL}/drafts/${pathId("draft", draftId)}`, token, { message: gmailMessage(raw, threadId) }, fetchFn);
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

export async function sendGmailMessage(token: string, raw: string, fetchFn: FetchFn, threadId?: string): Promise<{ id: string }> {
  const j = await sendJson<{ id?: string }>("send", "POST", `${GMAIL}/messages/send`, token, gmailMessage(raw, threadId), fetchFn, true);
  return { id: j.id ?? "" };
}

/** One RFC 5322 msg-id: `<…>`, no space, no line break. */
const MESSAGE_ID_RE = /^<[^\s<>]{1,250}>$/;
/** At most this many ids are carried in `References` (the most recent ones). */
export const MAX_REFERENCES = 20;

export interface ReplyTarget {
  threadId: string;
  inReplyTo: string;
  references: string;
  /** The original's subject, for the card and the log. */
  subject: string;
}

/**
 * What a reply to `messageId` needs (needs `gmail_read`: `gmail.compose` cannot
 * read a message): its conversation, its `Message-ID` and the `References`
 * chain extended with it — the three things that make Gmail, and the
 * recipient's client, file the reply under the original.
 */
export async function replyTarget(token: string, messageId: unknown, fetchFn: FetchFn): Promise<ReplyTarget> {
  const q = ["Message-ID", "References", "Subject"].map((h) => `metadataHeaders=${h}`).join("&");
  const m = await getJson<GmailMessage>("reply lookup", `${GMAIL}/messages/${pathId("message", messageId)}?format=metadata&${q}`, token, fetchFn);
  return replyHeaders(m);
}

/** Pure half of `replyTarget`, tested on its own. */
export function replyHeaders(m: { threadId?: string; payload?: { headers?: { name?: string; value?: string }[] } }): ReplyTarget {
  const raw = (name: string) => ((m.payload?.headers ?? []).find((h) => (h.name ?? "").toLowerCase() === name)?.value ?? "").trim();
  const id = raw("message-id");
  if (!MESSAGE_ID_RE.test(id) || !m.threadId) throw new GoogleInputError("That message cannot be replied to in its thread (it has no usable Message-ID).");
  // Only well-formed ids survive: the chain is someone else's header.
  const prior = raw("references").split(/\s+/).filter((r) => MESSAGE_ID_RE.test(r) && r !== id);
  const references = [...prior.slice(-(MAX_REFERENCES - 1)), id].join(" ");
  return { threadId: m.threadId, inReplyTo: id, references, subject: decodeWords(raw("subject")).replace(/\s+/g, " ").trim() };
}

interface GmailSendAs {
  sendAsEmail?: string;
  signature?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
}

/** Pure half of `gmailSignature`: the DEFAULT "From" address's signature
 *  (the one Gmail itself would add), else the primary's; null when empty. */
export function signatureOf(list: { sendAs?: GmailSendAs[] }): MailSignature | null {
  const all = list.sendAs ?? [];
  const pick = all.find((x) => x.isDefault) ?? all.find((x) => x.isPrimary);
  const html = (pick?.signature ?? "").trim();
  if (!html) return null;
  const text = htmlToText(html).replace(/[ \t]+\n/g, "\n").trim();
  return { html, text };
}

/** The person's Gmail signature, read from their settings (`settings.sendAs`
 *  — readable with gmail.readonly, the `gmail_read` area; changing it would
 *  need a restricted settings scope, which the cockpit does not ask for). */
export async function gmailSignature(token: string, fetchFn: FetchFn): Promise<MailSignature | null> {
  return signatureOf(await getJson<{ sendAs?: GmailSendAs[] }>("signature lookup", `${GMAIL}/settings/sendAs`, token, fetchFn));
}

// ---- Gmail, reading (the `gmail_read` area: gmail.readonly) --------------

export const SEARCH_DEFAULT = 20;
export const SEARCH_MAX = 50;
/** A body longer than this is cut, with a marker that says so. */
export const MAX_BODY_CHARS = 20_000;
/** A thread longer than this is cut to its most recent messages. */
export const MAX_THREAD_MESSAGES = 20;

export interface MailListItem {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
}

export interface MailMessageView {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  subject: string;
  /** Plain text: the text/plain part, else the HTML stripped to text. */
  body: string;
  truncated: boolean;
  attachments: { name: string; size: number }[];
  unread: boolean;
  labels: string[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

const headerOf = (m: GmailMessage, name: string) =>
  decodeWords((m.payload?.headers ?? []).find((h) => (h.name ?? "").toLowerCase() === name)?.value ?? "").replace(/\s+/g, " ").trim();
const labelsOf = (m: GmailMessage) => (Array.isArray(m.labelIds) ? m.labelIds.filter((l): l is string => typeof l === "string") : []);

export function mailListItem(m: GmailMessage): MailListItem {
  const labels = labelsOf(m);
  return {
    id: m.id ?? "",
    threadId: m.threadId ?? "",
    from: headerOf(m, "from"),
    to: headerOf(m, "to"),
    subject: headerOf(m, "subject"),
    date: headerOf(m, "date"),
    // Gmail hands the snippet HTML-escaped.
    snippet: decodeEntities(m.snippet ?? "").replace(/\s+/g, " ").trim(),
    unread: labels.includes("UNREAD"),
    labels,
  };
}

/** Cut at `max` characters, saying how much is missing — never silently. */
export function truncateBody(body: string, max = MAX_BODY_CHARS): { body: string; truncated: boolean } {
  const chars = [...body];
  if (chars.length <= max) return { body, truncated: false };
  return { body: `${chars.slice(0, max).join("")}\n[… truncated: ${chars.length - max} more characters not shown]`, truncated: true };
}

export function mailMessageView(m: GmailMessage, maxBody = MAX_BODY_CHARS): MailMessageView {
  let plain: string | null = null;
  let html: string | null = null;
  const attachments: { name: string; size: number }[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename) {
      attachments.push({ name: p.filename, size: Number(p.body?.size) || 0 });
      return;
    }
    const data = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : null;
    if (p.mimeType === "text/plain" && data !== null && plain === null) plain = data;
    else if (p.mimeType === "text/html" && data !== null && html === null) html = data;
    for (const c of p.parts ?? []) walk(c);
  };
  walk(m.payload);
  const labels = labelsOf(m);
  const text = normBody(plain ?? (html !== null ? htmlToText(html) : ""));
  return {
    id: m.id ?? "",
    threadId: m.threadId ?? "",
    from: headerOf(m, "from"),
    to: headerOf(m, "to"),
    cc: headerOf(m, "cc"),
    date: headerOf(m, "date"),
    subject: headerOf(m, "subject"),
    ...truncateBody(text, maxBody),
    attachments,
    unread: labels.includes("UNREAD"),
    labels,
  };
}

/** A Gmail search query: text, bounded, no control character. Empty = the most recent mail. */
export function searchQueryVerdict(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" || CONTROL.test(v) || v.length > 500) throw new GoogleInputError("The search query must be one line of at most 500 characters (Gmail search syntax).");
  return v.trim();
}

export async function searchGmail(
  token: string,
  o: { query?: unknown; max?: unknown; pageToken?: unknown },
  fetchFn: FetchFn,
): Promise<{ messages: MailListItem[]; nextPageToken?: string; query: string }> {
  const query = searchQueryVerdict(o.query);
  const max = Math.min(Math.max(Math.trunc(typeof o.max === "number" ? o.max : SEARCH_DEFAULT) || SEARCH_DEFAULT, 1), SEARCH_MAX);
  const q = new URLSearchParams({ maxResults: String(max) });
  if (query) q.set("q", query);
  if (o.pageToken !== undefined && o.pageToken !== null && o.pageToken !== "") {
    if (typeof o.pageToken !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(o.pageToken)) throw new GoogleInputError("That is not a valid page token.");
    q.set("pageToken", o.pageToken);
  }
  const list = await getJson<{ messages?: { id?: string }[]; nextPageToken?: string }>("mail search", `${GMAIL}/messages?${q}`, token, fetchFn);
  const ids = (list.messages ?? []).map((m) => m.id ?? "").filter(Boolean).slice(0, max);
  const meta = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
  const messages: MailListItem[] = [];
  // Ten at a time: enough to be quick, few enough not to trip Gmail's per-user rate.
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(ids.slice(i, i + 10).map((id) => getJson<GmailMessage>("mail lookup", `${GMAIL}/messages/${pathId("message", id)}?${meta}`, token, fetchFn)));
    messages.push(...batch.map(mailListItem));
  }
  return { messages, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}), query };
}

/** One message, or a whole thread (oldest first, cut to its most recent messages). */
export async function readGmail(
  token: string,
  o: { id?: unknown; threadId?: unknown },
  fetchFn: FetchFn,
): Promise<{ messages: MailMessageView[]; omitted: number }> {
  if (typeof o.threadId === "string" && o.threadId) {
    const t = await getJson<{ messages?: GmailMessage[] }>("thread read", `${GMAIL}/threads/${pathId("thread", o.threadId)}?format=full`, token, fetchFn);
    const all = t.messages ?? [];
    const kept = all.slice(-MAX_THREAD_MESSAGES);
    return { messages: kept.map((m) => mailMessageView(m)), omitted: all.length - kept.length };
  }
  if (typeof o.id !== "string" || !o.id) throw new GoogleInputError("Give a message id (--id) or a thread id (--thread).");
  const m = await getJson<GmailMessage>("mail read", `${GMAIL}/messages/${pathId("message", o.id)}?format=full`, token, fetchFn);
  return { messages: [mailMessageView(m)], omitted: 0 };
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
  /** One of `EVENT_COLORS` (an event's own colour), or `"default"` — no colour
   *  of its own, so Google paints it in its calendar's colour. */
  color?: string;
}

export interface EventView extends EventFields {
  id: string;
  allDay: boolean;
  link?: string;
}

/**
 * Google Calendar's event palette: `colorId` "1"…"11", named as Google's own
 * UI names them. The API speaks only in numbers; an agent (and the person it
 * answers) speaks in colours, so the numbers never leave this module.
 */
export const EVENT_COLORS = ["Lavender", "Sage", "Grape", "Flamingo", "Banana", "Tangerine", "Peacock", "Graphite", "Blueberry", "Basil", "Tomato"] as const;

/** The colour name for a `colorId`; undefined when absent or unknown. */
export function eventColorName(colorId: unknown): string | undefined {
  const n = typeof colorId === "string" && /^\d{1,2}$/.test(colorId) ? Number(colorId) : NaN;
  return EVENT_COLORS[n - 1];
}

/** A colour as written by an agent — a name (any case) or its number — to
 *  the canonical name, or `"default"`. Throws `GoogleInputError`. */
function eventColorVerdict(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" ? String(v) : "";
  if (s === "default" || s === "none") return "default";
  const byNumber = eventColorName(s);
  const name = byNumber ?? EVENT_COLORS.find((c) => c.toLowerCase() === s);
  if (!name) throw new GoogleInputError(`'${String(v).slice(0, 40)}' is not an event colour (use ${EVENT_COLORS.join(", ")}, or default).`);
  return name;
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
  if (raw.color !== undefined && raw.color !== null) out.color = eventColorVerdict(raw.color);
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
  // `null` in a PATCH clears the field: the event goes back to its calendar's
  // colour. On a create, "default" is simply no colour.
  if (f.color !== undefined) {
    const id = EVENT_COLORS.indexOf(f.color as (typeof EVENT_COLORS)[number]) + 1;
    b.colorId = id > 0 ? String(id) : null;
  }
  return b;
}

interface GEvent {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  colorId?: string;
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
    color: eventColorName(e.colorId) ?? "default",
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

// ---- Drive, Docs, Sheets ---------------------------------------------------
// With `drive.file` Google itself shows only the files the cockpit created.
// With the whole-Drive scope (`drive_all`) every call below reaches ANY file,
// so "is this one of ours" is decided by the caller (src/google-actions.ts),
// never assumed here.

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

export function appendTextVerdict(text: unknown): string {
  if (typeof text !== "string" || !text) throw new GoogleInputError("There is no text to append.");
  return text;
}

/** `outbound`: the edit lands in a file other people may see — an unanswered
 *  request is then "check before retrying", never "it failed". */
export async function appendDoc(token: string, id: string, text: unknown, fetchFn: FetchFn, outbound = false): Promise<void> {
  const t = appendTextVerdict(text);
  await sendJson("document update", "POST", `${DOCS}/${pathId("document", id)}:batchUpdate`, token, { requests: [{ insertText: { text: t, endOfSegmentLocation: {} } }] }, fetchFn, outbound);
}

export async function createSheet(token: string, title: unknown, fetchFn: FetchFn): Promise<{ id: string; name: string; link: string }> {
  const name = titleOk(title);
  const j = await sendJson<{ spreadsheetId?: string }>("spreadsheet creation", "POST", SHEETS, token, { properties: { title: name } }, fetchFn);
  if (!j.spreadsheetId) throw new GoogleError("Google created the spreadsheet but returned no id.", 502, false);
  return { id: j.spreadsheetId, name, link: `https://docs.google.com/spreadsheets/d/${j.spreadsheetId}/edit` };
}

export function rangeOk(v: unknown): string {
  if (v === undefined || v === null || v === "") return "A1:Z1000";
  if (typeof v !== "string" || CONTROL.test(v) || v.length > 200) throw new GoogleInputError("That is not a valid range (use A1 notation, e.g. Sheet1!A1:D20).");
  return v;
}

/** `formulas`: a formula cell reads as its formula (\`=SUM(B2:B9)\`), not its
 *  computed value — Sheets' \`valueRenderOption=FORMULA\`. */
export async function readSheet(token: string, id: string, range: unknown, fetchFn: FetchFn, formulas = false): Promise<{ id: string; range: string; rows: unknown[][] }> {
  const url = `${SHEETS}/${pathId("spreadsheet", id)}/values/${encodeURIComponent(rangeOk(range))}${formulas ? "?valueRenderOption=FORMULA" : ""}`;
  const j = await getJson<{ range?: string; values?: unknown[][] }>("spreadsheet read", url, token, fetchFn);
  return { id, range: j.range ?? "", rows: j.values ?? [] };
}

/** \`--formulas\`: true, or absent. Anything else is refused, not guessed. */
export function formulasFlag(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  throw new GoogleInputError("'formulas' must be true or false.");
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

export async function appendSheet(token: string, id: string, range: unknown, rows: unknown, fetchFn: FetchFn, outbound = false): Promise<{ updatedRange: string }> {
  const values = rowsVerdict(rows);
  const url = `${SHEETS}/${pathId("spreadsheet", id)}/values/${encodeURIComponent(rangeOk(range))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const j = await sendJson<{ updates?: { updatedRange?: string } }>("spreadsheet append", "POST", url, token, { values }, fetchFn, outbound);
  return { updatedRange: j.updates?.updatedRange ?? "" };
}

/** Overwrite a range with rows (RAW, like an append). The range is required:
 *  an overwrite never lands on a default. */
export function updateRangeVerdict(range: unknown): string {
  if (typeof range !== "string" || !range) throw new GoogleInputError("A range is required to overwrite cells (A1 notation, e.g. Sheet1!A2:C2).");
  return rangeOk(range);
}

export async function updateSheet(token: string, id: string, range: unknown, rows: unknown, fetchFn: FetchFn, outbound = false): Promise<{ updatedRange: string }> {
  const values = rowsVerdict(rows);
  updateRangeVerdict(range);
  const url = `${SHEETS}/${pathId("spreadsheet", id)}/values/${encodeURIComponent(rangeOk(range))}?valueInputOption=RAW`;
  const j = await sendJson<{ updatedRange?: string }>("spreadsheet update", "PUT", url, token, { values }, fetchFn, outbound);
  return { updatedRange: j.updatedRange ?? "" };
}

// ---- the whole Drive (the `drive_all` area) -------------------------------

const DRIVE = "https://www.googleapis.com/drive/v3/files";
export const MIME_DOC = "application/vnd.google-apps.document";
export const MIME_SHEET = "application/vnd.google-apps.spreadsheet";
export const MIME_SLIDES = "application/vnd.google-apps.presentation";
export const MIME_FOLDER = "application/vnd.google-apps.folder";
/** A file's text, as handed to an agent, is cut here. */
export const MAX_FILE_CHARS = 50_000;
/** A plain-text file larger than this is not fetched at all. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  owners: string[];
  link?: string;
  size?: number;
  /** The folder it sits in; absent for a file merely shared with the account. */
  parentId?: string;
}

interface GFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string | number;
  trashed?: boolean;
  parents?: string[];
  owners?: { displayName?: string; emailAddress?: string }[];
}
const FILE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,size,trashed,parents,owners(displayName,emailAddress)";

export function driveFileMeta(f: GFile): DriveFileMeta {
  const size = Number(f.size);
  return {
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}),
    owners: (f.owners ?? []).map((o) => o.emailAddress || o.displayName || "").filter(Boolean),
    ...(f.webViewLink ? { link: f.webViewLink } : {}),
    ...(Number.isFinite(size) && f.size !== undefined ? { size } : {}),
    ...(typeof f.parents?.[0] === "string" && f.parents[0] ? { parentId: f.parents[0] } : {}),
  };
}

/** One file's metadata; null when it is not there (deleted, in the bin, or
 *  not reachable by this account). */
export async function getFileMeta(token: string, id: unknown, fetchFn: FetchFn): Promise<DriveFileMeta | null> {
  const url = `${DRIVE}/${pathId("file", id)}?${new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" })}`;
  const res = await fetchFn(url, { headers: bearer(token), signal: deadline() });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure("file lookup", res);
  const f = (await res.json()) as GFile;
  return f.trashed ? null : driveFileMeta(f);
}

const Q_SYNTAX =
  /\b(name|fullText|mimeType|modifiedTime|createdTime|viewedByMeTime|sharedWithMe|starred|trashed|visibility)\s*(=|!=|<=|>=|<|>|contains\b)|'[^']*'\s+in\s+(parents|owners|writers|readers)\b|^\s*(not\s+)?sharedWithMe\s*$/;

/**
 * What goes into Drive's `q`. Text that already reads as Drive's query
 * language (`name contains 'x'`, `mimeType = '…'`, `'<id>' in parents`) is
 * passed as it is; anything else is a full-text search for those words. Files
 * in the bin are left out unless the query speaks of `trashed` itself. Empty =
 * the most recently changed files.
 */
export function driveQuery(v: unknown): { q: string; fullText: boolean; query: string } {
  if (v !== undefined && v !== null && (typeof v !== "string" || CONTROL.test(v) || v.length > 500)) {
    throw new GoogleInputError("The search query must be one line of at most 500 characters.");
  }
  const query = typeof v === "string" ? v.trim() : "";
  if (!query) return { q: "trashed = false", fullText: false, query };
  if (Q_SYNTAX.test(query)) {
    // Judged on the query WITHOUT its quoted strings: a word inside a literal
    // (`name contains 'trashed'`) is not the operator, and a parenthesis
    // inside one does not count.
    const bare = query.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    let depth = 0;
    for (const ch of bare) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) break;
    }
    // Unbalanced, the wrapping below would not hold the bin filter on the whole query.
    if (depth !== 0 || bare.replace(/''/g, "").includes("'")) throw new GoogleInputError("That Drive query has an unbalanced parenthesis or quote.");
    return { q: /\btrashed\b/.test(bare) ? query : `(${query}) and trashed = false`, fullText: /\bfullText\b/.test(bare), query };
  }
  const quoted = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return { q: `fullText contains '${quoted}' and trashed = false`, fullText: true, query };
}

/** Search the WHOLE Drive: the person's own files and those shared with them. */
export async function searchDrive(
  token: string,
  o: { query?: unknown; max?: unknown; pageToken?: unknown },
  fetchFn: FetchFn,
): Promise<{ files: DriveFileMeta[]; nextPageToken?: string; query: string }> {
  const { q, fullText, query } = driveQuery(o.query);
  const max = Math.min(Math.max(Math.trunc(typeof o.max === "number" ? o.max : SEARCH_DEFAULT) || SEARCH_DEFAULT, 1), SEARCH_MAX);
  const p = new URLSearchParams({
    q,
    pageSize: String(max),
    corpora: "user",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    fields: `nextPageToken,files(${FILE_FIELDS})`,
  });
  // Drive refuses an explicit order on a full-text query (it ranks by relevance).
  if (!fullText) p.set("orderBy", "modifiedTime desc");
  if (o.pageToken !== undefined && o.pageToken !== null && o.pageToken !== "") {
    if (typeof o.pageToken !== "string" || !/^[A-Za-z0-9_~.=+/-]{1,2048}$/.test(o.pageToken)) throw new GoogleInputError("That is not a valid page token.");
    p.set("pageToken", o.pageToken);
  }
  const j = await getJson<{ files?: GFile[]; nextPageToken?: string }>("Drive search", `${DRIVE}?${p}`, token, fetchFn);
  return { files: (j.files ?? []).slice(0, max).map(driveFileMeta), ...(j.nextPageToken ? { nextPageToken: j.nextPageToken } : {}), query };
}

async function getText(what: string, url: string, token: string, fetchFn: FetchFn): Promise<string> {
  const res = await fetchFn(url, { headers: bearer(token), signal: deadline() });
  if (!res.ok) throw await failure(what, res);
  return (await res.text()).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql|x-ndjson)$)/;

/** Rows cut so that what an agent receives stays under `max` characters. */
export function truncateRows(rows: unknown[][], max = MAX_FILE_CHARS): { rows: unknown[][]; truncated: boolean; omitted: number } {
  let used = 0;
  const kept: unknown[][] = [];
  for (const r of rows) {
    used += JSON.stringify(r).length;
    if (used > max && kept.length) break;
    kept.push(r);
  }
  return { rows: kept, truncated: kept.length < rows.length, omitted: rows.length - kept.length };
}

export interface DriveReadResult {
  file: DriveFileMeta;
  /** `text`: `text` holds it. `rows`: a spreadsheet's values. `none`: nothing readable — `note` says why. */
  kind: "text" | "rows" | "none";
  text?: string;
  rows?: unknown[][];
  range?: string;
  truncated: boolean;
  note?: string;
}

/**
 * Read ANY file of the Drive as text: a Doc or a Slides deck through Drive's
 * plain-text export, a Sheet through its values, a small text file as it is.
 * A PDF or any other binary gives its metadata and a sentence — nothing here
 * downloads or parses a binary. Null when the file is not there.
 */
export async function readDriveFile(token: string, o: { id?: unknown; range?: unknown; formulas?: boolean }, fetchFn: FetchFn): Promise<DriveReadResult | null> {
  const file = await getFileMeta(token, o.id, fetchFn);
  if (!file) return null;
  const none = (note: string): DriveReadResult => ({ file, kind: "none", truncated: false, note });
  const mt = file.mimeType;
  if (mt === MIME_SHEET) {
    const s = await readSheet(token, file.id, o.range, fetchFn, o.formulas === true);
    const cut = truncateRows(s.rows);
    return { file, kind: "rows", rows: cut.rows, range: s.range, truncated: cut.truncated, ...(cut.truncated ? { note: `${cut.omitted} more rows not shown — read a narrower --range.` } : {}) };
  }
  if (mt === MIME_DOC || mt === MIME_SLIDES) {
    const raw = await getText("file export", `${DRIVE}/${file.id}/export?mimeType=${encodeURIComponent("text/plain")}`, token, fetchFn);
    const cut = truncateBody(raw.replace(/\s+$/, ""), MAX_FILE_CHARS);
    return { file, kind: "text", text: cut.body, truncated: cut.truncated };
  }
  if (mt === MIME_FOLDER) return none(`This is a folder. List what it holds with: drive search --query "'${file.id}' in parents"`);
  if (mt === "application/pdf") return none("This is a PDF: Drive has no text export for it, and files are not downloaded — only its details are shown.");
  if (mt.startsWith("application/vnd.google-apps.")) return none("This kind of Google file has no text export — only its details are shown.");
  if (TEXT_MIME.test(mt)) {
    if (file.size === undefined || file.size > MAX_TEXT_FILE_BYTES) return none(`This text file is too large to read here (over ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB) — only its details are shown.`);
    const raw = await getText("file read", `${DRIVE}/${file.id}?alt=media&supportsAllDrives=true`, token, fetchFn);
    const cut = truncateBody(raw.replace(/\s+$/, ""), MAX_FILE_CHARS);
    return { file, kind: "text", text: cut.body, truncated: cut.truncated };
  }
  return none("This is a binary file: files are not downloaded — only its details are shown.");
}

// ---- bin, move, rename (never a permanent delete, never a share) ----------

const fileUrl = (id: string, extra: Record<string, string> = {}) => `${DRIVE}/${pathId("file", id)}?${new URLSearchParams({ supportsAllDrives: "true", fields: "id", ...extra })}`;

/** To the BIN — `trashed: true`, which the person can undo for about 30 days.
 *  `files.delete` (permanent) and emptying the bin are not called anywhere. */
export async function trashFile(token: string, id: string, fetchFn: FetchFn): Promise<void> {
  await sendJson("file removal", "PATCH", fileUrl(id), token, { trashed: true }, fetchFn, true);
}

export function fileNameVerdict(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new GoogleInputError("A new name is required.");
  if (CONTROL.test(v) || [...v].length > 300) throw new GoogleInputError("The new name is too long or contains a line break.");
  return v.trim();
}

export async function renameFile(token: string, id: string, name: string, fetchFn: FetchFn): Promise<void> {
  await sendJson("file rename", "PATCH", fileUrl(id), token, { name: fileNameVerdict(name) }, fetchFn, true);
}

/** A copy of the file (`files.copy`): a Doc, Sheet or Slides deck keeps its
 *  whole look (fonts, colours, margins, headers, images); any other file is
 *  copied byte for byte. `name` absent = Google's "Copy of …"; `parentId`
 *  absent = Google puts it beside the original. Sharing is NOT copied: the
 *  copy has the destination folder's access, as Drive's own "Make a copy". */
export async function copyFile(token: string, id: string, name: string | undefined, parentId: string | undefined, fetchFn: FetchFn): Promise<DriveFileMeta & { private: boolean }> {
  const body = { ...(name ? { name: fileNameVerdict(name) } : {}), ...(parentId ? { parents: [pathId("folder", parentId)] } : {}) };
  const url = `${DRIVE}/${pathId("file", id)}/copy?${new URLSearchParams({ supportsAllDrives: "true", fields: `${FILE_FIELDS},permissionIds` })}`;
  const f = await sendJson<GFile & { permissionIds?: unknown }>("file copy", "POST", url, token, body, fetchFn, true);
  return { ...driveFileMeta(f), private: copyIsPrivate(f.permissionIds) };
}

/** Is a fresh copy reachable by its owner ONLY? Its `permissionIds` include
 *  the ones it inherits from its folder (a shared folder, a shared drive), so
 *  exactly one entry is the owner alone. Anything else — more entries, or no
 *  list at all — counts as shared: the safe reading. */
export function copyIsPrivate(permissionIds: unknown): boolean {
  return Array.isArray(permissionIds) && permissionIds.length === 1;
}

/** Into another folder: one parent added, the current one (if any) removed. */
export async function moveFile(token: string, id: string, from: string | undefined, to: string, fetchFn: FetchFn): Promise<void> {
  const extra = { addParents: pathId("folder", to), ...(from ? { removeParents: pathId("folder", from) } : {}) };
  await sendJson("file move", "PATCH", fileUrl(id, extra), token, {}, fetchFn, true);
}

// ---- upload, folders, comments, access, restore -----------------------------

/** A Drive id given by an agent, checked before any token is fetched. */
export const fileIdVerdict = (v: unknown, what = "file"): string => pathId(what, v);

/** `--to`: absent or `root` = the top of the person's Drive (no lookup, no
 *  `parents`: Drive puts it there); anything else is a folder id. */
export function folderTargetVerdict(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "" || v === "root") return undefined;
  return pathId("folder", v);
}

const ACCESS_FIELDS = `${FILE_FIELDS},permissionIds`;

export interface DriveFileState extends DriveFileMeta {
  trashed: boolean;
  /** Reachable by its owner alone (`copyIsPrivate`). */
  private: boolean;
}

/** A file's metadata — the bin INCLUDED, unlike `getFileMeta` — and whether
 *  anyone but its owner can reach it. Null when not reachable at all. */
export async function getFileState(token: string, id: unknown, fetchFn: FetchFn): Promise<DriveFileState | null> {
  const url = `${DRIVE}/${pathId("file", id)}?${new URLSearchParams({ fields: ACCESS_FIELDS, supportsAllDrives: "true" })}`;
  const res = await fetchFn(url, { headers: bearer(token), signal: deadline() });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure("file lookup", res);
  const f = (await res.json()) as GFile & { permissionIds?: unknown };
  return { ...driveFileMeta(f), trashed: f.trashed === true, private: copyIsPrivate(f.permissionIds) };
}

const createdState = (f: GFile & { permissionIds?: unknown }): DriveFileMeta & { private: boolean } => ({ ...driveFileMeta(f), private: copyIsPrivate(f.permissionIds) });

/** A new, empty folder (`files.create` with the folder MIME type). */
export async function createFolder(token: string, name: string, parentId: string | undefined, fetchFn: FetchFn): Promise<DriveFileMeta & { private: boolean }> {
  const body = { name: fileNameVerdict(name), mimeType: MIME_FOLDER, ...(parentId ? { parents: [pathId("folder", parentId)] } : {}) };
  const url = `${DRIVE}?${new URLSearchParams({ supportsAllDrives: "true", fields: ACCESS_FIELDS })}`;
  const f = await sendJson<GFile & { permissionIds?: unknown }>("folder creation", "POST", url, token, body, fetchFn, true);
  if (!f.id) throw new GoogleError("Google created the folder but returned no id.", 502, false);
  return createdState(f);
}

/** Out of the BIN — the undo of `trashFile`. It goes back where it was. */
export async function restoreFile(token: string, id: string, fetchFn: FetchFn): Promise<void> {
  await sendJson("file restore", "PATCH", fileUrl(id), token, { trashed: false }, fetchFn, true);
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const UPLOAD_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const extOf = (name: string) => (/\.[^./\\]+$/.exec(name)?.[0] ?? "").toLowerCase();

/** A local file's MIME type, from its extension — what Drive is told it is. */
export function uploadMime(name: string): string {
  return UPLOAD_MIME[extOf(name)] ?? "application/octet-stream";
}

/** What `--convert` turns a file into, and from which source types Drive
 *  imports it (Drive's `about.importFormats`, checked 2026-11-18). */
const CONVERT = {
  doc: { mime: MIME_DOC, from: [".docx", ".doc", ".odt", ".rtf", ".txt", ".html", ".htm", ".md"] },
  sheet: { mime: MIME_SHEET, from: [".xlsx", ".xls", ".ods", ".csv", ".tsv"] },
  slides: { mime: MIME_SLIDES, from: [".pptx", ".ppt", ".odp"] },
} as const;
export type ConvertTarget = keyof typeof CONVERT;

/** `--convert doc|sheet|slides`, checked against the file's own type. */
export function convertVerdict(v: unknown, fileName: string): ConvertTarget | undefined {
  if (v === undefined || v === null || v === "" || v === false) return undefined;
  if (typeof v !== "string" || !Object.hasOwn(CONVERT, v)) throw new GoogleInputError("--convert must be doc, sheet or slides.");
  const target = v as ConvertTarget;
  const ext = extOf(fileName);
  if (!(CONVERT[target].from as readonly string[]).includes(ext)) {
    throw new GoogleInputError(`A '${ext || "(no extension)"}' file cannot become a Google ${target === "doc" ? "Doc" : target === "sheet" ? "Sheet" : "Slides deck"} — it takes ${CONVERT[target].from.join(", ")}.`);
  }
  return target;
}

const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * A local file into Drive, as a RESUMABLE upload sent in one piece (Drive API
 * "Upload file data" → resumable): the metadata opens a session, whose URI
 * comes back in `Location`; the bytes then go to that URI in a single PUT.
 * The session URI is the upload's own credential, so the token is not sent
 * there — and the URI must be Drive's upload endpoint before anything is.
 * `convertTo` makes Drive import it as a Google file. Opening the session
 * creates nothing; a PUT that gets no answer may have created the file.
 */
export async function uploadFile(
  token: string,
  o: { name: string; bytes: Buffer; mime: string; convertTo?: ConvertTarget; parentId?: string },
  fetchFn: FetchFn,
): Promise<DriveFileMeta & { private: boolean }> {
  if (o.bytes.length > MAX_UPLOAD_BYTES) throw new GoogleInputError(`That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB — too large to upload here.`);
  const meta = {
    name: fileNameVerdict(o.name),
    ...(o.convertTo ? { mimeType: CONVERT[o.convertTo].mime } : {}),
    ...(o.parentId ? { parents: [pathId("folder", o.parentId)] } : {}),
  };
  const url = `${UPLOAD}?${new URLSearchParams({ uploadType: "resumable", supportsAllDrives: "true", fields: ACCESS_FIELDS })}`;
  const open = await fetchFn(url, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": o.mime, "X-Upload-Content-Length": String(o.bytes.length) },
    body: JSON.stringify(meta),
    signal: deadline(),
  });
  if (!open.ok) throw await failure("upload", open);
  let session: URL;
  try {
    session = new URL(open.headers.get("location") ?? "");
  } catch {
    throw new GoogleError("Google opened the upload but gave no place to send the file.", 502, false);
  }
  if (session.protocol !== "https:" || session.hostname !== "www.googleapis.com" || !session.pathname.startsWith("/upload/drive/v3/files")) {
    throw new GoogleError("Google answered the upload with an unexpected address — nothing was sent.", 502, false);
  }
  let res: Response;
  try {
    res = await fetchFn(session.toString(), { method: "PUT", headers: { "Content-Type": o.mime }, body: new Uint8Array(o.bytes), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  } catch {
    throw new GoogleOutcomeUnknownError();
  }
  if (!res.ok) throw await failure("upload", res);
  const f = (await res.json().catch(() => ({}))) as GFile & { permissionIds?: unknown };
  if (!f.id) throw new GoogleError("Google took the file but returned no id.", 502, false);
  return createdState(f);
}

// Comments: the Drive API's `comments` and `replies` resources. Both REQUIRE
// a `fields` parameter (Drive API v3, comments.list / replies.create).

export interface DriveCommentReply {
  id: string;
  author: string;
  created: string;
  text: string;
  /** `resolve` / `reopen` when the reply changed the comment's state. */
  action?: string;
}
export interface DriveComment {
  id: string;
  author: string;
  created: string;
  modified?: string;
  resolved: boolean;
  /** The passage of the file the comment is anchored to. */
  quoted?: string;
  text: string;
  replies: DriveCommentReply[];
}

interface GUser {
  displayName?: string;
  emailAddress?: string;
}
interface GReply {
  id?: string;
  content?: string;
  createdTime?: string;
  action?: string;
  deleted?: boolean;
  author?: GUser;
}
interface GComment extends GReply {
  modifiedTime?: string;
  resolved?: boolean;
  quotedFileContent?: { value?: string };
  replies?: GReply[];
}

const who = (u: GUser | undefined) => (u?.displayName && u.emailAddress ? `${u.displayName} <${u.emailAddress}>` : u?.emailAddress || u?.displayName || "unknown");
const COMMENT_FIELDS = "id,content,createdTime,modifiedTime,resolved,deleted,author(displayName,emailAddress),quotedFileContent(value)";
const REPLY_FIELDS = "id,content,createdTime,action,deleted,author(displayName,emailAddress)";

export function driveComment(c: GComment): DriveComment {
  return {
    id: c.id ?? "",
    author: who(c.author),
    created: c.createdTime ?? "",
    ...(c.modifiedTime && c.modifiedTime !== c.createdTime ? { modified: c.modifiedTime } : {}),
    resolved: c.resolved === true,
    ...(c.quotedFileContent?.value ? { quoted: c.quotedFileContent.value } : {}),
    text: c.content ?? "",
    replies: (c.replies ?? []).filter((r) => !r.deleted).map((r) => ({ id: r.id ?? "", author: who(r.author), created: r.createdTime ?? "", text: r.content ?? "", ...(r.action ? { action: r.action } : {}) })),
  };
}

/** A file's comments and their replies, oldest first, cut once the text
 *  passes `MAX_FILE_CHARS`. Deleted ones are left out. */
export async function listComments(token: string, id: string, o: { pageToken?: unknown }, fetchFn: FetchFn): Promise<{ comments: DriveComment[]; truncated: boolean; nextPageToken?: string }> {
  const p = new URLSearchParams({ pageSize: "100", includeDeleted: "false", fields: `nextPageToken,comments(${COMMENT_FIELDS},replies(${REPLY_FIELDS}))` });
  if (o.pageToken !== undefined && o.pageToken !== null && o.pageToken !== "") {
    if (typeof o.pageToken !== "string" || !/^[A-Za-z0-9_~.=+/-]{1,2048}$/.test(o.pageToken)) throw new GoogleInputError("That is not a valid page token.");
    p.set("pageToken", o.pageToken);
  }
  const j = await getJson<{ comments?: GComment[]; nextPageToken?: string }>("comment listing", `${DRIVE}/${pathId("file", id)}/comments?${p}`, token, fetchFn);
  const all = (j.comments ?? []).filter((c) => !c.deleted).map(driveComment);
  let used = 0;
  const kept: DriveComment[] = [];
  for (const c of all) {
    used += c.text.length + (c.quoted?.length ?? 0) + c.replies.reduce((n, r) => n + r.text.length, 0);
    if (used > MAX_FILE_CHARS && kept.length) break;
    kept.push(c);
  }
  return { comments: kept, truncated: kept.length < all.length, ...(j.nextPageToken ? { nextPageToken: j.nextPageToken } : {}) };
}

/** One comment, replies left out; null when it is not there or was deleted. */
export async function getComment(token: string, fileId: string, commentId: string, fetchFn: FetchFn): Promise<DriveComment | null> {
  const url = `${DRIVE}/${pathId("file", fileId)}/comments/${pathId("comment", commentId)}?${new URLSearchParams({ fields: COMMENT_FIELDS })}`;
  const res = await fetchFn(url, { headers: bearer(token), signal: deadline() });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure("comment lookup", res);
  const c = (await res.json()) as GComment;
  return c.deleted ? null : driveComment({ ...c, replies: [] });
}

export const MAX_REPLY_CHARS = 4000;

/** A reply's text: required unless the reply only resolves the comment. */
export function replyTextVerdict(v: unknown, resolve: boolean): string | undefined {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (resolve) return undefined;
    throw new GoogleInputError("The reply is empty — write it on stdin, or pass --resolve to only resolve the comment.");
  }
  if (typeof v !== "string") throw new GoogleInputError("The reply must be text.");
  if ([...v].length > MAX_REPLY_CHARS) throw new GoogleInputError(`The reply is over ${MAX_REPLY_CHARS} characters.`);
  return v.replace(/\s+$/, "");
}

/** `replies.create`: `content`, and `action: "resolve"` to resolve the comment
 *  (Drive takes a reply with an action and no content). */
export async function replyToComment(token: string, fileId: string, commentId: string, o: { text?: string; resolve?: boolean }, fetchFn: FetchFn): Promise<{ id: string }> {
  const url = `${DRIVE}/${pathId("file", fileId)}/comments/${pathId("comment", commentId)}/replies?${new URLSearchParams({ fields: "id" })}`;
  const body = { ...(o.text ? { content: o.text } : {}), ...(o.resolve ? { action: "resolve" } : {}) };
  const j = await sendJson<{ id?: string }>("comment reply", "POST", url, token, body, fetchFn, true);
  return { id: j.id ?? "" };
}

export interface DriveAccess {
  /** user / group / domain / anyone */
  type: string;
  /** owner / organizer / fileOrganizer / writer / commenter / reader */
  role: string;
  who: string;
  pendingOwner?: boolean;
  expires?: string;
}

/** Who can reach a file (`permissions.list`) — READ only: nothing here, or
 *  anywhere in the cockpit, changes a permission. */
export async function listAccess(token: string, id: string, fetchFn: FetchFn): Promise<{ access: DriveAccess[]; truncated: boolean }> {
  const access: DriveAccess[] = [];
  let page: string | undefined;
  for (let i = 0; i < 5; i++) {
    const p = new URLSearchParams({ supportsAllDrives: "true", pageSize: "100", fields: "nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted,pendingOwner,expirationTime)" });
    if (page) p.set("pageToken", page);
    const j = await getJson<{ permissions?: { type?: string; role?: string; emailAddress?: string; domain?: string; displayName?: string; deleted?: boolean; pendingOwner?: boolean; expirationTime?: string }[]; nextPageToken?: string }>(
      "access listing",
      `${DRIVE}/${pathId("file", id)}/permissions?${p}`,
      token,
      fetchFn,
    );
    for (const x of j.permissions ?? []) {
      const name = x.type === "anyone" ? "anyone with the link" : x.type === "domain" ? `everyone at ${x.domain ?? "?"}` : who(x);
      access.push({ type: x.type ?? "", role: x.role ?? "", who: x.deleted ? `${name} (deleted account)` : name, ...(x.pendingOwner ? { pendingOwner: true } : {}), ...(x.expirationTime ? { expires: x.expirationTime } : {}) });
    }
    page = j.nextPageToken;
    if (!page) return { access, truncated: false };
  }
  return { access, truncated: true };
}

// ---- download ---------------------------------------------------------------

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 80_000;

const OFFICE = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  csv: "text/csv",
} as const;
/** What a Google-native file can be exported as; the first is the default. */
const EXPORTS: Record<string, (keyof typeof OFFICE)[]> = {
  [MIME_DOC]: ["docx", "pdf"],
  [MIME_SHEET]: ["xlsx", "csv"],
  [MIME_SLIDES]: ["pptx", "pdf"],
};

/** How a file is fetched: an export (Google-native) or its own bytes. Refused
 *  before any byte moves: a folder, a native type with no export, a format
 *  that does not apply, a file known to be over the cap. */
export function downloadPlan(file: Pick<DriveFileMeta, "mimeType" | "size">, format: unknown): { exportMime?: string; ext?: string } {
  if (format !== undefined && format !== null && typeof format !== "string") throw new GoogleInputError("--format must be a word (docx, pdf, xlsx, csv, pptx).");
  const fmt = typeof format === "string" && format ? format.toLowerCase() : undefined;
  const choices = EXPORTS[file.mimeType];
  if (choices) {
    const pick = (fmt ?? choices[0]) as keyof typeof OFFICE;
    if (!choices.includes(pick)) throw new GoogleInputError(`This file can be downloaded as ${choices.join(" or ")}, not '${String(fmt).slice(0, 20)}'.`);
    return { exportMime: OFFICE[pick], ext: pick };
  }
  if (file.mimeType === MIME_FOLDER) throw new GoogleInputError("A folder cannot be downloaded — download its files one by one.");
  if (file.mimeType.startsWith("application/vnd.google-apps.")) throw new GoogleInputError("This kind of Google file cannot be downloaded.");
  if (fmt) throw new GoogleInputError("--format applies to Google Docs, Sheets and Slides only; any other file is downloaded as it is.");
  if (file.size !== undefined && file.size > MAX_DOWNLOAD_BYTES) throw new GoogleInputError(`That file is over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB — too large to download here.`);
  return {};
}

/**
 * A Drive file's name as a LOCAL file name. The name is whatever someone
 * typed: it becomes a single path segment of letters, digits, spaces and
 * `._()-` — no separator, no leading dot, no control character — so it can
 * never leave the directory it is written to. `ext` (an export) is appended
 * unless the name already ends with it.
 */
export function downloadFileName(name: string, ext?: string): string {
  let n = name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._()-]+/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[ ._-]+/, "")
    .trim();
  n = [...n].slice(0, 120).join("").replace(/[ .]+$/, "");
  if (!n) n = "file";
  if (ext && !n.toLowerCase().endsWith(`.${ext}`)) n = `${n}.${ext}`;
  return n;
}

/** The body, refused the moment it passes the cap — never buffered beyond it. */
export async function cappedBytes(res: Response, cap: number, over = () => new GoogleInputError(`That file is over ${cap / 1024 / 1024} MB — too large to download here.`)): Promise<Buffer> {
  if (Number(res.headers.get("content-length")) > cap) throw over();
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw over();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** A file's bytes — exported for a Google-native file, as they are otherwise.
 *  Null when the file is not there. */
export async function downloadDriveFile(
  token: string,
  o: { id?: unknown; format?: unknown },
  fetchFn: FetchFn,
  cap = MAX_DOWNLOAD_BYTES,
): Promise<{ file: DriveFileMeta; bytes: Buffer; fileName: string; format: string } | null> {
  const file = await getFileMeta(token, o.id, fetchFn);
  if (!file) return null;
  const plan = downloadPlan(file, o.format);
  const url = plan.exportMime
    ? `${DRIVE}/${file.id}/export?mimeType=${encodeURIComponent(plan.exportMime)}`
    : `${DRIVE}/${file.id}?alt=media&supportsAllDrives=true`;
  const res = await fetchFn(url, { headers: bearer(token), signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw await failure("file download", res);
  const bytes = await cappedBytes(res, cap);
  return { file, bytes, fileName: downloadFileName(file.name, plan.ext), format: plan.ext ?? "as it is" };
}

// ---- editing content: Slides, Docs, Sheets (src/google-edits.ts) ----------
// No scope of their own: the Slides, Docs and Sheets APIs all accept `drive`
// and `drive.file` for the files those reach (each method's "Authorization
// scopes", checked 2026-11-13).

const SLIDES = "https://slides.googleapis.com/v1/presentations";

export async function createPresentation(token: string, title: unknown, fetchFn: FetchFn): Promise<{ id: string; name: string; link: string }> {
  const name = titleOk(title);
  const j = await sendJson<{ presentationId?: string }>("presentation creation", "POST", SLIDES, token, { title: name }, fetchFn);
  if (!j.presentationId) throw new GoogleError("Google created the presentation but returned no id.", 502, false);
  return { id: j.presentationId, name, link: `https://docs.google.com/presentation/d/${j.presentationId}/edit` };
}

export const THUMBNAIL_SIZES = ["SMALL", "MEDIUM", "LARGE"] as const;
const THUMBNAIL_CAP = 10 * 1024 * 1024;

/**
 * A slide as an image (PNG), so an agent can LOOK at what its edit did.
 * \`pages.getThumbnail\` returns a \`contentUrl\` that works without a token —
 * anyone holding it sees the slide as the person would. So it is fetched HERE
 * and the bytes handed back; the URL is never shown to the agent, never put
 * in a log, and our token is never sent to it. Only a Google content host is
 * fetched. (Request shape: Slides API v1 \`presentations.pages.getThumbnail\`;
 * counts as an "expensive read" in Google's quota.)
 */
export async function getSlideThumbnail(token: string, id: string, slideId: string, size: (typeof THUMBNAIL_SIZES)[number], fetchFn: FetchFn): Promise<{ bytes: Buffer; width: number; height: number }> {
  const q = `thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=${size}`;
  const j = await getJson<{ contentUrl?: unknown; width?: unknown; height?: unknown }>("slide thumbnail", `${SLIDES}/${pathId("presentation", id)}/pages/${encodeURIComponent(slideId)}/thumbnail?${q}`, token, fetchFn);
  let u: URL | null = null;
  try {
    u = typeof j.contentUrl === "string" ? new URL(j.contentUrl) : null;
  } catch {
    u = null;
  }
  if (!u || u.protocol !== "https:" || !/(^|\.)googleusercontent\.com$/.test(u.hostname)) throw new GoogleError("Google returned no usable thumbnail address.", 502, false);
  const res = await fetchFn(u.toString(), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw await failure("thumbnail download", res);
  const bytes = await cappedBytes(res, THUMBNAIL_CAP);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new GoogleError("Google's thumbnail is not a PNG image.", 502, false);
  return { bytes, width: Number(j.width) || 0, height: Number(j.height) || 0 };
}

/** The file as the API describes it now — what an edit's requests are built
 *  against (`slidesState` / `docState` / `sheetState`). */
export async function getEditSource(token: string, app: "slides" | "doc" | "sheet", id: string, fetchFn: FetchFn): Promise<Record<string, unknown>> {
  const fid = pathId(app === "slides" ? "presentation" : app === "doc" ? "document" : "spreadsheet", id);
  const url = app === "slides" ? `${SLIDES}/${fid}` : app === "doc" ? `${DOCS}/${fid}` : `${SHEETS}/${fid}?fields=${encodeURIComponent("properties.title,sheets.properties(sheetId,title,index)")}`;
  return getJson<Record<string, unknown>>(`${app === "sheet" ? "spreadsheet" : app === "doc" ? "document" : "presentation"} read`, url, token, fetchFn);
}

/**
 * One `batchUpdate`: Google applies all the requests or none. For Slides and
 * Docs `revisionId` (read moments ago with the state the requests were built
 * from) is REQUIRED of the file, so an edit made in between refuses the batch
 * instead of landing on shifted positions. Sheets has no such control.
 */
export async function sendEditBatch(
  token: string,
  app: "slides" | "doc" | "sheet",
  id: string,
  requests: readonly Record<string, unknown>[],
  revisionId: string | undefined,
  fetchFn: FetchFn,
  outbound: boolean,
): Promise<void> {
  const fid = pathId("file", id);
  const url = `${app === "slides" ? SLIDES : app === "doc" ? DOCS : SHEETS}/${fid}:batchUpdate`;
  const body = { requests, ...(app !== "sheet" && revisionId ? { writeControl: { requiredRevisionId: revisionId } } : {}) };
  await sendJson("edit", "POST", url, token, body, fetchFn, outbound);
}

