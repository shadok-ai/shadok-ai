import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { waPanelModel, agoText } from "../public/wa-panel.js";

const NOW = 10_000_000;
const ACCOUNT = { name: "Ada's shop", phone: "33600000000" };

test("unlinked: off, the intro and the ban warning, one action — Link", () => {
  const m = waPanelModel({ phase: "unlinked" }, NOW);
  assert.equal(m.tone, "off");
  assert.deepEqual(m.blocks, ["intro", "warning"]);
  assert.deepEqual(m.actions, ["link"]);
});

test("linking with a QR: wait, the code and the steps, Cancel", () => {
  const m = waPanelModel({ phase: "linking", startedAt: NOW - 1000, expiresAt: NOW + 120_000, qrSvg: "<svg/>" }, NOW);
  assert.equal(m.tone, "wait");
  assert.deepEqual(m.blocks, ["qr", "steps"]);
  assert.deepEqual(m.actions, ["cancel"]);
  assert.match(m.status, /2 min/);
});

test("linking without a QR shows the steps and no code", () => {
  const m = waPanelModel({ phase: "linking", startedAt: NOW, expiresAt: NOW + 180_000 }, NOW);
  assert.deepEqual(m.blocks, ["steps"]);
  assert.ok(!m.blocks.includes("qr"));
  assert.deepEqual(m.actions, ["cancel"]);
});

