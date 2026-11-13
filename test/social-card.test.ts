import assert from "node:assert/strict";
import test from "node:test";
import {
  draftCardModel,
  accountRowModel,
  hasPendingDraft,
  scopeText,
  autonomousConfirmText,
  shareChoices,
  toggleShare,
  profileChoices,
  toggleProfile,
  normalizeShare,
  accountBanners,
  logEntryLine,
  accountBannerKey,
  accountDeadline,
  googleAutonomousConfirmText,
  googlePolicyRows,
  GOOGLE_AREA_CHOICES,
} from "../public/social-card.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 8, 12);
const draft = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  sessionId: "s1",
  accountId: "a1",
  account: "Ada Lovelace",
  text: "Hello LinkedIn",
  status: "pending",
  createdAt: NOW,
  ...over,
});

test("draft card: a pending draft offers Publish and Discard", () => {
  const m = draftCardModel(draft());
  assert.equal(m.pending, true);
  assert.deepEqual(m.actions.map((a: { action: string }) => a.action), ["publish", "discard"]);
  assert.match(m.title, /Ada Lovelace/);
  assert.equal(m.text, "Hello LinkedIn");
});

test("draft card: the text is passed through untouched, markup and all", () => {
  const evil = '<script>alert(1)</script> <img src=x onerror=alert(2)> **bold**';
  assert.equal(draftCardModel(draft({ text: evil })).text, evil);
});

test("draft card: published shows the post URL and no actions", () => {
  const m = draftCardModel(draft({ status: "published", decidedBy: "ada", postUrl: "https://www.linkedin.com/feed/update/urn:li:share:1" }));
  assert.deepEqual(m.actions, []);
  assert.equal(m.pending, false);
  assert.equal(m.statusLine, "Published — https://www.linkedin.com/feed/update/urn:li:share:1");
  assert.equal(m.link, "https://www.linkedin.com/feed/update/urn:li:share:1");
});

test("draft card: a non-http post URL is never a link", () => {
  const m = draftCardModel(draft({ status: "published", postUrl: "javascript:alert(1)" }));
  assert.equal(m.link, null);
});

test("draft card: discarded names who; failed carries the server's sentence", () => {
  assert.equal(draftCardModel(draft({ status: "discarded", decidedBy: "bob" })).statusLine, "Discarded by bob");
  assert.equal(draftCardModel(draft({ status: "failed", error: "LinkedIn refused the post." })).statusLine, "LinkedIn refused the post.");
  assert.deepEqual(draftCardModel(draft({ status: "publishing" })).actions, []);
  assert.deepEqual(draftCardModel(draft({ status: "expired" })).actions, []);
});

test("draft card: the image file card rides along", () => {
  const image = { path: "/tmp/a.png", name: "a.png", image: true, video: false };
  assert.deepEqual(draftCardModel(draft({ image })).image, image);
  assert.equal(draftCardModel(draft()).image, null);
});

test("hasPendingDraft: only `pending` asks for an answer", () => {
  assert.equal(hasPendingDraft([draft({ status: "published" }), draft({ status: "pending" })]), true);
  assert.equal(hasPendingDraft([draft({ status: "publishing" }), draft({ status: "discarded" })]), false);
  assert.equal(hasPendingDraft(new Map([["d1", draft()]]).values()), true);
  assert.equal(hasPendingDraft(undefined), false);
});

