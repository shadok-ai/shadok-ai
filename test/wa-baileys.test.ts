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

test("the adapter never imports the packages by bare name: only through the data directory's loader", () => {
  // A bare import would resolve from the APP's node_modules, which no longer
  // carries the library (it is installed on demand, src/wa-library.ts) — and
  // would silently use a stray copy where one happens to be.
  const src = fs.readFileSync(path.join(SRC_DIR, "wa-baileys.ts"), "utf8");
  assert.doesNotMatch(src, /import\(\s*(LIB|QR_LIB)\s*\)/);
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

test("markRead sends ONE read receipt for that message, in the chat it arrived on — through the library's privacy-aware call", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-read-")), "s");
  ensureSessionDir(dir);
  const { lib } = lateWritingLib();
  const reads: unknown[] = [];
  const make = lib.default;
  // `readMessages` (not a raw `sendReceipt`): it is the call that downgrades
  // to `read-self` when the phone's owner turned read receipts off.
  lib.default = ((cfg: never) => Object.assign(make(cfg), { readMessages: async (keys: unknown[]) => void reads.push(keys) })) as never;
  const t = makeBaileysTransport(lib as never, dir);
  await t.start(() => {});
  await t.markRead("33611111111@s.whatsapp.net", "M1");
  assert.deepEqual(reads, [[{ remoteJid: "33611111111@s.whatsapp.net", id: "M1", fromMe: false }]]);
  await t.stop();
  await assert.rejects(t.markRead("33611111111@s.whatsapp.net", "M2"), /not connected/);
});

import { pathToFileURL } from "node:url";
import { loadBaileysFactory, qrLoaderFrom, qrSvg } from "../src/wa-baileys.js";
import type { WaTransportEvent } from "../src/wa-transport.js";

const SHIP_LOAD = path.join(SRC_DIR, "..", "context", "whatsapp-lib", "load.mjs");

/** A library directory as the installer leaves it — the shipped loader beside
 *  a node_modules — holding STUBS whose output names where they came from. */
function stubLibDir(withPackages = true): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wa-libdir-"));
  fs.copyFileSync(SHIP_LOAD, path.join(d, "load.mjs"));
  if (!withPackages) return d;
  const pkg = (name: string, type: string, main: string, code: string) => {
    fs.mkdirSync(path.join(d, "node_modules", name), { recursive: true });
    fs.writeFileSync(path.join(d, "node_modules", name, "package.json"), JSON.stringify({ name, version: "0.0.0-stub", type, main }));
    fs.writeFileSync(path.join(d, "node_modules", name, main), code);
  };
  pkg(
    "baileys",
    "module",
    "index.js",
    `import { EventEmitter } from "node:events";
export default function makeSocket() {
  const ev = new EventEmitter();
  setTimeout(() => ev.emit("connection.update", { qr: "stub-qr-from-the-data-dir" }), 10);
  return { ev, ws: new EventEmitter(), logout: async () => {}, end() {} };
}
export async function useMultiFileAuthState() {
  return { state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } }, saveCreds: async () => {} };
}
export const Browsers = { ubuntu: () => ["Ubuntu", "Chrome", "1"] };
`,
  );
  pkg("qrcode", "commonjs", "index.js", `exports.toString = async (t) => "<svg>stub:" + t + "</svg>";\n`);
  return d;
}
const entryOf = (d: string) => pathToFileURL(path.join(d, "load.mjs")).href;

test("the library is loaded from the DATA directory, inside the worker", async () => {
  const t = await (await loadBaileysFactory(entryOf(stubLibDir())))({ sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), "wa-s-")) });
  const seen: WaTransportEvent[] = [];
  await t.start((e) => seen.push(e));
  for (let i = 0; i < 100 && !seen.some((e) => e.type === "qr"); i++) await delay(20);
  await t.stop();
  assert.ok(seen.some((e) => e.type === "qr" && e.payload === "stub-qr-from-the-data-dir"), JSON.stringify(seen));
});

