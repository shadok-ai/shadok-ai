import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore — plain ESM shared with the browser
import { prefSyncPlan, NEVER_INHERITED } from "../public/pref-sync.js";

const names = ["mode", "soundMuted", "railMini", "tourSeen"];

test("a new account on a browser someone else used does not inherit 'tour seen'", () => {
  const plan = prefSyncPlan({ names, owner: "guest", cacheOwner: "admin", server: {}, local: { tourSeen: true, mode: "dark" } });
  assert.deepEqual(plan.cache, { tourSeen: null });
  // Tastes of the screen are a fair starting point; what a person DID is not.
  assert.deepEqual(plan.push, { mode: "dark" });
});

test("a copy of unknown origin is not treated as the caller's", () => {
  const plan = prefSyncPlan({ names, owner: "guest", cacheOwner: null, server: {}, local: { tourSeen: true } });
  assert.deepEqual(plan, { cache: { tourSeen: null }, push: {} });
  // Nor when the account itself could not be read.
  const blind = prefSyncPlan({ names, owner: null, cacheOwner: null, server: {}, local: { tourSeen: true } });
  assert.deepEqual(blind.push, {});
});

test("the account's own copy is pushed up when the server never had it", () => {
  const plan = prefSyncPlan({ names, owner: "ada", cacheOwner: "ada", server: {}, local: { tourSeen: true, railMini: false } });
  assert.deepEqual(plan, { cache: {}, push: { tourSeen: true, railMini: false } });
});

test("the server's value wins over the copy, whoever it belonged to", () => {
  const plan = prefSyncPlan({ names, owner: "ada", cacheOwner: "bob", server: { tourSeen: false, mode: "light" }, local: { tourSeen: true, mode: "light" } });
  assert.deepEqual(plan, { cache: { tourSeen: false }, push: {} });
});

test("nothing on either side is nothing to do", () => {
  assert.deepEqual(prefSyncPlan({ names, owner: "ada", cacheOwner: "ada", server: {}, local: {} }), { cache: {}, push: {} });
  assert.ok(NEVER_INHERITED.includes("tourSeen"));
});

test("the page reconciles through prefSyncPlan and records whose copy it is", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"), "utf8");
  assert.match(html, /import\("\/pref-sync\.js\?v=__ASSET_V__"\)/);
  assert.match(html, /prefSyncPlan\(\{/);
  assert.match(html, /PREFS_OWNER_KEY/);
});
