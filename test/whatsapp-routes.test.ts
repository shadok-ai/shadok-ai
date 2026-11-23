import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// server.ts is un-importable, so the routes' SHAPE is locked by scan (like
// test/tg-guests-routes.test.ts); the decisions behind them are unit-tested
// for real in test/whatsapp-handle.test.ts and test/wa-link.test.ts.
const SRC = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
function route(sig: string): string {
  const i = SRC.indexOf(sig);
  assert.ok(i >= 0, `missing ${sig}`);
  return SRC.slice(i, SRC.indexOf("\n});", i));
}

test("POST /whatsapp/link is an admin write from a browser, refused with the reason", () => {
  const r = route('app.post("/whatsapp/link",');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /\.link\(\)/);
  assert.match(r, /status\(409\)/);
});

test("DELETE /whatsapp/link is an admin write from a browser: cancel while linking, unlink otherwise", () => {
  const r = route('app.delete("/whatsapp/link",');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /\.cancel\(\)/);
  assert.match(r, /\.unlink\(\)/);
});

test("GET /whatsapp: admin read; the QR only for a cookie-authenticated person", () => {
  const r = route('app.get("/whatsapp",');
  assert.match(r, /accountAdmin\(req, res, false,/);
  assert.match(r, /const forPerson = cookieAccount\(req\)\?\.role === "admin"/);
  assert.match(r, /linkView\(wa\.state\(\), Date\.now\(\), forPerson\)/);
  // The SVG is drawn only when the view carries a QR, which it does only for a person.
  assert.match(r, /if \(forPerson && typeof view\.qr === "string"\)/);
  // The raw payload never leaves: only its drawing does.
  assert.match(r, /delete out\.qr/);
});

test("the fake transport's script routes exist only behind SHADOK_WA_FAKE=1, and are admin browser writes", () => {
  const r = route('app.post("/whatsapp/fake/:action",');
  assert.match(r, /if \(!waFake\) return res\.status\(404\)/);
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(SRC, /const waFake = process\.env\.SHADOK_WA_FAKE === "1" \? makeFakeTransport\(\) : null;/);
});

test("the handle receives the capability refusal, migrated half included, re-read live", () => {
  const i = SRC.indexOf("startWhatsApp({");
  assert.ok(i >= 0);
  const call = SRC.slice(i, SRC.indexOf("\n  });", i));
  assert.match(call, /refusal: \(\) => migratedIsolationRefusal\(DEPLOYMENT_MODE, groupsMigrated\)/);
  assert.match(call, /loadFactory: waFake \? async \(\) => waFake\.factory : loadBaileysFactory/);
});

test("server.ts never names the library", () => {
  assert.doesNotMatch(SRC, /["'`]baileys["'`]/);
});
