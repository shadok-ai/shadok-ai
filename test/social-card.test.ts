import assert from "node:assert/strict";
import test from "node:test";
import {
  draftCardModel,
  accountRowModel,
  hasPendingDraft,
  scopeText,
  autonomousConfirmText,
  shareOptions,
  shareValue,
  shareFromValue,
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
  share: { scope: "private" },
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

test("autonomous confirm: the exact copy for each scope", () => {
  const groups = [{ id: "g1", name: "Marketing" }, { id: "g2", name: "Sales" }];
  assert.equal(
    autonomousConfirmText(account(), groups),
    "Agents in your private group will be able to post as Ada Lovelace without asking anyone.",
  );
  assert.equal(scopeText({ scope: "groups", groups: ["g1", "g2"] }, groups), "Marketing, Sales");
  assert.equal(scopeText({ scope: "instance" }, groups), "every group");
});

test("share picker: Private, the groups (not Main), Everyone — and values round-trip", () => {
  const groups = [{ id: "main", name: "Main", nature: "public" }, { id: "g1", name: "Marketing", nature: "restricted" }];
  assert.deepEqual(shareOptions(groups, { scope: "private" }).map((o: { label: string }) => o.label), ["Private", "Marketing", "Everyone"]);
  for (const s of [{ scope: "private" }, { scope: "instance" }, { scope: "groups", groups: ["g1"] }, { scope: "groups", groups: ["g1", "g2"] }]) {
    assert.deepEqual(shareFromValue(shareValue(s)), s);
  }
  const multi = shareOptions(groups, { scope: "groups", groups: ["g1", "g2"] });
  assert.ok(multi.some((o: { value: string }) => o.value === shareValue({ scope: "groups", groups: ["g1", "g2"] })));
});
