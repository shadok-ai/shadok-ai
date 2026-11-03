import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server.ts is un-importable (side effects at import); lock the wiring by scan,
// the same discipline as test/migrate-groups.test.ts / test/ws-url.test.ts.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, "..", "src", "server.ts"), "utf8");

test("server: both /mt-token routes are wired", () => {
  assert.ok(/app\.post\("\/mt-token\/start"/.test(SERVER), "/mt-token/start POST present");
  assert.ok(/app\.post\("\/mt-token\/code"/.test(SERVER), "/mt-token/code POST present");
});

test("server: the provisioning gate is multi-tenant + browser-origin + admin", () => {
  const gate = SERVER.slice(SERVER.indexOf("function mtTokenGate"));
  const body = gate.slice(0, gate.indexOf("\n}\n"));
  assert.ok(/DEPLOYMENT_MODE !== "multi-tenant"/.test(body), "mono-tenant is refused (not applicable)");
  assert.ok(/requestFromBrowser\(req\)/.test(body), "non-browser callers are refused");
  assert.ok(/currentAccount\(req\)\?\.role !== "admin"/.test(body), "non-admins are refused");
});

test("server: the code route stores the token via setSecret under the reserved name, and never returns it", () => {
  const route = SERVER.slice(SERVER.indexOf('app.post("/mt-token/code"'));
  const handler = route.slice(0, route.indexOf("\n});"));
  // The token reaches the vault ONLY through the store callback.
  assert.ok(
    /submitSetupTokenCode\(\s*code,\s*\(token\)\s*=>\s*\n?\s*setSecret\(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID/.test(
      handler.replace(/\s+/g, " "),
    ) || /submitSetupTokenCode\(code, \(token\) => setSecret\(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID/.test(handler.replace(/\s+/g, " ")),
    "token is stored via setSecret(MT_CLAUDE_OAUTH_TOKEN_NAME, token, MAIN_GROUP_ID, …)",
  );
  // The response is the ok/err verdict object, not the token.
  assert.ok(/res\.status\(r\.ok \? 200 : 400\)\.json\(r\)/.test(handler), "responds with the verdict, never the token");
  assert.ok(!/\.token/.test(handler.replace(/\(token\) =>/g, "")), "the handler never reads a .token field into the response");
});

test("server: a successful mint invalidates the auth cache and clears the token warning", () => {
  const route = SERVER.slice(SERVER.indexOf('app.post("/mt-token/code"'));
  const handler = route.slice(0, route.indexOf("\n});"));
  assert.ok(/invalidateAuthStatus\(\)/.test(handler), "auth status cache invalidated so /auth re-reports longLived");
  assert.ok(/mtTokenWarned = false/.test(handler), "the token-missing warning can fire again");
});
