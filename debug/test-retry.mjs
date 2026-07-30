// Assertions for the transient-error detection (src/retry.ts).
// Run after `npm run build`: node debug/test-retry.mjs
import assert from "node:assert/strict";
import { findTransientErrors, newTransientErrors, RETRY_DELAYS_MS } from "../dist/retry.js";

// 529 Overloaded (the exact message the user sees) matches.
const s529 = `  ⎿ API Error: 529 Overloaded. This is a server-side issue, usually
     temporary — try again in a moment.
❯ `;
assert.equal(findTransientErrors(s529).length, 1);

// Other transient errors match: 500, 503, 429, timeout, connection.
for (const line of [
  "API Error: 500 Internal Server Error",
  "API Error: 503 Service Unavailable",
  "API Error: 429 Too Many Requests",
  "API Error (Request timed out)",
  "API Error: Connection error",
  "API Error: fetch failed",
]) {
  assert.equal(findTransientErrors(line).length, 1, line);
}

// Non-transient errors do NOT match.
for (const line of [
  "API Error: 400 invalid_request_error",
  "API Error: 401 Unauthorized",
  "API Error: 403 Forbidden",
  "some ordinary output mentioning an error",
]) {
  assert.equal(findTransientErrors(line).length, 0, line);
}

// Multiset diff: an OLD error still on screen does not re-trigger…
const old = ["API Error: 529 Overloaded"];
assert.deepEqual(newTransientErrors(old, old), []);
// …but a SECOND occurrence of the same line is new.
assert.deepEqual(
  newTransientErrors(old, [...old, "API Error: 529 Overloaded"]),
  ["API Error: 529 Overloaded"],
);
// A fresh error on a previously clean screen is new.
assert.deepEqual(newTransientErrors([], old), old);

assert.deepEqual([...RETRY_DELAYS_MS], [15_000, 30_000, 60_000]);
console.log("test-retry: all assertions passed");