test("connected: ok, who and since when, the warning still reachable, Unlink", () => {
  const m = waPanelModel({ phase: "connected", account: ACCOUNT, linkedAt: NOW - 3 * 3600_000, connectedAt: NOW - 6 * 60_000, lastSeenAt: NOW }, NOW);
  assert.equal(m.tone, "ok");
  assert.deepEqual(m.blocks, ["identity", "since", "warning"]);
  assert.deepEqual(m.actions, ["unlink"]);
  assert.match(m.text.identity, /Ada's shop/);
  assert.match(m.text.identity, /33600000000/);
  assert.match(m.text.since, /linked 3 h ago/);
  assert.match(m.text.since, /connected 6 min ago/);
});

test("reconnecting: wait, the same identity, how long ago it was lost", () => {
  const m = waPanelModel({ phase: "reconnecting", account: ACCOUNT, linkedAt: NOW - 3600_000, lostAt: NOW - 6 * 60_000, attempt: 4 }, NOW);
  assert.equal(m.tone, "wait");
  assert.deepEqual(m.blocks, ["identity", "lost", "warning"]);
  assert.deepEqual(m.actions, ["unlink"]);
  assert.match(m.text.lost, /connection lost 6 min ago, retrying/);
});

test("reconnecting at attempt 0 (a boot resuming) does not claim a loss", () => {
  const m = waPanelModel({ phase: "reconnecting", account: ACCOUNT, linkedAt: NOW - 3600_000, lostAt: NOW, attempt: 0 }, NOW);
  assert.doesNotMatch(m.text.lost, /lost/);
});

test("logged-out: err, why, and both Link again and Unlink", () => {
  const m = waPanelModel({ phase: "logged-out", account: ACCOUNT, at: NOW - 60_000, detail: "the device was removed from the phone" }, NOW);
  assert.equal(m.tone, "err");
  assert.deepEqual(m.blocks, ["identity", "removed"]);
  assert.deepEqual(m.actions, ["relink", "unlink"]);
  assert.match(m.text.removed, /removed from the phone/);
});

test("unavailable: err, the reason, and never Link", () => {
  const m = waPanelModel({ phase: "unavailable", reason: "the instance's groups are not migrated yet" }, NOW);
  assert.equal(m.tone, "err");
  assert.deepEqual(m.blocks, ["reason"]);
  assert.ok(!m.actions.includes("link"));
  assert.ok(!m.actions.includes("relink"));
  assert.match(m.text.reason, /not migrated/);
});

test("an unknown or missing view is treated as unavailable, never as linkable", () => {
  for (const v of [null, undefined, {}, { phase: "weird" }]) {
    const m = waPanelModel(v as never, NOW);
    assert.equal(m.tone, "err");
    assert.ok(!m.actions.includes("link"));
  }
});

test("agoText words durations from now", () => {
  assert.equal(agoText(NOW - 10_000, NOW), "less than a minute ago");
  assert.equal(agoText(NOW - 6 * 60_000, NOW), "6 min ago");
  assert.equal(agoText(NOW - 5 * 3600_000, NOW), "5 h ago");
  assert.equal(agoText(NOW - 3 * 86400_000, NOW), "3 days ago");
});

test("halted: err, the reason, Retry and Link again — never Reconnecting", () => {
  const m = waPanelModel({ phase: "halted", cause: "permanent", account: ACCOUNT, at: NOW - 60_000, reason: "connection replaced: this number was linked again elsewhere" }, NOW);
  assert.equal(m.tone, "err");
  assert.equal(m.status, "Stopped");
  assert.deepEqual(m.blocks, ["identity", "reason"]);
  assert.deepEqual(m.actions, ["retry", "relink"]);
  assert.match(m.text.reason, /linked again elsewhere/);
});

test("a stored session can always be unlinked — unavailable included, linking excepted", () => {
  assert.deepEqual(waPanelModel({ phase: "unavailable", reason: "x", stored: true }, NOW).actions, ["unlink"]);
  assert.deepEqual(waPanelModel({ phase: "unavailable", reason: "x", stored: false }, NOW).actions, []);
  assert.deepEqual(waPanelModel({ phase: "unlinked", stored: true }, NOW).actions, ["link", "unlink"]);
  assert.deepEqual(waPanelModel({ phase: "halted", cause: "permanent", at: NOW, reason: "r", stored: true }, NOW).actions, ["retry", "relink", "unlink"]);
  assert.deepEqual(waPanelModel({ phase: "linking", startedAt: NOW, stored: true }, NOW).actions, ["cancel"]);
});

test("linking with a code that cannot be drawn says why, instead of 'waiting for a code'", () => {
  const m = waPanelModel({ phase: "linking", startedAt: NOW, expiresAt: NOW + 60_000, qrError: "the QR encoder (qrcode) is not installed" }, NOW);
  assert.equal(m.tone, "err");
  assert.doesNotMatch(m.status, /waiting for a code/);
  assert.deepEqual(m.blocks, ["reason"]);
  assert.match(m.text.reason, /qrcode/);
  assert.deepEqual(m.actions, ["cancel"]);
});

// ── the library, installed on demand ────────────────────────────────────────

test("unlinked with the library not installed: Link is still THE action, and the panel says it downloads first", () => {
  const m = waPanelModel({ phase: "unlinked", library: "absent" }, NOW);
  assert.deepEqual(m.blocks, ["intro", "download", "warning"]);
  assert.deepEqual(m.actions, ["link"]);
  assert.match(m.text.download, /downloads the WhatsApp library/);
  assert.match(m.text.download, /MB/);
  assert.match(waPanelModel({ phase: "unlinked", library: "stale" }, NOW).text.download, /newer|another version/);
  assert.deepEqual(waPanelModel({ phase: "unlinked", library: "ready" }, NOW).blocks, ["intro", "warning"]);
});

test("installing: wait, an honest 'it can take a minute', and no button that would start a second install", () => {
  const m = waPanelModel({ phase: "installing", startedAt: NOW - 20_000, then: "link" }, NOW);
  assert.equal(m.tone, "wait");
  assert.match(m.status, /Installing/);
  assert.deepEqual(m.blocks, ["installing"]);
  assert.deepEqual(m.actions, []);
  assert.match(m.text.installing, /minute/);
  assert.match(m.text.installing, /QR code/);
});

test("installing to resume a stored session: whose, what follows, and Unlink still offered", () => {
  const m = waPanelModel({ phase: "installing", startedAt: NOW, then: "resume", account: ACCOUNT, stored: true }, NOW);
  assert.deepEqual(m.blocks, ["identity", "installing"]);
  assert.match(m.text.installing, /reconnects/);
  assert.deepEqual(m.actions, ["unlink"]);
});

test("halted for the library: the reason, and Install — Link again only when there is a session to relink", () => {
  const withSession = waPanelModel({ phase: "halted", cause: "library", account: ACCOUNT, at: NOW, reason: "the WhatsApp library is not installed on this instance", stored: true }, NOW);
  assert.equal(withSession.tone, "err");
  assert.match(withSession.status, /library/i);
  assert.deepEqual(withSession.actions, ["install", "relink", "unlink"]);
  assert.match(withSession.text.reason, /not installed/);
  const failedInstall = waPanelModel({ phase: "halted", cause: "library", at: NOW, reason: "could not install the WhatsApp library: the disk is full" }, NOW);
  assert.deepEqual(failedInstall.actions, ["install"]);
  assert.match(failedInstall.text.reason, /disk is full/);
});

test("every block and button the model can name exists in the page", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const views = [
    { phase: "unlinked", library: "absent" },
    { phase: "installing", startedAt: NOW, then: "resume", account: ACCOUNT, stored: true },
    { phase: "linking", startedAt: NOW, qrSvg: "<svg/>" },
    { phase: "linking", startedAt: NOW, qrError: "x" },
    { phase: "connected", account: ACCOUNT, linkedAt: NOW, connectedAt: NOW, lastSeenAt: NOW },
    { phase: "reconnecting", account: ACCOUNT, linkedAt: NOW, lostAt: NOW, attempt: 1 },
    { phase: "logged-out", account: ACCOUNT, at: NOW, detail: "d" },
    { phase: "halted", cause: "permanent", account: ACCOUNT, at: NOW, reason: "r", stored: true },
    { phase: "halted", cause: "library", account: ACCOUNT, at: NOW, reason: "r" },
    { phase: "unavailable", reason: "r" },
  ];
  for (const v of views) {
    const m = waPanelModel(v, NOW);
    for (const b of m.blocks) assert.ok(html.includes(`data-wa-block="${b}"`), `block ${b}`);
    for (const a of m.actions) assert.ok(html.includes(`data-wa-action="${a}"`), `action ${a}`);
  }
});

