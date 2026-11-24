import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeInWorker, workerTransportFactory } from "../src/wa-worker-host.js";
import type { WaTransportEvent } from "../src/wa-transport.js";

// The library runs in a worker thread so that an error raised inside ITS code —
// outside every try of ours — ends the worker, never the server. If either of
// the crash cases below leaked, it would take THIS test process down with it.

const LIB = new URL("./fixtures/wa-worker-lib.ts", import.meta.url).href;
const dir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-worker-")), "s");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(exportName: string, ms = 1500) {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const t = await workerTransportFactory({ modulePath: LIB, exportName })({ sessionDir: d });
  const seen: WaTransportEvent[] = [];
  await t.start((e) => seen.push(e));
  const end = Date.now() + ms;
  while (Date.now() < end && !seen.some((e) => e.type === "close")) await delay(20);
  return { t, seen, d };
}

test("events cross the worker boundary, and stop() ends the worker", async () => {
  const { t, seen } = await run("loadGood", 300);
  assert.deepEqual(seen, [{ type: "qr", payload: "worker-qr", ttlMs: 60_000 }]);
  await t.stop();
});

test("an unhandled rejection inside the library becomes close{error}; the process lives", async () => {
  const { t, seen } = await run("loadRejecting");
  const close = seen.find((e) => e.type === "close") as { reason: string; detail?: string } | undefined;
  assert.ok(close, JSON.stringify(seen));
  assert.equal(close.reason, "error");
  assert.match(close.detail ?? "", /boom inside the library's socket code/);
  await t.stop(); // stopping a dead worker is fine
});

test("an uncaught exception inside the library becomes close{error}; the process lives", async () => {
  const { t, seen } = await run("loadThrowing");
  const close = seen.find((e) => e.type === "close") as { reason: string; detail?: string } | undefined;
  assert.ok(close, JSON.stringify(seen));
  assert.match(close.detail ?? "", /uncaught inside the library/);
  await t.stop();
});

test("exactly one close per dead worker", async () => {
  const { t, seen } = await run("loadRejecting");
  await delay(200);
  assert.equal(seen.filter((e) => e.type === "close").length, 1);
  await t.stop();
});

test("the probe reports a library that cannot load, with its message", async () => {
  await probeInWorker({ modulePath: LIB, exportName: "loadGood" });
  await assert.rejects(probeInWorker({ modulePath: LIB, exportName: "loadAbsent" }), /Cannot find package 'baileys'/);
});

test("no process-level handler is installed: errors from elsewhere behave as before", () => {
  const src = fs.readdirSync(new URL("../src", import.meta.url))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(src, /process\.on\(\s*["'](unhandledRejection|uncaughtException)/);
});

test("sendText, setTyping and resolveLid cross the worker boundary, with their answers", async () => {
  const { t, seen } = await run("loadGood", 300);
  await t.sendText("100000000000001@lid", "hi there");
  await t.setTyping("100000000000001@lid", true);
  assert.equal(await t.resolveLid("33611111111@s.whatsapp.net"), "100000000000001@lid");
  assert.equal(await t.resolveLid("33622222222@s.whatsapp.net"), null);
  // The stand-in echoes what it was asked to send as an event, to prove the call arrived.
  assert.ok(seen.some((e) => e.type === "message" && (e as { msg: { text?: string } }).msg.text === "sent:hi there"));
  await t.stop();
});

test("downloadMedia brings bytes back across the worker; sendFile carries them there", async () => {
  const { t, seen } = await run("loadGood", 300);
  assert.equal(Buffer.from(await t.downloadMedia("P1")).toString(), "bytes-of-P1");
  await t.sendFile("100000000000001@lid", { data: Buffer.from("abc"), name: "a.pdf", mime: "application/pdf", image: false });
  assert.ok(seen.some((e) => e.type === "message" && (e as { msg: { text?: string } }).msg.text === "file:a.pdf:3"));
  await t.stop();
});
