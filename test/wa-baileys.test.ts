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

// ── no write after stop ─────────────────────────────────────────────────────
import os from "node:os";
import { EventEmitter } from "node:events";
import { makeBaileysTransport } from "../src/wa-baileys.js";
import { ensureSessionDir, wipeSession } from "../src/wa-transport.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the library whose credential writes land LATE, through both
 *  of its write paths: `saveCreds` (on creds.update) and `keys.set` (signal
 *  keys, written by the library itself whenever it likes). */
function lateWritingLib() {
  let auth: { keys: { set(d: unknown): Promise<void> } } | null = null;
  const ev = new EventEmitter();
  const lib = {
    async useMultiFileAuthState(dir: string) {
      return {
        state: {
          creds: {},
          keys: {
            get: async () => ({}),
            set: async () => { await delay(40); fs.writeFileSync(path.join(dir, `key-${Date.now()}-${Math.random()}.json`), "k"); },
          },
        },
        saveCreds: async () => { await delay(40); fs.writeFileSync(path.join(dir, "creds.json"), "c"); },
      };
    },
    default: (cfg: { auth: typeof auth }) => {
      auth = cfg.auth;
      return { ev, ws: new EventEmitter(), user: undefined, logout: async () => {}, end: () => {} };
    },
    Browsers: { ubuntu: () => ["Ubuntu", "Chrome", "1"] },
  };
  return { lib, ev, keys: () => auth!.keys };
}

test("after stop, the adapter writes nothing: in-flight writes are awaited, later ones dropped", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-late-")), "s");
  ensureSessionDir(dir);
  const { lib, ev, keys } = lateWritingLib();
  const t = makeBaileysTransport(lib as never, dir);
  await t.start(() => {});
  // Two writes in flight when the unlink begins.
  ev.emit("creds.update", {});
  void keys().set({ "pre-key": { 1: {} } });
  await t.stop(); // must not resolve before those two have landed
  wipeSession(dir);
  assert.deepEqual(fs.readdirSync(dir), []);
  // The library is still holding references and keeps trying to write.
  ev.emit("creds.update", {});
  await keys().set({ "pre-key": { 2: {} } });
  await delay(120);
  assert.deepEqual(fs.readdirSync(dir), [], "a late write recreated credentials after the wipe");
});

test("writes keep landing across a restart-required close (the creds that finish a pairing)", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-late-")), "s");
  ensureSessionDir(dir);
  const { lib, ev } = lateWritingLib();
  const t = makeBaileysTransport(lib as never, dir);
  await t.start(() => {});
  ev.emit("creds.update", {});
  ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await t.stop();
  assert.ok(fs.existsSync(path.join(dir, "creds.json")), "the pairing's creds must be saved, not dropped by the close");
});

import { qrSvg } from "../src/wa-baileys.js";

test("qrSvg draws an SVG, and names the reason when the encoder is missing", async () => {
  const ok = await qrSvg("payload");
  assert.ok("svg" in ok && ok.svg.startsWith("<svg"));
  const missing = await qrSvg("payload", async () => { throw new Error("Cannot find package 'qrcode'"); });
  assert.ok("error" in missing);
  assert.match(missing.error, /qrcode/);
});
