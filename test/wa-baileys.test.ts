import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accountOf, closeDetailOf, closeReasonOf } from "../src/wa-baileys.js";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

test("closeReasonOf maps the library's status codes (its whole DisconnectReason list)", () => {
  assert.equal(closeReasonOf(515), "restart");
  assert.equal(closeReasonOf(401), "logged-out");
  for (const c of [408, 428, 503]) assert.equal(closeReasonOf(c), "lost");
  // Permanent: retrying them every minute changes nothing, or makes it worse
  // (440: two instances on one number evict each other for ever).
  for (const c of [403, 440, 411, 500]) assert.equal(closeReasonOf(c), "fatal");
  for (const c of [undefined, 400, 999]) assert.equal(closeReasonOf(c), "error");
});

test("closeDetailOf names each permanent stop so the panel can say it", () => {
  assert.match(closeDetailOf(403)!, /refused|banned|restricted/i);
  assert.match(closeDetailOf(440)!, /replaced|elsewhere/i);
  assert.match(closeDetailOf(411)!, /link .*again/i);
  assert.match(closeDetailOf(500)!, /session/i);
  assert.match(closeDetailOf(401)!, /removed|logged out|closed/i);
});

test("accountOf takes the digits before ':' or '@' as the phone", () => {
  assert.deepEqual(accountOf({ id: "33600000000:12@s.whatsapp.net", name: "Ada's shop" }), {
    id: "33600000000:12@s.whatsapp.net",
    name: "Ada's shop",
    phone: "33600000000",
  });
  assert.deepEqual(accountOf({ id: "33600000000@s.whatsapp.net" }), { id: "33600000000@s.whatsapp.net", phone: "33600000000" });
  assert.equal(accountOf(undefined), null);
  assert.equal(accountOf({}), null);
  assert.deepEqual(accountOf({ id: "abc@lid" }), { id: "abc@lid" });
});

test("only the adapter names the library", () => {
  // A dynamic specifier would slip past `import("baileys")`, so the scan looks
  // for the quoted package name itself.
  const offenders: string[] = [];
  for (const f of fs.readdirSync(SRC_DIR)) {
    if (!f.endsWith(".ts") || f === "wa-baileys.ts") continue;
    const src = fs.readFileSync(path.join(SRC_DIR, f), "utf8");
    if (/["'`]baileys["'`/]/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("the adapter loads the library lazily, never with a static import", () => {
  const src = fs.readFileSync(path.join(SRC_DIR, "wa-baileys.ts"), "utf8");
  assert.doesNotMatch(src, /^import[^;]*from\s+["']baileys["']/m);
  assert.doesNotMatch(src, /^import[^;]*from\s+["']qrcode["']/m);
  // Pairing by code is broken upstream; the QR is the only path.
  assert.doesNotMatch(src, /requestPairingCode\(/);
});

test("the library is an OPTIONAL dependency, the version pinned exactly", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "..", "package.json"), "utf8"));
  assert.equal(pkg.optionalDependencies?.baileys, "7.0.0-rc14");
  assert.ok(pkg.optionalDependencies?.qrcode);
  assert.equal(pkg.dependencies?.baileys, undefined);
  assert.equal(pkg.dependencies?.qrcode, undefined);
});
