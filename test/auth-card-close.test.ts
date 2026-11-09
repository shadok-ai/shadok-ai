import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The sign-in card is a non-dismissable funnel when the instance is SIGNED OUT
// (signing in is the only way to make it usable), but a VOLUNTARY re-login
// opened from the panel/banner (force) must be closable — and closing it has to
// cancel the pending `claude auth login` child on the server (DELETE
// /auth/login → cancelLogin), or it is left waiting on stdin. Locked here like
// test/ws-url.test.ts locks the socket scheme: browser-only wiring, silent to
// tsc, and the exact thing a refactor of the card could quietly drop.
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

test("the auth card has a close button", () => {
  assert.match(HTML, /id="authClose"/, "expected a #authClose button in the card");
});

test("closability tracks the plan: the first-run funnel is not dismissable", () => {
  // The Connect card records the plan's dismissable flag (public/connect-card.js:
  // false for the never-connected funnel, true for a re-login, a space to
  // connect, or the "ask an admin" note) and only shows ✕ for those.
  assert.match(HTML, /authDismissable\s*=\s*plan\.dismissable/, "openConnectCard must record dismissable");
  assert.match(
    HTML,
    /\$\("authClose"\)\.hidden\s*=\s*!plan\.dismissable/,
    "the ✕ is shown only for a dismissable card",
  );
});

test("closing is gated on dismissable AND cancels the server flow", () => {
  const m = HTML.match(/function closeAuthCard\(\)\s*\{([\s\S]*?)\n\s{2}\}/);
  assert.ok(m, "expected a closeAuthCard() function");
  const body = m![1];
  assert.match(body, /if\s*\(\s*!authDismissable\s*\)\s*return/, "must no-op when the card is the signed-out funnel");
  assert.match(body, /cxCancel\(\)/, "must cancel the pending flow");
  // …and the cancel reaches every server flow the card can run.
  // cxCancel delegates to cxCancelFlow, which a stale in-flight start also uses.
  const c = HTML.match(/function cxCancelFlow\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/);
  assert.ok(c, "expected a cxCancelFlow() function");
  assert.match(c![1], /fetch\(\s*["']\/auth\/login["']\s*,\s*\{\s*method:\s*["']DELETE["']/, "cancels the instance sign-in child");
  assert.match(c![1], /fetch\(\s*["']\/mt-token["']\s*,\s*\{\s*method:\s*["']DELETE["']/, "cancels the token mint");
  assert.match(c![1], /fetch\(\s*["']\/agent-login["']\s*,\s*\{\s*method:\s*["']DELETE["']/, "cancels a space login");
  assert.match(body, /\$\("authOverlay"\)\.hidden\s*=\s*true/, "must hide the overlay");
});

test("Escape only closes a dismissable auth card", () => {
  assert.match(
    HTML,
    /authOverlay"\)\.hidden\s*&&\s*authDismissable\s*\)\s*\{\s*closeAuthCard\(\)/,
    "the Escape cascade must gate the auth card on authDismissable",
  );
});

test("the Model backend entry opens the form without starting any OAuth child", () => {
  const m = HTML.match(/function openAuthCard\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/);
  assert.ok(m, "expected openAuthCard()");
  const other = m![1].slice(0, m![1].indexOf("checkAuth("));
  assert.doesNotMatch(other, /openConnectCard\(|cxStartAuthorise\(/, "mode \"other\" must not start a sign-in");
});

test("a start superseded while in flight cancels its own child", () => {
  const m = HTML.match(/async function cxStartAuthorise\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/);
  assert.ok(m, "expected cxStartAuthorise()");
  assert.match(m![1], /cxCancel\(\)/, "a new start cancels the previous flow first");
  assert.match(m![1], /seq\s*!==\s*cx\.seq/, "a start resolved after close/supersede is detected");
  assert.match(m![1], /cxCancelFlow\(/, "…and its child is cancelled");
});
