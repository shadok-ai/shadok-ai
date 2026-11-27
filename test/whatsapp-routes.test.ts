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
  // A failed or empty unlink is never answered "ok".
  assert.match(r, /if \(!r\.ok\) return res\.status\(r\.nothing \? 409 : 500\)/);
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
  // The real library is loaded from the installed copy in the data directory.
  assert.match(call, /loadFactory: waFake \? async \(\) => waFake\.factory : async \(\) => loadBaileysFactory\(lib\.entryUrl\(\)\)/);
  assert.match(call, /library: lib,/);
});

test("the library is installed into the DATA directory — never the app's node_modules — and faked only behind SHADOK_WA_FAKE=1", () => {
  const i = SRC.indexOf("function startWhatsAppHandle");
  const body = SRC.slice(i, SRC.indexOf("\n}\n", i));
  assert.match(body, /root: waFake \? `\$\{waLibRoot\(os\.homedir\(\)\)\}-fake` : waLibRoot\(os\.homedir\(\)\)/);
  assert.match(body, /\.\.\.\(waFake \? \{ run: fakeInstallRunner\(/);
});

test("GET /whatsapp says whether the library is installed, so the panel can warn before the first Link", () => {
  const r = route('app.get("/whatsapp",');
  assert.match(r, /out\.library = waLib\(\)\?\.status\(\)/);
});

test("server.ts never names the library", () => {
  assert.doesNotMatch(SRC, /["'`]baileys["'`]/);
});

test("POST /whatsapp/retry is an admin write from a browser, refused with the reason", () => {
  const r = route('app.post("/whatsapp/retry",');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /\.retry\(\)/);
  assert.match(r, /status\(409\)/);
});

test("GET /whatsapp says whether a session is stored, so the panel can offer Unlink in every phase", () => {
  const r = route('app.get("/whatsapp",');
  assert.match(r, /out\.stored = wa\.hasStoredSession\(\)/);
});

test("a deliberate exit releases the WhatsApp resume breaker; a crash does not", () => {
  assert.match(SRC, /process\.on\("exit", \(code\) => \{\n\s+if \(code === 0 \|\| code === UPDATE_EXIT_CODE \|\| code === RELOAD_EXIT_CODE\) waHandleRef\?\.releaseResumeGuard\(\);/);
});

test("GET /whatsapp passes on why a QR could not be drawn", () => {
  const r = route('app.get("/whatsapp",');
  assert.match(r, /out\.qrError = drawn\.error/);
});

// ── step 2: the bridge's identity and the guest door ────────────────────────

test("the WhatsApp bridge proves its own per-process secret, and that alone makes it whatsapp", () => {
  assert.match(SRC, /const WHATSAPP_BRIDGE_SECRET = randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(SRC, /const isWhatsAppBridge = presentsSecret\(req, "x-shadok-wa-bridge", WHATSAPP_BRIDGE_SECRET\)/);
  assert.match(SRC, /whatsappBridge: isWhatsAppBridge,/);
});

test("a guest spawn reads the setup of the bridge the socket PROVED, and names the wa- directory", () => {
  // One read of the door, shared by the spawn plan and the admission ceiling:
  // a WhatsApp socket never spawns on the Telegram door's profile, nor the
  // reverse, and the ceiling is the same door's.
  assert.match(SRC, /\? waGuestSetupForCwd\(loadConfig\(\), process\.cwd\(\)\)\s*\n\s*: guestSetupForCwd\(loadConfig\(\), process\.cwd\(\)\)/);
  assert.match(SRC, /fromBridge: isWhatsAppBridge \|\| isTelegramBridge,\s*\n\s*resuming: !!msg\.resume,\s*\n\s*setup: doorSetup,/);
  assert.match(
    SRC,
    /guestDir = isWhatsAppBridge \? waGuestWorkDirName\(msg\.guestKey\) : guestWorkDirName\(msg\.guestKey\);\s*\n[^\n]*\n[^\n]*\n[^\n]*\n\s*if \(!guestDir\) return fail\([^)]*"guest-key"\)/,
  );
});

test("the server refuses a bare slash command from the whatsapp origin", () => {
  const i = SRC.indexOf('case "prompt": {');
  const body = SRC.slice(i, SRC.indexOf('case "run": {', i));
  assert.match(body, /if \(origin === "whatsapp" && isSlashCommand\(text\)\)\s*return fail\([^)]*"command-refused"\)/);
  // …and the refusal sits BEFORE anything is submitted.
  assert.ok(body.indexOf('"command-refused"') < body.indexOf("submitRecovering("));
  // A WhatsApp prompt carries the context header, and may say it was spoken.
  assert.match(body, /origin === "telegram" \|\| origin === "whatsapp" \|\| origin === "cli"/);
  assert.match(body, /msg\.voice === true && \(origin === "telegram" \|\| origin === "whatsapp"\)/);
});

test("PUT /whatsapp/guests is an admin browser write, refused while unavailable, run through the shared flow", () => {
  const r = route('app.put("/whatsapp/guests",');
  assert.match(r, /accountAdmin\(req, res, true,/);
  assert.match(r, /migratedIsolationRefusal\(DEPLOYMENT_MODE, groupsMigrated\)/);
  assert.match(r, /guestPatchFlow\(/);
  assert.match(r, /other: guestSetupForCwd\(loadConfig\(\), cwd\)/);
  assert.match(r, /if \(flow\.handOver\)/);
});

test("PUT /telegram passes the WhatsApp door as the other one", () => {
  const r = route('app.put("/telegram",');
  assert.match(r, /other: waGuestSetupForCwd\(loadConfig\(\), cwd\)/);
  assert.match(r, /if \(flow\.handOver\)/);
});

test("GET /whatsapp carries the guest door and the groups this admin may choose", () => {
  const r = route('app.get("/whatsapp",');
  assert.match(r, /out\.guests = waGuestSetupForCwd\(loadConfig\(\), process\.cwd\(\)\)/);
  assert.match(r, /guestGroupChoices\(loadGroups\(\), viewerFor\(currentAccount\(req\)\)\)/);
});
