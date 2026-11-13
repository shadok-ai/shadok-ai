import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expiryActions,
  stalePublishing,
  expiryWarningText,
  draftExpiredNotice,
  pendingDraftText,
  ownerIsOperator,
  ownerExpiryFlags,
  loadWarned,
  saveWarned,
  STALE_PUBLISHING_MS,
  STALE_PUBLISHING_SENTENCE,
  STALE_GOOGLE_SENTENCE,
  GOOGLE_WARN_BEFORE_MS,
} from "../src/account-expiry.js";
import { DRAFT_TTL_MS, type Draft } from "../src/social-drafts.js";
import type { ConnectedAccount } from "../src/connected-accounts.js";

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 8, 12);
const acct = (o: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: "a1b2c3d4", provider: "linkedin", kind: "member", label: "Ada", externalId: "urn:li:person:1", owner: "admin",
  connectedVia: "x", share: { scope: "private" }, policy: "approve", token: "T", expiresAt: NOW + 30 * DAY, createdAt: 1, updatedAt: 1, ...o,
});
const draft = (o: Partial<Draft> = {}): Draft => ({ id: "d1d2d3d4e5", sessionId: "s", accountId: "a1b2c3d4", text: "hi", status: "pending", createdAt: NOW, ...o });

test("warns at 7 days before expiry, not at 8", () => {
  assert.equal(expiryActions([acct({ expiresAt: NOW + 7 * DAY })], [], NOW, {}).warn.length, 1);
  assert.equal(expiryActions([acct({ expiresAt: NOW + 8 * DAY })], [], NOW, {}).warn.length, 0);
});

test("no re-warn within 24h, re-warn after", () => {
  const a = acct({ expiresAt: NOW + 3 * DAY });
  assert.equal(expiryActions([a], [], NOW, { [a.id]: NOW - DAY + 1 }).warn.length, 0);
  assert.equal(expiryActions([a], [], NOW, { [a.id]: NOW - DAY }).warn.length, 1);
});

test("expires at expiresAt; an expired account is neither warned nor expired again", () => {
  const r = expiryActions([acct({ expiresAt: NOW })], [], NOW, {});
  assert.equal(r.expire.length, 1);
  assert.equal(r.warn.length, 0);
  const done = expiryActions([acct({ expiresAt: NOW - DAY, status: "expired" })], [], NOW, {});
  assert.deepEqual([done.warn.length, done.expire.length], [0, 0]);
});

test("drafts expire at the 7-day TTL, via expireDrafts", () => {
  assert.equal(expiryActions([], [draft({ createdAt: NOW - DRAFT_TTL_MS })], NOW, {}).expiredDrafts.length, 1);
  assert.equal(expiryActions([], [draft({ createdAt: NOW - DRAFT_TTL_MS + 1 })], NOW, {}).expiredDrafts.length, 0);
});

test("stalePublishing fails drafts stuck over 10 minutes, leaves the rest", () => {
  const stuck = draft({ id: "s1", status: "publishing", createdAt: NOW - STALE_PUBLISHING_MS });
  const fresh = draft({ id: "s2", status: "publishing", createdAt: NOW - STALE_PUBLISHING_MS + 1 });
  const r = stalePublishing([stuck, fresh, draft({ id: "s3" })], NOW);
  assert.deepEqual(r.failed.map((d) => d.id), ["s1"]);
  assert.equal(r.failed[0].status, "failed");
  assert.equal(r.failed[0].error, STALE_PUBLISHING_SENTENCE);
  assert.equal(r.list[1].status, "publishing");
  assert.equal(r.list[2].status, "pending");
});

test("stalePublishing measures from publishingAt, falls back to createdAt, skips in-flight ids", () => {
  const old = NOW - 3 * DAY;
  const fresh = draft({ id: "a", status: "publishing", createdAt: old, publishingAt: NOW - 1000 });
  const stale = draft({ id: "b", status: "publishing", createdAt: old, publishingAt: NOW - 11 * 60_000 });
  const legacy = draft({ id: "c", status: "publishing", createdAt: old });
  const live = draft({ id: "d", status: "publishing", createdAt: old, publishingAt: NOW - 11 * 60_000 });
  const r = stalePublishing([fresh, stale, legacy, live], NOW, new Set(["d"]));
  assert.deepEqual(r.failed.map((d) => d.id), ["b", "c"]);
  assert.equal(r.list[3].status, "publishing");
});

test("texts", () => {
  assert.equal(
    expiryWarningText({ label: "Ada", expiresAt: Date.UTC(2026, 10, 15, 23) }),
    "Your LinkedIn connection 'Ada' expires on 2026-11-15. Reconnect it in Secrets → Connected accounts so posts keep going out.",
  );
  assert.equal(draftExpiredNotice(draft()), "Your LinkedIn draft d1d2d3d4 expired after 7 days without approval — it was not published.");
  assert.equal(pendingDraftText("research"), "research has a LinkedIn post waiting for your approval in the cockpit.");
  assert.ok(ownerIsOperator("admin", "admin"));
  assert.ok(!ownerIsOperator("ada", "admin"));
});

test("warned sidecar: round-trips, prunes dead ids, mode 600, bad file → {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warned-"));
  const f = path.join(dir, "sub", "x.warned.json");
  assert.deepEqual(loadWarned(f), {});
  saveWarned(f, { a: 1, gone: 2 }, ["a", "b"]);
  assert.deepEqual(loadWarned(f), { a: 1 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.writeFileSync(f, "nope");
  assert.deepEqual(loadWarned(f), {});
});

