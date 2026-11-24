import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureSessionDir,
  rememberAccount,
  storedAccount,
  waSessionDir,
  wipeSession,
  type WaTransportEvent,
} from "../src/wa-transport.js";
import { makeFakeTransport } from "../src/wa-fake.js";

const ADA = { id: "33600000000:4@s.whatsapp.net", name: "Ada's shop", phone: "33600000000" };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wa-transport-"));
}
const mode = (p: string) => fs.statSync(p).mode & 0o777;

test("waSessionDir lives under ~/.shadok-ai/whatsapp/<instanceKey>", () => {
  assert.equal(waSessionDir("/home/x", "-srv-app"), path.join("/home/x", ".shadok-ai", "whatsapp", "-srv-app"));
});

test("ensureSessionDir creates the directory 0700", () => {
  const d = path.join(tmp(), "a", "b");
  ensureSessionDir(d);
  assert.equal(mode(d), 0o700);
});

test("ensureSessionDir re-asserts 0700 on a pre-existing 0755 directory", () => {
  const d = path.join(tmp(), "s");
  fs.mkdirSync(d, { mode: 0o755 });
  fs.chmodSync(d, 0o755);
  ensureSessionDir(d);
  assert.equal(mode(d), 0o700);
});

test("ensureSessionDir refuses a symlink in place of the directory", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "elsewhere"));
  fs.symlinkSync(path.join(root, "elsewhere"), path.join(root, "s"));
  assert.throws(() => ensureSessionDir(path.join(root, "s")));
});

test("rememberAccount then storedAccount round-trips, and the file is 0600", () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  assert.equal(storedAccount(d), null);
  rememberAccount(d, ADA, 12345);
  assert.deepEqual(storedAccount(d), { account: ADA, linkedAt: 12345 });
  assert.equal(mode(path.join(d, "account.json")), 0o600);
});

test("storedAccount reads a malformed file as no session", () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  fs.writeFileSync(path.join(d, "account.json"), "{not json");
  assert.equal(storedAccount(d), null);
  fs.writeFileSync(path.join(d, "account.json"), JSON.stringify({ account: { name: 1 }, linkedAt: "x" }));
  assert.equal(storedAccount(d), null);
});

test("wipeSession empties the directory and never follows a symlink out of it", () => {
  const root = tmp();
  const d = path.join(root, "s");
  ensureSessionDir(d);
  rememberAccount(d, ADA, 1);
  fs.mkdirSync(path.join(d, "keys"));
  fs.writeFileSync(path.join(d, "keys", "k.json"), "x");
  const outside = path.join(root, "precious.txt");
  fs.writeFileSync(outside, "keep me");
  fs.symlinkSync(outside, path.join(d, "link"));
  fs.mkdirSync(path.join(root, "outdir"));
  fs.writeFileSync(path.join(root, "outdir", "f"), "keep");
  fs.symlinkSync(path.join(root, "outdir"), path.join(d, "dirlink"));
  wipeSession(d);
  assert.deepEqual(fs.readdirSync(d), []);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep me");
  assert.equal(fs.readFileSync(path.join(root, "outdir", "f"), "utf8"), "keep");
});

test("wipeSession on a missing directory is a no-op", () => {
  wipeSession(path.join(tmp(), "nope"));
});

// ── the fake ────────────────────────────────────────────────────────────────

async function started(dir: string) {
  const fake = makeFakeTransport();
  const t = await fake.factory({ sessionDir: dir });
  const seen: WaTransportEvent[] = [];
  await t.start((e) => seen.push(e));
  return { fake, t, seen };
}

test("fake: no stored session → qr; scan → close{restart}; next start → open", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t, seen } = await started(d);
  assert.equal(seen[0].type, "qr");
  assert.equal((seen[0] as { ttlMs: number }).ttlMs, 60_000);
  fake.script.rotateQr();
  assert.equal(seen[1].type, "qr");
  assert.equal((seen[1] as { ttlMs: number }).ttlMs, 20_000);
  assert.notEqual((seen[1] as { payload: string }).payload, (seen[0] as { payload: string }).payload);
  fake.script.scan(ADA);
  assert.deepEqual(seen[2], { type: "close", reason: "restart" });
  await t.stop();
  const t2 = await fake.factory({ sessionDir: d });
  const seen2: WaTransportEvent[] = [];
  await t2.start((e) => seen2.push(e));
  assert.deepEqual(seen2, [{ type: "open", account: ADA }]);
  assert.equal(fake.starts, 2);
  assert.equal(fake.stops, 1);
});

test("fake: removeFromPhone → close{logged-out}, and the creds are gone", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t } = await started(d);
  fake.script.scan(ADA);
  await t.stop();
  const t2 = await fake.factory({ sessionDir: d });
  const seen: WaTransportEvent[] = [];
  await t2.start((e) => seen.push(e));
  fake.script.removeFromPhone();
  assert.equal(seen.at(-1)?.type, "close");
  assert.equal((seen.at(-1) as { reason: string }).reason, "logged-out");
  await t2.stop();
  const t3 = await fake.factory({ sessionDir: d });
  const seen3: WaTransportEvent[] = [];
  await t3.start((e) => seen3.push(e));
  assert.equal(seen3[0].type, "qr");
});

