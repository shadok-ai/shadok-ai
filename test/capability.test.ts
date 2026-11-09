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
  assert.equal(probeCanProvision({ platform: "linux", env: {}, getuid: () => 0, canSudo: () => { throw new Error("no"); } }), true);
});

test("probeCanProvision falls to canSudo for non-root or unknown uid", () => {
  assert.equal(probeCanProvision({ platform: "linux", env: {}, getuid: () => 1000, canSudo: () => true }), true);
  assert.equal(probeCanProvision({ platform: "linux", env: {}, getuid: () => 1000, canSudo: () => false }), false);
  assert.equal(probeCanProvision({ platform: "linux", env: {}, getuid: () => undefined, canSudo: () => false }), false);
});

test("probeCanProvision never auto-enables multi-tenant off Linux, even as root", () => {
  // Group isolation uses Linux-only tooling (useradd/setpriv/runuser): a macOS
  // or Windows host with root + a password must stay mono-tenant, or the boot
  // migration fails on the first `useradd` and shows the red "isolation did NOT
  // complete" banner. The probe (not deploymentMode) is where this is decided.
  const canSudo = () => { throw new Error("must not probe off Linux"); };
  assert.equal(probeCanProvision({ platform: "darwin", env: {}, getuid: () => 0, canSudo }), false);
  assert.equal(probeCanProvision({ platform: "win32", env: {}, getuid: () => 0, canSudo }), false);
  // Even a passwordless-sudo macOS user never auto-enables it.
  assert.equal(probeCanProvision({ platform: "darwin", env: {}, getuid: () => 1000, canSudo: () => true }), false);
});

test("probeCanProvision: the explicit force override still wins off Linux", () => {
  // The escape hatch for tests / unusual setups is deliberate and checked before
  // the platform gate, so an operator who sets it keeps control.
  assert.equal(
    probeCanProvision({ platform: "darwin", env: { SHADOK_FORCE_MULTITENANT: "1" }, getuid: () => 1000, canSudo: () => false }),
    true,
  );
  assert.equal(
    probeCanProvision({ platform: "linux", env: { SHADOK_FORCE_MULTITENANT: "0" }, getuid: () => 0, canSudo: () => true }),
    false,
  );
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

test("requireCapable: mono-tenant answers 400 + honest message and returns false; multi-tenant passes untouched", async () => {
  const { requireCapable } = await import("../src/capability.js");
  const calls: Array<[number, unknown]> = [];
  const res = { status: (c: number) => ({ json: (b: unknown) => void calls.push([c, b]) }) };
  assert.equal(requireCapable("mono-tenant", res), false);
  assert.deepEqual(calls, [[400, { error: "isolation requires the privileged deployment" }]]);
  calls.length = 0;
  assert.equal(requireCapable("multi-tenant", res), true);
  assert.equal(calls.length, 0);
});
