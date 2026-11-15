import assert from "node:assert/strict";
import test from "node:test";
import { parseCredsExpiry } from "../src/claude-creds.js";

test("parseCredsExpiry: reads both expiries from the real credentials shape", () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-secret",
      refreshToken: "sk-secret",
      expiresAt: 1793110346635,
      refreshTokenExpiresAt: 1795021158635,
      subscriptionType: "max",
    },
  });
  assert.deepEqual(parseCredsExpiry(raw), {
    tokenExpiresAt: 1795021158635,   // refresh token — the real re-login deadline
    accessExpiresAt: 1793110346635,  // short-lived, auto-refreshed
  });
});

test("parseCredsExpiry: accepts a flat (un-nested) blob too", () => {
  const raw = JSON.stringify({ expiresAt: 10, refreshTokenExpiresAt: 20 });
  assert.deepEqual(parseCredsExpiry(raw), { tokenExpiresAt: 20, accessExpiresAt: 10 });
});

test("parseCredsExpiry: missing fields yield null, never a guess", () => {
  assert.deepEqual(parseCredsExpiry(JSON.stringify({ claudeAiOauth: { accessToken: "x" } })),
    { tokenExpiresAt: null, accessExpiresAt: null });
  // Non-numeric is not a timestamp.
  assert.deepEqual(parseCredsExpiry(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: "soon" } })),
    { tokenExpiresAt: null, accessExpiresAt: null });
});

test("parseCredsExpiry: malformed input never throws", () => {
  assert.deepEqual(parseCredsExpiry("not json"), { tokenExpiresAt: null, accessExpiresAt: null });
  assert.deepEqual(parseCredsExpiry(""), { tokenExpiresAt: null, accessExpiresAt: null });
  assert.deepEqual(parseCredsExpiry("null"), { tokenExpiresAt: null, accessExpiresAt: null });
});