test("fake: goSilent emits nothing further, not even alive", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, seen } = await started(d);
  fake.script.goSilent();
  const n = seen.length;
  fake.script.rotateQr();
  fake.script.drop();
  fake.script.scan(ADA);
  assert.equal(seen.length, n);
});

test("fake: drop → close{lost}; a stopped transport emits nothing", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t, seen } = await started(d);
  fake.script.drop();
  assert.deepEqual(seen.at(-1), { type: "close", reason: "lost" });
  await t.stop();
  const n = seen.length;
  fake.script.drop();
  assert.equal(seen.length, n);
});

test("fake: offline survives a restart until online", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t } = await started(d);
  fake.script.scan(ADA);
  await t.stop();
  fake.script.offline();
  const seen: WaTransportEvent[] = [];
  const t2 = await fake.factory({ sessionDir: d });
  await t2.start((e) => seen.push(e));
  assert.deepEqual(seen, []);
  await t2.stop();
  fake.script.online();
  const t3 = await fake.factory({ sessionDir: d });
  await t3.start((e) => seen.push(e));
  assert.deepEqual(seen, [{ type: "open", account: ADA }]);
});

test("wipeSession refuses a session directory that is itself a symlink, and touches nothing behind it", () => {
  const root = tmp();
  const target = path.join(root, "elsewhere");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "precious.txt"), "keep me");
  fs.symlinkSync(target, path.join(root, "s"));
  assert.throws(() => wipeSession(path.join(root, "s")), /symlink/);
  assert.equal(fs.readFileSync(path.join(target, "precious.txt"), "utf8"), "keep me");
});

// ── the fake's message half (step 2) ────────────────────────────────────────
// The fake models WhatsApp's SERVER: a message it delivers to a connected
// device is acknowledged on receipt and gone from the server, exactly like the
// library — so a restart test can prove the bridge's own inbox is what keeps
// it. A message sent while the device is away is held and delivered on the
// next open.

async function connected(dir: string) {
  const fake = makeFakeTransport();
  let t = await fake.factory({ sessionDir: dir });
  await t.start(() => {});
  fake.script.scan(ADA);
  await t.stop();
  t = await fake.factory({ sessionDir: dir });
  const seen: WaTransportEvent[] = [];
  await t.start((e) => seen.push(e));
  return { fake, t, seen };
}

test("fake: a message to a connected device is emitted once and acknowledged", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t, seen } = await connected(d);
  fake.script.deliver({ id: "M1", chat: "100000000000001@lid", chatAlt: "33611111111@s.whatsapp.net", text: "hello", pushName: "Grace" });
  const msgs = seen.filter((e) => e.type === "message");
  assert.equal(msgs.length, 1);
  assert.equal((msgs[0] as { msg: { text: string; live: boolean; fromMe: boolean } }).msg.text, "hello");
  assert.equal((msgs[0] as { msg: { live: boolean } }).msg.live, true);
  // Acknowledged: a restart does NOT bring it back.
  await t.stop();
  const again: WaTransportEvent[] = [];
  const t2 = await fake.factory({ sessionDir: d });
  await t2.start((e) => again.push(e));
  assert.equal(again.filter((e) => e.type === "message").length, 0);
  assert.equal(fake.held, 0);
});

test("fake: a message sent while away is held, then delivered after the next open", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t } = await connected(d);
  await t.stop();
  fake.script.deliver({ id: "M2", chat: "100000000000001@lid", text: "while you were away" });
  assert.equal(fake.held, 1);
  const seen: WaTransportEvent[] = [];
  const t2 = await fake.factory({ sessionDir: d });
  await t2.start((e) => seen.push(e));
  assert.deepEqual(seen.map((e) => e.type), ["open", "message"]);
  assert.equal(fake.held, 0);
});

test("fake: sendText and setTyping are recorded, and refused while not connected", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t } = await connected(d);
  await t.sendText("100000000000001@lid", "hi");
  await t.setTyping("100000000000001@lid", true);
  assert.deepEqual(fake.sent, [{ to: "100000000000001@lid", text: "hi" }]);
  assert.deepEqual(fake.typing, [{ to: "100000000000001@lid", on: true }]);
  await t.stop();
  await assert.rejects(t.sendText("100000000000001@lid", "late"), /not connected/);
});

test("fake: resolveLid answers from what it was told", async () => {
  const d = path.join(tmp(), "s");
  ensureSessionDir(d);
  const { fake, t } = await connected(d);
  assert.equal(await t.resolveLid("33611111111@s.whatsapp.net"), null);
  fake.script.mapLid("33611111111@s.whatsapp.net", "100000000000001@lid");
  assert.equal(await t.resolveLid("33611111111@s.whatsapp.net"), "100000000000001@lid");
});