// ── the guest door (step 2) ─────────────────────────────────────────────────
import { waGuestsModel } from "../public/wa-panel.js";

const groups = [{ id: "g1", name: "Support" }];
const door = (o: Record<string, unknown> = {}) => ({
  phase: "connected",
  account: { name: "Ada's shop", phone: "33600000000" },
  guests: { mode: "group", group: null, profile: null },
  guestGroups: groups,
  ...o,
});

test("waGuestsModel: shown only once a number is linked", () => {
  assert.equal(waGuestsModel(door()).show, true);
  assert.equal(waGuestsModel(door({ phase: "reconnecting" })).show, true);
  assert.equal(waGuestsModel(door({ phase: "halted" })).show, true, "a halted link keeps its door settings visible");
  for (const phase of ["unlinked", "linking", "installing", "unavailable"]) assert.equal(waGuestsModel(door({ phase, account: undefined })).show, false, phase);
  assert.equal(waGuestsModel(null).show, false);
});

test("waGuestsModel: the open door names where strangers land and who reads them", () => {
  const m = waGuestsModel(door({ guests: { mode: "dm-only", group: "g1", profile: "Support" } }));
  assert.equal(m.on, true);
  assert.equal(m.group, "g1");
  assert.equal(m.profile, "Support");
  assert.match(m.note, /Support/);
  assert.match(m.note, /members/);
});

test("waGuestsModel: no restricted group → cannot open, and says what is needed", () => {
  const m = waGuestsModel(door({ guestGroups: [] }));
  assert.equal(m.canOpen, false);
  assert.match(m.note, /restricted group/);
});

test("waGuestsModel: shut is silence, and the panel says so", () => {
  const m = waGuestsModel(door({ guests: { mode: "group", group: "g1", profile: "Support" } }));
  assert.equal(m.on, false);
  assert.equal(m.canOpen, true);
  assert.match(m.note, /no reply/i);
});

test("the panel no longer says messages are not handled", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /messages are not handled yet/);
});
