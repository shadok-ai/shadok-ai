import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error — pure ESM module loaded by the browser too, no types.
import { pickChannelSource, dirKey } from "../public/channel-store.js";

// The channel list has two sources at boot: the server's /channels (isolated
// per launch dir) and an origin-scoped localStorage cache. Falling back to the
// cache on an EMPTY-but-successful response is what leaked the main project's
// channels into a fresh instance sharing the same port. A successful response
// is authoritative — even when it is [].

test("pickChannelSource: a fulfilled response wins, even when empty", () => {
  // The core of the fix: [] from the server means "this dir has no channels",
  // NOT "consult the cache".
  assert.deepEqual(pickChannelSource({ status: "fulfilled", value: [] }, [{ sessionId: "main-1" }]), []);
  assert.deepEqual(
    pickChannelSource({ status: "fulfilled", value: [{ sessionId: "a" }] }, [{ sessionId: "cached" }]),
    [{ sessionId: "a" }],
  );
});

test("pickChannelSource: only a FAILED fetch falls back to the cache", () => {
  assert.deepEqual(pickChannelSource({ status: "rejected", reason: "net" }, [{ sessionId: "c" }]), [
    { sessionId: "c" },
  ]);
  // A fulfilled-but-not-an-array payload (an error object, a 500 body) is not a
  // channel list — treat it like a failure.
  assert.deepEqual(pickChannelSource({ status: "fulfilled", value: { error: "x" } }, [{ sessionId: "c" }]), [
    { sessionId: "c" },
  ]);
});

test("pickChannelSource: a missing cache degrades to []", () => {
  assert.deepEqual(pickChannelSource({ status: "rejected" }, null), []);
  assert.deepEqual(pickChannelSource({ status: "rejected" }, "not-an-array"), []);
});

test("dirKey: namespaces the cache by launch dir when known", () => {
  // Two launch dirs on the same origin (same port) must not share a bucket.
  assert.equal(dirKey("cp.channels", "-Users-x-projA"), "cp.channels:-Users-x-projA");
  assert.notEqual(dirKey("cp.channels", "-Users-x-projA"), dirKey("cp.channels", "-Users-x-projB"));
});

test("dirKey: falls back to the bare key when the dir is unknown", () => {
  // Before /defaults has answered, there is no key to namespace with; the bare
  // key is the pre-fix behaviour and must not crash.
  assert.equal(dirKey("cp.channels", ""), "cp.channels");
  assert.equal(dirKey("cp.channels", undefined), "cp.channels");
});
