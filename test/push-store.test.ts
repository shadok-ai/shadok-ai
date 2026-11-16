import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  upsertSubscription,
  removeSubscription,
  dropEndpoints,
  deviceLabel,
  loadPushState,
  savePushState,
  MAX_SUBS_PER_USER,
  type StoredSubscription,
} from "../src/push-store.js";

const keys = { p256dh: "p", auth: "a" };
const sub = (n: number) => ({ endpoint: `https://web.push.apple.com/${n}`, keys });

test("upsert: one row per device, the latest account wins", () => {
  let l: StoredSubscription[] = [];
  l = upsertSubscription(l, sub(1), "ada", 1);
  l = upsertSubscription(l, sub(1), "ada", 2);
  assert.equal(l.length, 1);
  l = upsertSubscription(l, sub(1), "bob", 3);
  assert.deepEqual(l.map((s) => s.user), ["bob"], "a device notifies one account, never two");
});

test("upsert: caps devices per account, dropping the oldest", () => {
  let l: StoredSubscription[] = [];
  for (let i = 0; i < MAX_SUBS_PER_USER + 3; i++) l = upsertSubscription(l, sub(i), "ada", i);
  l = upsertSubscription(l, sub(100), "bob", 100);
  assert.equal(l.filter((s) => s.user === "ada").length, MAX_SUBS_PER_USER);
  assert.ok(!l.some((s) => s.endpoint.endsWith("/0")), "oldest dropped");
  assert.equal(l.filter((s) => s.user === "bob").length, 1, "another account is untouched");
});

test("remove: only the owning account; drop dead endpoints", () => {
  const l = [sub(1), sub(2)].map((s, i) => ({ ...s, user: i ? "bob" : "ada", createdAt: i }));
  assert.equal(removeSubscription(l, sub(1).endpoint, "bob").length, 2, "bob cannot unsubscribe ada's device");
  assert.equal(removeSubscription(l, sub(1).endpoint, "ada").length, 1);
  assert.deepEqual(dropEndpoints(l, new Set([sub(2).endpoint])).map((s) => s.user), ["ada"]);
});

test("deviceLabel", () => {
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"), "Windows · Edge");
  assert.equal(deviceLabel(undefined), undefined);
});

test("loadPushState: creates keys once, survives a broken file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
  const file = path.join(dir, "p.json");
  const a = loadPushState(file);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  const b = loadPushState(file);
  assert.equal(b.vapid.publicKey, a.vapid.publicKey, "stable across reads");
  savePushState({ ...b, subs: [{ ...sub(1), user: "ada", createdAt: 1 }, { junk: true } as never] }, file);
  assert.equal(loadPushState(file).subs.length, 1, "malformed rows dropped");
  fs.writeFileSync(file, "{nope");
  assert.notEqual(loadPushState(file).vapid.publicKey, a.vapid.publicKey, "a broken file gets fresh keys");
  fs.rmSync(dir, { recursive: true });
});