test("saveWarned does not rewrite the file when nothing changed (M3)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warned-"));
  const f = path.join(dir, "k.warned.json");
  saveWarned(f, { a: 1 }, ["a"]);
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(f, old, old);
  const stamped = fs.statSync(f).mtimeMs; // as the fs stores it (sub-ms rounding)
  saveWarned(f, { a: 1, gone: 2 }, ["a"]); // same content once pruned
  assert.equal(fs.statSync(f).mtimeMs, stamped);
  saveWarned(f, { a: 5 }, ["a"]);
  assert.notEqual(fs.statSync(f).mtimeMs, stamped);
  assert.deepEqual(loadWarned(f), { a: 5 });
  // No file and nothing to remember: nothing is written.
  const g = path.join(dir, "none.warned.json");
  saveWarned(g, {}, ["a"]);
  assert.equal(fs.existsSync(g), false);
});

test("ownerExpiryFlags: only the owner gets them; soon at ≤7 days, expired by status or date", () => {
  assert.deepEqual(ownerExpiryFlags(acct({ expiresAt: NOW + 30 * DAY }), "admin", NOW), { expiringSoon: false, expired: false });
  assert.deepEqual(ownerExpiryFlags(acct({ expiresAt: NOW + 7 * DAY }), "admin", NOW), { expiringSoon: true, expired: false });
  assert.deepEqual(ownerExpiryFlags(acct({ expiresAt: NOW }), "admin", NOW), { expiringSoon: false, expired: true });
  assert.deepEqual(ownerExpiryFlags(acct({ status: "expired" }), "admin", NOW), { expiringSoon: false, expired: true });
  assert.deepEqual(ownerExpiryFlags(acct({ expiresAt: NOW + DAY }), "bob", NOW), {});
  assert.deepEqual(ownerExpiryFlags(acct({ expiresAt: NOW + DAY }), null, NOW), {});
});

// ---- Google (Testing app: 7-day authorisations) --------------------------

const gacct = (o: Partial<ConnectedAccount> = {}): ConnectedAccount =>
  acct({ id: "g0000001", provider: "google", label: "ada@example.org", externalId: "sub", expiresAt: NOW + 3600_000, refreshExpiresAt: NOW + 7 * DAY, ...o });

test("Google in Testing warns 2 days before, not 7 — a 7-day warning would fire the moment it is connected", () => {
  assert.equal(expiryActions([gacct()], [], NOW, {}).warn.length, 0, "freshly connected: 7 days left, no warning");
  assert.equal(expiryActions([gacct({ refreshExpiresAt: NOW + 2 * DAY + 1 })], [], NOW, {}).warn.length, 0);
  assert.equal(expiryActions([gacct({ refreshExpiresAt: NOW + 2 * DAY })], [], NOW, {}).warn.length, 1);
  assert.equal(GOOGLE_WARN_BEFORE_MS, 2 * DAY);
});

test("a Google account expires at its refresh deadline, never at the hourly access token's", () => {
  const stale = gacct({ expiresAt: NOW - DAY });
  assert.deepEqual(expiryActions([stale], [], NOW, {}), { warn: [], expire: [], expiredDrafts: [] });
  assert.equal(expiryActions([gacct({ refreshExpiresAt: NOW })], [], NOW, {}).expire.length, 1);
  // No known deadline (an app out of Testing): neither warned nor expired by date.
  assert.deepEqual(expiryActions([gacct({ refreshExpiresAt: undefined, expiresAt: NOW - DAY })], [], NOW, {}), { warn: [], expire: [], expiredDrafts: [] });
});

test("owner flags and the warning text follow the Google deadline", () => {
  assert.deepEqual(ownerExpiryFlags(gacct(), "admin", NOW), { expiringSoon: false, expired: false });
  assert.deepEqual(ownerExpiryFlags(gacct({ refreshExpiresAt: NOW + DAY }), "admin", NOW), { expiringSoon: true, expired: false });
  assert.deepEqual(ownerExpiryFlags(gacct({ refreshExpiresAt: NOW - 1 }), "admin", NOW), { expiringSoon: false, expired: true });
  assert.deepEqual(ownerExpiryFlags(gacct({ refreshExpiresAt: NOW + DAY }), "someone-else", NOW), {});
  assert.equal(
    expiryWarningText(gacct({ refreshExpiresAt: Date.UTC(2026, 10, 15) })),
    "Your Google connection 'ada@example.org' must be reconnected by 2026-11-15 (test app authorisations last 7 days). Reconnect it in Secrets → Connected accounts so agents keep working in it.",
  );
});

test("notices name what is waiting: an email, a calendar change, a LinkedIn post", () => {
  assert.equal(pendingDraftText("general", { provider: "google", action: "gmail.send" }), "general has an email waiting for your approval in the cockpit.");
  assert.equal(pendingDraftText("general", { provider: "google", action: "calendar.delete" }), "general has a calendar change waiting for your approval in the cockpit.");
  assert.equal(pendingDraftText("general"), "general has a LinkedIn post waiting for your approval in the cockpit.");
  assert.equal(draftExpiredNotice(draft({ provider: "google", action: "gmail.send" })), "Your email d1d2d3d4 expired after 7 days without approval — nothing left the account.");
});

test("a Google send orphaned by a restart says to check Gmail and the calendar, not LinkedIn", () => {
  const d = draft({ provider: "google", action: "gmail.send", status: "publishing", publishingAt: NOW - STALE_PUBLISHING_MS });
  assert.equal(stalePublishing([d], NOW).failed[0].error, STALE_GOOGLE_SENTENCE);
});
