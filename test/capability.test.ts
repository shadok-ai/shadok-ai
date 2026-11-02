import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountsEnabled,
  deploymentMode,
  isolationRefusal,
  probeCanProvision,
} from "../src/capability.js";

test("deploymentMode is multi-tenant only when both hold", () => {
  assert.equal(deploymentMode({ canProvision: true, accountsEnabled: true }), "multi-tenant");
  assert.equal(deploymentMode({ canProvision: true, accountsEnabled: false }), "mono-tenant");
  assert.equal(deploymentMode({ canProvision: false, accountsEnabled: true }), "mono-tenant");
  assert.equal(deploymentMode({ canProvision: false, accountsEnabled: false }), "mono-tenant");
});

test("probeCanProvision honours the force override both ways", () => {
  const canSudo = () => { throw new Error("must not probe"); };
  assert.equal(probeCanProvision({ env: { SHADOK_FORCE_MULTITENANT: "1" }, getuid: () => 1000, canSudo }), true);
  assert.equal(probeCanProvision({ env: { SHADOK_FORCE_MULTITENANT: "0" }, getuid: () => 0, canSudo }), false);
});

test("probeCanProvision is true as root without probing sudo", () => {
  assert.equal(probeCanProvision({ env: {}, getuid: () => 0, canSudo: () => { throw new Error("no"); } }), true);
});

test("probeCanProvision falls to canSudo for non-root or unknown uid", () => {
  assert.equal(probeCanProvision({ env: {}, getuid: () => 1000, canSudo: () => true }), true);
  assert.equal(probeCanProvision({ env: {}, getuid: () => 1000, canSudo: () => false }), false);
  assert.equal(probeCanProvision({ env: {}, getuid: () => undefined, canSudo: () => false }), false);
});

test("accountsEnabled needs a non-blank password", () => {
  assert.equal(accountsEnabled(""), false);
  assert.equal(accountsEnabled("   "), false);
  assert.equal(accountsEnabled("x"), true);
});

test("isolationRefusal words the refusal per mode", () => {
  assert.equal(isolationRefusal("mono-tenant"), "isolation requires the privileged deployment");
  assert.equal(isolationRefusal("multi-tenant"), null);
});