test("a data directory without the packages: the load is refused with a reason, and no path leaks", async () => {
  const d = stubLibDir(false);
  await assert.rejects(loadBaileysFactory(entryOf(d)), (e: Error) => /not installed or failed to load/.test(e.message) && !e.message.includes(d));
});

test("qrSvg draws through the data directory's encoder, and names the reason when it is missing", async () => {
  const ok = await qrSvg("payload", qrLoaderFrom(() => entryOf(stubLibDir())));
  assert.deepEqual(ok, { svg: "<svg>stub:payload</svg>" });
  const missing = await qrSvg("payload", qrLoaderFrom(() => entryOf(stubLibDir(false))));
  assert.ok("error" in missing);
  assert.match(missing.error, /qrcode/);
  const notInstalled = await qrSvg("payload", qrLoaderFrom(() => { throw new Error("the WhatsApp library is not installed on this instance"); }));
  assert.ok("error" in notInstalled);
});

// ── inbound messages (step 2) ───────────────────────────────────────────────
import { inboundOf } from "../src/wa-baileys.js";

test("inboundOf maps a library message to the neutral shape", () => {
  const m = {
    key: { remoteJid: "100000000000001@lid", remoteJidAlt: "33611111111@s.whatsapp.net", fromMe: false, id: "3EB0A1" },
    message: { conversation: "hello" },
    pushName: "Grace",
    messageTimestamp: 1_700_000_000,
  };
  assert.deepEqual(inboundOf(m, "notify"), {
    id: "3EB0A1",
    chat: "100000000000001@lid",
    chatAlt: "33611111111@s.whatsapp.net",
    fromMe: false,
    live: true,
    unreadable: false,
    text: "hello",
    pushName: "Grace",
    at: 1_700_000_000_000,
  });
});

test("inboundOf: extended text, disappearing messages, a history replay, an undecryptable stub", () => {
  const key = { remoteJid: "33611111111@s.whatsapp.net", fromMe: false, id: "X" };
  assert.equal(inboundOf({ key, message: { extendedTextMessage: { text: "with a link" } } }, "notify")?.text, "with a link");
  assert.equal(
    inboundOf({ key, message: { ephemeralMessage: { message: { extendedTextMessage: { text: "vanishing" } } } } }, "notify")?.text,
    "vanishing",
  );
  assert.equal(inboundOf({ key, message: { conversation: "old" } }, "append")?.live, false);
  // Finding 3 of the spike: the stanza arrives with no ciphertext for us.
  const stub = inboundOf({ key, messageStubType: 2 }, "notify");
  assert.equal(stub?.unreadable, true);
  assert.equal(stub?.text, undefined);
  assert.equal(inboundOf({ key: { fromMe: false } }, "notify"), null);
  assert.equal(inboundOf(null, "notify"), null);
});

test("inboundOf describes a picture, a document, a voice note and a video, with their captions", () => {
  const key = { remoteJid: "100000000000001@lid", fromMe: false, id: "X" };
  assert.deepEqual(inboundOf({ key, message: { imageMessage: { mimetype: "image/jpeg", caption: "receipt", fileLength: 2048 } } }, "notify")?.media, {
    kind: "image",
    mime: "image/jpeg",
    size: 2048,
  });
  assert.equal(inboundOf({ key, message: { imageMessage: { caption: "receipt" } } }, "notify")?.text, "receipt");
  assert.deepEqual(
    inboundOf({ key, message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: "application/pdf", fileName: "price list.pdf", caption: "here", fileLength: "10" } } } } }, "notify")?.media,
    { kind: "document", mime: "application/pdf", fileName: "price list.pdf", size: 10 },
  );
  assert.deepEqual(inboundOf({ key, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } } }, "notify")?.media, {
    kind: "audio",
    mime: "audio/ogg; codecs=opus",
    voice: true,
  });
  assert.equal(inboundOf({ key, message: { videoMessage: { mimetype: "video/mp4" } } }, "notify")?.media?.kind, "video");
  assert.equal(inboundOf({ key, message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } } }, "notify")?.media?.kind, "image");
  assert.equal(inboundOf({ key, message: { conversation: "plain" } }, "notify")?.media, undefined);
});