const account = (over: Record<string, unknown> = {}) => ({
  id: "a1b2c3d4",
  provider: "linkedin",
  kind: "member",
  label: "Ada Lovelace",
  externalId: "urn:li:person:x",
  owner: "ada",
  connectedVia: "ada",
  share: { personal: true, groups: [], everyone: false, profiles: [] },
  policy: "approve",
  expiresAt: NOW + 30 * DAY,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

test("account row: tone is ok at 8 days, soon at 6, expired at -1", () => {
  assert.equal(accountRowModel(account({ expiresAt: NOW + 8 * DAY }), NOW).tone, "ok");
  assert.equal(accountRowModel(account({ expiresAt: NOW + 6 * DAY }), NOW).tone, "soon");
  assert.equal(accountRowModel(account({ expiresAt: NOW - 1 * DAY }), NOW).tone, "expired");
  assert.equal(accountRowModel(account({ status: "expired" }), NOW).tone, "expired");
  assert.equal(accountRowModel(account({ expiresAt: NOW + 8 * DAY }), NOW).expiryText, "expires in 8 days");
});

test("account row: label, via, share and policy in words", () => {
  const groups = [{ id: "g1", name: "Marketing", nature: "restricted" }];
  const m = accountRowModel(account({ share: { scope: "groups", groups: ["g1"] }, policy: "autonomous" }), NOW, groups);
  assert.equal(m.label, "Ada Lovelace");
  assert.equal(m.via, "LinkedIn · connected by ada");
  assert.equal(m.shareText, "Shared with Marketing");
  assert.equal(m.policyText, "Posts without approval");
  assert.equal(accountRowModel(account(), NOW).policyText, "Every post needs approval");
});

const sh = (o: Record<string, unknown>) => ({ personal: false, groups: [], everyone: false, profiles: [], ...o });

test("autonomous confirm: the exact copy for each scope", () => {
  const groups = [{ id: "g1", name: "Marketing" }, { id: "g2", name: "Sales" }];
  assert.equal(
    autonomousConfirmText(account(), groups),
    "Agents in your Personal group will be able to post as Ada Lovelace without asking anyone.",
  );
  assert.equal(scopeText(sh({ groups: ["g1", "g2"] }), groups), "Marketing, Sales");
  assert.equal(scopeText(sh({ everyone: true }), groups), "the public groups");
  assert.equal(scopeText(sh({ personal: true, groups: ["g1"], profiles: ["Writer"] }), groups), "your Personal group, Marketing (profile Writer only)");
  assert.equal(scopeText(sh({}), groups), "no group");
  assert.equal(scopeText({ scope: "instance" }, groups), "the public groups", "a v1 share still reads");
});

test("share chips: Public, Personal, then restricted groups — combinable", () => {
  const groups = [
    { id: "main", name: "Main", nature: "public" },
    { id: "g1", name: "Marketing", nature: "restricted" },
    { id: "p-ada", name: "Ada", nature: "private" },
  ];
  const c = shareChoices(groups, sh({ personal: true }));
  assert.deepEqual(c.map((o: { label: string }) => o.label), ["Public", "Personal", "Marketing"]);
  assert.deepEqual(c.map((o: { checked: boolean }) => o.checked), [false, true, false]);
  // A public group is not a chip of its own: it IS the Public chip.
  const withPub = [...groups, { id: "pub", name: "Open", nature: "public" }];
  assert.deepEqual(shareChoices(withPub, sh({})).map((o: { label: string }) => o.label), ["Public", "Personal", "Marketing"]);
  assert.deepEqual(normalizeShare(sh({ groups: ["pub", "g1"] }), withPub), sh({ everyone: true, groups: ["g1"] }));
  let s = toggleShare(sh({ personal: true }), "group:g1", true, groups);
  s = toggleShare(s, "everyone", true, groups);
  assert.deepEqual(s, sh({ personal: true, groups: ["g1"], everyone: true }));
  assert.deepEqual(toggleShare(s, "group:g1", false, groups), sh({ personal: true, everyone: true }));
  assert.deepEqual(toggleShare(s, "personal", false, groups), sh({ groups: ["g1"], everyone: true }));
  // A v1 share naming the owner's Personal group reads as the Personal box.
  assert.deepEqual(normalizeShare({ scope: "groups", groups: ["p-ada", "g1"] }, groups), sh({ personal: true, groups: ["g1"] }));
  // A stored group the list no longer carries keeps a ticked box.
  assert.ok(shareChoices(groups, sh({ groups: ["gone"] })).some((o: { key: string; checked: boolean }) => o.key === "group:gone" && o.checked));
});

test("profile chips: Any first, every pickable profile, a vanished one kept", () => {
  const c = profileChoices(["Writer", "Dev"], sh({ profiles: ["Old"] }));
  assert.deepEqual(c.map((o: { key: string; checked: boolean }) => [o.key, o.checked]), [["*", false], ["Dev", false], ["Old", true], ["Writer", false]]);
  assert.equal(c[0].label, "Any profile");
  assert.equal(profileChoices(["Writer"], sh({}))[0].checked, true, "an empty filter lights Any");
});

test("profile chips: a name toggles, the last one off falls back to Any, Any clears", () => {
  const s = toggleProfile(sh({ everyone: true }), "Writer", true);
  assert.deepEqual(s, sh({ everyone: true, profiles: ["Writer"] }));
  assert.deepEqual(toggleProfile(s, "Writer", false), sh({ everyone: true }));
  assert.deepEqual(toggleProfile(sh({ profiles: ["Writer", "Dev"] }), "*", true), sh({}));
  assert.deepEqual(toggleProfile(sh({}), "*", false), sh({}), "Any cannot be switched off by itself");
});

test("accountBanners: own accounts that expire soon or expired, keyed by id + expiresAt", () => {
  const exp = Date.UTC(2026, 10, 12, 9);
  const list = [
    { id: "a1", label: "Ada", expiresAt: exp, expiringSoon: true, expired: false },
    { id: "a2", label: "Acme", expiresAt: exp, expiringSoon: false, expired: true },
    { id: "a3", label: "Fine", expiresAt: exp, expiringSoon: false, expired: false },
    // Someone else's account: the server sent no flags.
    { id: "a4", label: "Bob", expiresAt: exp, status: "expired" },
  ];
  assert.deepEqual(accountBanners(list), [
    { key: "a1:" + exp, text: "Your LinkedIn connection 'Ada' expires on 2026-11-12 — reconnect it in Secrets → Connected accounts." },
    { key: "a2:" + exp, text: "Your LinkedIn connection 'Acme' has expired — reconnect it in Secrets → Connected accounts." },
  ]);
  assert.deepEqual(accountBanners(null), []);
  assert.deepEqual(accountBanners([null, 3]), []);
});

test("logEntryLine: date, outcome, who, and the text or the error — plain text", () => {
  const at = Date.UTC(2026, 10, 8, 14, 5);
  assert.equal(
    logEntryLine({ at, outcome: "published", origin: "agent", channel: "writer", approvedBy: "Paul", text: "Hello <b>world</b>", postUrl: "https://www.linkedin.com/feed/update/x/" }),
    "2026-11-08 14:05 UTC · published · writer (agent) · approved by Paul · https://www.linkedin.com/feed/update/x/ · Hello <b>world</b>",
  );
  assert.equal(
    logEntryLine({ at, outcome: "refused", origin: "cron", approvedBy: "none", text: "x", error: "The post is empty." }),
    "2026-11-08 14:05 UTC · refused · cron · The post is empty. · x",
  );
  const long = logEntryLine({ at, outcome: "published", origin: "agent", approvedBy: "autonomous", text: "y".repeat(300) });
  assert.ok(long.includes("without approval"));
  assert.ok(long.length < 200);
});

// ---- Google: the email and event cards, the account row -------------------

const mail = (over: Record<string, unknown> = {}, mailOver: Record<string, unknown> = {}) => ({
  id: "g1", sessionId: "s1", accountId: "a2", account: "ana@example.org", provider: "google", action: "gmail.send", text: "summary",
  status: "pending", createdAt: NOW,
  mail: { from: "ana@example.org", to: ["Bob <bob@example.org>", "cat@example.org"], cc: ["dan@example.org"], bcc: ["eve@example.org"], subject: "Numbers", body: "Hi Bob,\n\n<b>Here</b> they are.", attachments: ["q3.pdf", "notes.txt"], ...mailOver },
  ...over,
});
const event = (over: Record<string, unknown> = {}, evOver: Record<string, unknown> = {}) => ({
  id: "g2", sessionId: "s1", accountId: "a2", account: "ana@example.org", provider: "google", action: "calendar.create", text: "summary",
  status: "pending", createdAt: NOW,
  event: { op: "create", calendarId: "primary", title: "Review", start: "2026-11-20T10:00:00", end: "2026-11-20T11:00:00", timeZone: "Europe/Paris", attendees: ["bob@example.org"], location: "Room 2", description: "Agenda:\n- numbers", ...evOver },
  ...over,
});
const fieldMap = (m: { fields: { label: string; value: string }[] }) => Object.fromEntries(m.fields.map((f) => [f.label, f.value]));

test("email card: from, to, cc, bcc, subject, the exact body and the attachment names — all of it (invariant 43)", () => {
  const m = draftCardModel(mail());
  assert.equal(m.kind, "mail");
  assert.equal(m.title, "Email from ana@example.org");
  assert.deepEqual(fieldMap(m), {
    From: "ana@example.org", To: "Bob <bob@example.org>, cat@example.org", Cc: "dan@example.org", Bcc: "eve@example.org", Subject: "Numbers",
  });
  assert.equal(m.text, "Hi Bob,\n\n<b>Here</b> they are.", "the body is passed through untouched, markup and all");
  assert.deepEqual(m.attachments, ["q3.pdf", "notes.txt"]);
  assert.deepEqual(m.actions, [{ action: "publish", label: "Send" }, { action: "discard", label: "Discard" }]);
  assert.match(m.statusLine, /nothing is sent until someone sends it/);
  assert.equal(hasPendingDraft([mail()]), true);
});

test("email card: a bcc is never hidden when there is one, and never shown as a row when there is none", () => {
  assert.equal("Bcc" in fieldMap(draftCardModel(mail({}, { bcc: [] }))), false);
  assert.equal(fieldMap(draftCardModel(mail())).Bcc, "eve@example.org");
});

test("email card: edited in Gmail asks again; sent, deleted in Gmail and discarded have no button", () => {
  assert.equal(draftCardModel(mail({}, { edited: true })).statusLine, "Edited in Gmail since — send this version?");
  assert.equal(draftCardModel(mail({}, { edited: true })).actions.length, 2);
  const sent = draftCardModel(mail({ status: "published" }));
  assert.deepEqual(sent.actions, []);
  assert.equal(sent.statusLine, "Sent.");
  assert.equal(draftCardModel(mail({ status: "gone" })).statusLine, "This draft is no longer in Gmail — deleted there, or already sent from Gmail. The cockpit sent nothing.");
  assert.deepEqual(draftCardModel(mail({ status: "gone" })).actions, []);
  assert.equal(draftCardModel(mail({ status: "discarded", decidedBy: "ana" })).statusLine, "Discarded by ana — nothing left the account.");
  assert.equal(draftCardModel(mail({ status: "publishing" })).statusLine, "Sending…");
  assert.equal(draftCardModel(mail({ status: "failed", error: "Google send failed (403)." })).statusLine, "Google send failed (403).");
});

test("event card: title, start and end with their time zone as written, the attendees Google will email, location, description", () => {
  const m = draftCardModel(event());
  assert.equal(m.kind, "event");
  assert.equal(m.title, "New calendar event — ana@example.org");
  assert.deepEqual(fieldMap(m), {
    Title: "Review", Starts: "2026-11-20 10:00 (Europe/Paris)", Ends: "2026-11-20 11:00 (Europe/Paris)",
    Attendees: "bob@example.org — Google will email them", Location: "Room 2",
  });
  assert.equal(m.text, "Agenda:\n- numbers");
  assert.equal(m.actions[0].label, "Add to calendar");
});

test("event card: an offset is shown as the event says it, an all-day date stays a date, no attendee row without attendees", () => {
  const off = fieldMap(draftCardModel(event({}, { start: "2026-11-20T10:00:00+01:00", end: "2026-11-20T11:00:00Z", timeZone: undefined })));
  assert.equal(off.Starts, "2026-11-20 10:00 (UTC+01:00)");
  assert.equal(off.Ends, "2026-11-20 11:00 (UTC)");
  // A time with its own offset is labelled by it even when a zone rides along:
  // "10:00 (America/New_York)" would name a time the event does not happen at.
  const both = fieldMap(draftCardModel(event({}, { start: "2026-11-20T10:00:00+01:00", end: "2026-11-20T11:00:00+01:00", timeZone: "America/New_York" })));
  assert.equal(both.Starts, "2026-11-20 10:00 (UTC+01:00)");
  // All day: Google's end date is the day after the last one; the card names the last day.
  const day = fieldMap(draftCardModel(event({}, { start: "2026-11-20", end: "2026-11-21", timeZone: undefined, attendees: [] })));
  assert.equal(day.Starts, "2026-11-20 (all day)");
  assert.equal(day.Ends, "2026-11-20 (all day, last day)");
  assert.equal(fieldMap(draftCardModel(event({}, { start: "2026-11-20", end: "2026-11-23" }))).Ends, "2026-11-22 (all day, last day)");
  assert.equal("Attendees" in day, false);
  assert.equal(fieldMap(draftCardModel(event({}, { calendarId: "team@group.calendar.google.com" }))).Calendar, "team@group.calendar.google.com");
});

test("event card: an update and a delete say so, on the button a person clicks", () => {
  const u = draftCardModel(event({ action: "calendar.update" }, { op: "update" }));
  assert.equal(u.title, "Change to a calendar event — ana@example.org");
  assert.equal(u.actions[0].label, "Apply the change");
  const d = draftCardModel(event({ action: "calendar.delete" }, { op: "delete" }));
  assert.equal(d.title, "Delete a calendar event — ana@example.org");
  assert.equal(d.actions[0].label, "Delete the event");
  assert.match(d.statusLine, /the event stays until someone approves it/);
  assert.equal(draftCardModel(event({ status: "published", postUrl: "https://calendar.google.com/e/1" })).link, "https://calendar.google.com/e/1");
  assert.equal(draftCardModel(event({ status: "published", postUrl: "javascript:alert(1)" })).link, null);
});

test("the LinkedIn card is unchanged, with the new empty slots", () => {
  const m = draftCardModel(draft());
  assert.equal(m.kind, "post");
  assert.deepEqual(m.fields, []);
  assert.deepEqual(m.attachments, []);
  assert.equal(m.actions[0].label, "Publish");
});

const gaccount = (over: Record<string, unknown> = {}) => ({
  id: "a2", provider: "google", label: "ana@example.org", connectedVia: "ana", share: { personal: true, groups: [], everyone: false, profiles: [] },
  policy: "approve", policies: { mail: "approve", calendar: "autonomous" }, areas: ["calendar", "gmail"],
  expiresAt: NOW + 3600_000, refreshExpiresAt: NOW + 6 * DAY, ...over,
});

test("Google row: granted areas as chips, the two settings, the weekly deadline from the REFRESH token", () => {
  const m = accountRowModel(gaccount(), NOW);
  assert.equal(m.provider, "google");
  assert.equal(m.via, "Google · connected by ana");
  assert.deepEqual(m.areas, [
    { key: "calendar", label: "Calendar", granted: true },
    { key: "drive", label: "Drive files", granted: false },
    { key: "gmail", label: "Gmail", granted: true },
  ]);
  assert.equal(m.expiryText, "reconnect in 6 days", "not 'expires in 60 min' — that is the access token");
  assert.equal(m.tone, "ok");
  assert.equal(m.testNote, "Test app — reconnect weekly");
  assert.equal(m.policyText, "Mail: with approval · Events: automatic");
  assert.equal(accountRowModel(gaccount({ refreshExpiresAt: NOW + DAY }), NOW).tone, "soon");
  assert.equal(accountRowModel(gaccount({ refreshExpiresAt: NOW - 1 }), NOW).tone, "expired");
  const live = accountRowModel(gaccount({ refreshExpiresAt: undefined }), NOW);
  assert.equal(live.expiryText, "connected");
  assert.equal(live.testNote, "", "no deadline, no Testing note");
  assert.deepEqual(accountRowModel({ provider: "linkedin", label: "Ada", expiresAt: NOW + 30 * DAY }, NOW).areas, []);
});

test("Google settings: two rows, each its own; the confirmation spells out what automatic means", () => {
  const rows = googlePolicyRows(gaccount());
  assert.deepEqual(rows.map((r: { key: string; label: string }) => [r.key, r.label]), [["mail", "Mail"], ["calendar", "Events"]]);
  assert.deepEqual(rows[0].choices.map((c: { checked: boolean }) => c.checked), [true, false]);
  assert.deepEqual(rows[1].choices.map((c: { checked: boolean }) => c.checked), [false, true]);
  assert.equal(googleAutonomousConfirmText(gaccount(), "mail", []), "Agents in your Personal group will be able to send email as ana@example.org without asking anyone.");
  assert.equal(
    googleAutonomousConfirmText(gaccount(), "calendar", []),
    "Agents in your Personal group will be able to add, change and delete events in ana@example.org's calendar without asking anyone.",
  );
});

test("the Connect Google dialog offers the three areas, in the broker's order", () => {
  assert.deepEqual(GOOGLE_AREA_CHOICES.map((c: { key: string; label: string }) => [c.key, c.label]), [["calendar", "Calendar"], ["drive", "Drive files"], ["gmail", "Gmail"]]);
});

test("Google banner: named Google, dated by the deadline, and its dismissal key survives the hourly token renewal", () => {
  const a = gaccount({ expiringSoon: true, refreshExpiresAt: Date.UTC(2026, 10, 15) });
  const [b] = accountBanners([a]);
  assert.equal(b.text, "Your Google connection 'ana@example.org' expires on 2026-11-15 — reconnect it in Secrets → Connected accounts.");
  assert.equal(accountBannerKey(a), accountBannerKey({ ...a, expiresAt: a.expiresAt + 3600_000 }), "a renewed access token is the same banner");
  assert.notEqual(accountBannerKey(a), accountBannerKey({ ...a, refreshExpiresAt: a.refreshExpiresAt + 7 * DAY }), "a reconnect is a new one");
  assert.equal(accountDeadline({ provider: "linkedin", expiresAt: 5 }), 5);
});

test("log line: a Google entry names its action; nothing but the summary is there to show", () => {
  const line = logEntryLine({ at: NOW, accountId: "a2", origin: "agent", channel: "general", approvedBy: "ana", action: "gmail.send", text: 'to bob@example.org — "Numbers"', outcome: "done" });
  assert.equal(line, '2026-11-08 12:00 UTC · gmail.send · done · general (agent) · approved by ana · to bob@example.org — "Numbers"');
});
