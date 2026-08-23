import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHANNEL, TAG_FOR, pickTarget, resolveChannel } from "../src/update-channel.js";
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
