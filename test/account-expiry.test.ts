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
  loadWarned,
  saveWarned,
  STALE_PUBLISHING_MS,
  STALE_PUBLISHING_SENTENCE,
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
