import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// index.html is a single static file driven by a classic <script>; lock the
// token card's structure and wiring by scan (same discipline as csp.test.ts).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, "..", "public", "index.html"), "utf8");

test("ui: the token card markup exists with a link and a code form", () => {
  assert.ok(/id="mtTokenOverlay"/.test(HTML), "the overlay exists");
  assert.ok(/id="mtTokenLink"/.test(HTML), "step 1 link");
  assert.ok(/id="mtTokenCodeForm"/.test(HTML) && /id="mtTokenCode"/.test(HTML), "step 2 code form");
  assert.ok(/id="mtTokenClose"/.test(HTML), "the card is closable (admin action, not a funnel)");
});

test("ui: the replace button is wired, and no red banner precedes the first connection", () => {
  assert.ok(/id="mtTokenReplaceBtn"/.test(HTML), "replace button in the version menu");
  assert.ok(/a\.multiTenant && me && me\.role === "admin"/.test(HTML), "replace button is admin + multi-tenant");
  // The blocking "no subscription token" banner shouted at a brand-new instance
  // before anyone had done anything wrong; the Connect Claude card replaces it
  // (docs/superpowers/specs/2026-11-09-onboarding-connect-claude-design.md).
  assert.ok(!/updateMtTokenBanner/.test(HTML), "the first-run banner is gone");
});

test("ui: the card talks to the /mt-token endpoints and never puts a token in markup", () => {
  assert.ok(/fetch\("\/mt-token\/start"/.test(HTML), "start endpoint called");
  assert.ok(/fetch\("\/mt-token\/code"/.test(HTML), "code endpoint called");
  assert.ok(/fetch\("\/mt-token", \{\s*method: "DELETE"/.test(HTML.replace(/\n\s*/g, " ")), "cancel on close");
  assert.ok(!/sk-ant-oat01/.test(HTML), "no token value anywhere in the page");
});

test("ui: the token card uses addEventListener, no inline on* handler (CSP)", () => {
  const card = HTML.slice(HTML.indexOf('id="mtTokenOverlay"'), HTML.indexOf("</div>\n\n<!-- The guided tour"));
  assert.ok(!/\son\w+=/.test(card), "no inline event handlers in the card markup");
});
