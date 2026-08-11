import assert from "node:assert/strict";
import test from "node:test";
import { formatStars } from "../src/stars.js";

test("formatStars groups thousands with commas, like GitHub", () => {
  assert.equal(formatStars(200227), "200,227");
  assert.equal(formatStars(1234), "1,234");
  assert.equal(formatStars(1000000), "1,000,000");
});

test("formatStars leaves small counts alone", () => {
  assert.equal(formatStars(0), "0");
  assert.equal(formatStars(7), "7");
  assert.equal(formatStars(999), "999");
});

test("formatStars never invents a number", () => {
  // The button renders without a count rather than with a wrong one, so
  // anything unusable must come back as the empty string.
  assert.equal(formatStars(NaN), "");
  assert.equal(formatStars(-1), "");
  assert.equal(formatStars(Infinity), "");
});

test("formatStars is locale-independent", () => {
  // Written by hand precisely because toLocaleString would print "200 227" or
  // "200.227" on a container in another locale — which reads as a bug next to
  // a GitHub logo.
  assert.equal(formatStars(200227), "200,227");
  assert.doesNotMatch(formatStars(200227), /[ .  ]/);
});
