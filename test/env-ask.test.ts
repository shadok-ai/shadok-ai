import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envVarAsks, isEnvAsk, MAX_ENV_ASKS_PER_MESSAGE } from "../public/env-ask.js";

test("the shape that prompted it: a missing token inside an inline code span", () => {
  const msg = "Le CLI `/workspace/hubspot/hubspot.mjs` est installé, mais il s'arrête sur `HUBSPOT_TOKEN missing from the environment`.";
  assert.deepEqual(envVarAsks(msg), ["HUBSPOT_TOKEN"]);
});

test("a bare inline name and a fenced export are both offered, in order", () => {
  const msg = "Ajoute `MATOMO_URL` puis :\n```\nexport MATOMO_TOKEN_AUTH=xxx\n```";
  assert.deepEqual(envVarAsks(msg), ["MATOMO_URL", "MATOMO_TOKEN_AUTH"]);
});

test("a capitalised word in prose is not an ask", () => {
  assert.deepEqual(envVarAsks("Il faut un HUBSPOT_TOKEN pour ça."), []);
});

test("settings the agent owns or the cockpit sets get no button", () => {
  assert.equal(isEnvAsk("NODE_ENV"), false);
  assert.equal(isEnvAsk("SHADOK_SESSION_KEY"), false);
  assert.equal(isEnvAsk("CLAUDE_CODE_OAUTH_TOKEN"), false);
  assert.equal(isEnvAsk("LOG_LEVEL"), false);
  assert.equal(isEnvAsk("PATH"), false);            // no underscore
  assert.equal(isEnvAsk("hubspot_token"), false);   // not an env name
});

test("credentials and connection settings do", () => {
  for (const n of ["GOOGLE_ADS_DEVELOPER_TOKEN", "BING_API_KEY", "GSC_CLIENT_SECRET", "DATABASE_URL", "GOOGLE_ADS_CUSTOMER_ID"]) {
    assert.equal(isEnvAsk(n), true, n);
  }
});

test("duplicates collapse and the list is bounded", () => {
  assert.deepEqual(envVarAsks("`A_TOKEN` et encore `A_TOKEN`"), ["A_TOKEN"]);
  const many = Array.from({ length: 10 }, (_, i) => `\`X${i}_TOKEN\``).join(" ");
  assert.equal(envVarAsks(many).length, MAX_ENV_ASKS_PER_MESSAGE);
});

test("nothing to offer yields nothing", () => {
  assert.deepEqual(envVarAsks(""), []);
  assert.deepEqual(envVarAsks(undefined), []);
});

// ── The wiring, scanned ──────────────────────────────────────────────────────
// Whether the "+" reloads the agent that asked lives in `index.html`, which no
// test can import (one script, a live WebSocket). The DECISION is pure and
// tested in test/secrets-panel.test.ts; this locks the four joins it needs, the
// way test/csp.test.ts locks the nonce and test/route-guards.test.ts the routes.
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"),
  "utf8",
);

test('wiring: the "+" records the asking agent, and only the "+"', () => {
  // openSecretFor is the + handler: it must remember the tab…
  const open = HTML.slice(HTML.indexOf("async function openSecretFor("));
  assert.match(open.slice(0, 400), /envAskTab = tab \|\| null;/);
  // …and opening the panel by hand must clear it, or a later Add would restart
  // a bystander that never asked for anything.
  const byHand = HTML.slice(HTML.indexOf("async function openSecretsPanel("));
  assert.match(byHand.slice(0, 400), /envAskTab = null;/);
});

test("wiring: both write paths settle through the plan, which consumes the tab once", () => {
  // The add/update form and the card's inline value editor.
  assert.ok(HTML.includes("settleSecretWrite(name);"), "the vault form must settle through the plan");
  assert.ok(HTML.includes("settleSecretWrite(sec.name);"), "the inline value editor too");
  const settle = HTML.slice(HTML.indexOf("function settleSecretWrite("));
  const body = settle.slice(0, settle.indexOf("\n  }"));
  // Read once: the panel stays open after an Add, and a second secret typed
  // into it has nothing to do with the agent that asked for the first.
  assert.ok(body.indexOf("envAskTab = null") > body.indexOf("const tab = envAskTab"));
  assert.ok(body.includes("window.plusReloadPlan("), "the decision is the pure plan, not an inline condition");
  // A reload happens on exactly one verdict.
  assert.equal((body.match(/reloadTab\(/g) || []).length, 1);
  assert.match(body, /plan\.action === "reload"[\s\S]*?reloadTab\(tab\)/);
});
