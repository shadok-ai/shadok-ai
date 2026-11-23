import assert from "node:assert/strict";
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
