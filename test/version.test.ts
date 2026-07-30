import assert from "node:assert/strict";
import test from "node:test";
import { isNewer } from "../src/version.js";

test("isNewer: patch bump", () => {
  assert.equal(isNewer("0.1.132", "0.1.131"), true);
  assert.equal(isNewer("0.1.131", "0.1.131"), false);
  assert.equal(isNewer("0.1.130", "0.1.131"), false);
});

test("isNewer: minor and major outrank patch", () => {
  assert.equal(isNewer("0.2.0", "0.1.999"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.5", "0.2.0"), false);
});

test("isNewer: tolerates a leading v and missing parts", () => {
  assert.equal(isNewer("v0.1.132", "0.1.131"), true);
  assert.equal(isNewer("0.2", "0.1.9"), true);
  assert.equal(isNewer("garbage", "0.1.0"), false);
});
