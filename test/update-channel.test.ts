import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTO_UPDATE,
  DEFAULT_CHANNEL,
  TAG_FOR,
  pickTarget,
  resolveAutoUpdate,
  resolveChannel,
} from "../src/update-channel.js";
import { isNewer } from "../src/version.js";

// Two release streams share one registry: `alpha` moves on every merge, and the
// beta channel reads `latest`, which CI only moves on a minor bump. See
// docs/superpowers/specs/2026-08-23-update-channels-design.md for why the beta
// channel is `latest` rather than a `beta` dist-tag.

test("the beta channel reads `latest`, so a fresh npx install lands on it", () => {
  assert.equal(TAG_FOR.beta, "latest");
  assert.equal(TAG_FOR.alpha, "alpha");
});

test("resolveChannel: absent or malformed config falls back to beta, never throws", () => {
  assert.equal(resolveChannel("alpha"), "alpha");
  assert.equal(resolveChannel("beta"), "beta");
  assert.equal(DEFAULT_CHANNEL, "beta");
  // A broken config must not stop an instance from updating at all, and the
  // calm channel is the safe way to be wrong.
  for (const junk of [undefined, null, "", "ALPHA", "stable", 3, {}, []])
    assert.equal(resolveChannel(junk), "beta", `${JSON.stringify(junk)} → beta`);
});

test("beta follows `latest` and ignores whatever alpha points at", () => {
  const t = pickTarget("beta", { alpha: "0.3.120", latest: "0.3.101" }, isNewer);
  assert.equal(t, "0.3.101");
});

test("alpha never goes backwards during the promotion window", () => {
  // A promotion publish moves `latest` and leaves `alpha` on the previous
  // build, so for the span of one merge `latest` is the NEWER of the two. An
  // alpha instance must not downgrade itself to the stale alpha tag.
  assert.equal(pickTarget("alpha", { alpha: "0.2.107", latest: "0.3.108" }, isNewer), "0.3.108");
  // Steady state: alpha is ahead and wins.
  assert.equal(pickTarget("alpha", { alpha: "0.3.120", latest: "0.3.108" }, isNewer), "0.3.120");
});

test("a failed lookup is not an answer: the other tag is used, else null", () => {
  assert.equal(pickTarget("alpha", { alpha: null, latest: "0.3.108" }, isNewer), "0.3.108");
  assert.equal(pickTarget("alpha", { alpha: "0.3.120", latest: null }, isNewer), "0.3.120");
  assert.equal(pickTarget("alpha", { alpha: null, latest: null }, isNewer), null);
  assert.equal(pickTarget("beta", { alpha: "0.3.120", latest: null }, isNewer), null);
});

// --- resolveAutoUpdate ------------------------------------------------------
// Self-update defaults ON so an ordinary deployment tracks its channel with
// nothing to configure. Two properties keep that from being dangerous: the env
// var must be able to say NO (with the default off, "off" needed no spelling),
// and the default only applies where a supervisor can respawn the server.

test("resolveAutoUpdate: a supervised instance that chose nothing updates itself", () => {
  assert.equal(DEFAULT_AUTO_UPDATE, true);
  assert.equal(resolveAutoUpdate(undefined, undefined, true), true);
  assert.equal(resolveAutoUpdate(null, "", true), true);
  // Whitespace is not a choice either.
  assert.equal(resolveAutoUpdate(undefined, "   ", true), true);
});

test("resolveAutoUpdate: SHADOK_AUTOUPDATE can force it OFF, not just on", () => {
  // The regression this guards: read as /^(1|true|yes|on)$/.test(env ?? ""),
  // absence and "0" were the same answer. Once the default is ON that turns
  // `SHADOK_AUTOUPDATE=0` into a no-op — an instance updating itself while its
  // own configuration says not to.
  for (const off of ["0", "false", "no", "off", "FALSE", "Off"])
    assert.equal(resolveAutoUpdate(undefined, off, true), false, `${off} → off`);
  for (const on of ["1", "true", "yes", "on", "TRUE", "On"])
    assert.equal(resolveAutoUpdate(undefined, on, false), true, `${on} → on`);
});

test("resolveAutoUpdate: no supervisor, no default — exit 75 would just end it", () => {
  // `npm run web` and the side-by-side build in CLAUDE.md run dist/server.js
  // directly: there is nothing to reinstall and relaunch, so the update exit
  // would be the server disappearing without a word.
  assert.equal(resolveAutoUpdate(undefined, undefined, false), false);
  assert.equal(resolveAutoUpdate(null, "", false), false);
  // But an explicit choice is still honoured — someone who ticked the box on a
  // hand-run server asked for it.
  assert.equal(resolveAutoUpdate(true, undefined, false), true);
  assert.equal(resolveAutoUpdate(undefined, "1", false), true);
});

test("resolveAutoUpdate: a stored choice beats the env var and the default", () => {
  // Same precedence as the ledger reflex: only an instance that never
  // expressed a choice gets a new default, so flipping it overrides nobody.
  assert.equal(resolveAutoUpdate(false, "1", true), false);
  assert.equal(resolveAutoUpdate(true, "0", true), true);
  assert.equal(resolveAutoUpdate(false, undefined, true), false);
});
