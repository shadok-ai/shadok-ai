import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWhatsApp, type WhatsAppHandle } from "../src/whatsapp.js";
import { makeFakeTransport } from "../src/wa-fake.js";
import { ensureSessionDir, rememberAccount, storedAccount, type WaTransportFactory } from "../src/wa-transport.js";
import { LINK_TIMEOUT_MS, LIVENESS_MS, type WaAccount } from "../src/wa-link.js";

const ADA: WaAccount = { id: "33600000000:4@s.whatsapp.net", name: "Ada's shop", phone: "33600000000" };

/** A clock and a timer queue the test advances by hand. */
function clock() {
  let t = 1_000_000;
  let timers: { at: number; fn: () => void; dead: boolean }[] = [];
  return {
    now: () => t,
    setTimer(fn: () => void, ms: number) {
      const rec = { at: t + ms, fn, dead: false };
      timers.push(rec);
      return { cancel: () => void (rec.dead = true) };
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        due.dead = true;
        due.fn();
        await flush();
      }
      t = end;
      timers = timers.filter((x) => !x.dead);
      await flush();
    },
    pending: () => timers.filter((x) => !x.dead).length,
  };
}
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** The on-demand library, by hand: `finish()` / `fail()` end the install. */
function fakeLibrary(initial: "ready" | "absent" | "stale" = "absent") {
  let st = initial;
  const calls: { force?: boolean }[] = [];
  let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  return {
    lib: {
      status: () => st,
      install(o?: { force?: boolean }) {
        calls.push(o ?? {});
        return new Promise<void>((resolve, reject) => {
          pending = { resolve, reject };
        });
      },
    },
    calls,
    set: (v: typeof st) => void (st = v),
    finish() {
      st = "ready";
      pending!.resolve();
    },
    fail(msg: string) {
      pending!.reject(new Error(msg));
    },
  };
}

function setup(o: { refusal?: string | null | (() => string | null); loadFactory?: () => Promise<WaTransportFactory>; dir?: string; fake?: ReturnType<typeof makeFakeTransport>; library?: ReturnType<typeof fakeLibrary>["lib"] } = {}) {
  const dir = o.dir ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-handle-")), "s");
  const fake = o.fake ?? makeFakeTransport();
  const c = clock();
  const lines: string[] = [];
  const h = startWhatsApp({
    sessionDir: dir,
    refusal: o.refusal ?? null,
    loadFactory: o.loadFactory ?? (async () => fake.factory),
    ...(o.library ? { library: o.library } : {}),
    now: c.now,
    setTimer: c.setTimer,
    log: (l) => lines.push(l),
  });
  return { dir, fake, c, lines, h };
}

async function linkAndScan(h: WhatsAppHandle, fake: ReturnType<typeof makeFakeTransport>) {
  assert.deepEqual(h.link(), { ok: true });
  await flush();
  assert.equal(h.state().phase, "linking");
  fake.script.scan(ADA);
  await flush();
}

// ── the five Review Focus cases ─────────────────────────────────────────────

test("restart-required right after a scan: linking → connected, never a failure in between", async () => {
  const { h, fake, lines } = setup();
  const phases: string[] = [];
  assert.deepEqual(h.link(), { ok: true });
  await flush();
  phases.push(h.state().phase);
  const st = h.state() as { qr?: string };
  assert.ok(st.qr, "the QR reached the state");
  fake.script.scan(ADA);
  phases.push(h.state().phase);
  await flush();
  phases.push(h.state().phase);
  assert.deepEqual(phases, ["linking", "linking", "connected"]);
  assert.ok(!lines.some((l) => /→ (reconnecting|logged-out|unlinked|unavailable)/.test(l)), lines.join("\n"));
  // The old transport was stopped before the new one started.
  assert.equal(fake.starts, 2);
  assert.equal(fake.stops, 1);
});

test("a QR nobody scans: linking expires to unlinked and the transport is stopped for good", async () => {
  const { h, fake, c } = setup();
  h.link();
  await flush();
  await c.advance(LINK_TIMEOUT_MS + 16_000);
  assert.equal(h.state().phase, "unlinked");
  assert.equal(fake.starts, 1);
  assert.equal(fake.stops, 1);
  // Nothing keeps reconnecting in the background.
  await c.advance(10 * 60_000);
  assert.equal(fake.starts, 1);
});

test("a dead socket without a logout leaves connected within a bounded time", async () => {
  const { h, fake, c } = setup();
  await linkAndScan(h, fake);
  assert.equal(h.state().phase, "connected");
  fake.script.goSilent();
  // The tick is 15 s, so the bound is LIVENESS_MS + one tick.
  await c.advance(LIVENESS_MS + 15_000);
  assert.equal(h.state().phase, "reconnecting");
  // …and it does try to reconnect, through a fresh transport.
  const before = fake.starts;
  await c.advance(5_000);
  assert.equal(fake.starts, before + 1);
  assert.equal(h.state().phase, "connected");
});

test("alive keeps a quiet link connected", async () => {
  const { h, fake, c } = setup();
  await linkAndScan(h, fake);
  for (let i = 0; i < 6; i++) {
    await c.advance(30_000);
    fake.script.ping();
  }
  assert.equal(h.state().phase, "connected");
});

test("unlink while reconnecting: one transport at most, and the session is gone even if logout fails", async () => {
  const { h, fake, c, dir } = setup();
  await linkAndScan(h, fake);
  fake.script.drop();
  await flush();
  assert.equal(h.state().phase, "reconnecting");
  fake.script.failNextLogout();
  await h.unlink();
  assert.equal(h.state().phase, "unlinked");
  assert.deepEqual(fs.readdirSync(dir), []);
  const starts = fake.starts;
  await c.advance(5 * 60_000);
  assert.equal(fake.starts, starts, "the pending reconnect was cancelled");
  assert.equal(fake.starts - fake.stops <= 0, true, "no transport left running");
});

test("unlink with a failing logout still wipes the session, and says so in the log", async () => {
  const { h, fake, dir, lines } = setup();
  await linkAndScan(h, fake);
  fake.script.failNextLogout();
  await h.unlink();
  assert.equal(h.state().phase, "unlinked");
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(lines.some((l) => /logout failed/.test(l)));
});

test("a double click on Link starts one transport", async () => {
  const { h, fake } = setup();
  assert.deepEqual(h.link(), { ok: true });
  assert.deepEqual(h.link(), { ok: true });
  await flush();
  assert.deepEqual(h.link(), { ok: true });
  await flush();
  assert.equal(fake.starts, 1);
});

test("a server restart while linked reconnects on the stored session, without a QR", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const second = setup({ dir: first.dir, fake: first.fake });
  assert.equal(second.h.state().phase, "reconnecting");
  await flush();
  const st = second.h.state() as { phase: string; linkedAt?: number; account?: WaAccount };
  assert.equal(st.phase, "connected");
  assert.equal(st.account?.name, "Ada's shop");
  assert.ok(!second.lines.some((l) => /linking/.test(l)));
});

test("a server restart while linked, library installed but failing to load: halted{library}, and the session stays on disk", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const second = setup({ dir: first.dir, loadFactory: async () => { throw new Error("Cannot find package 'baileys'\n  at somewhere"); } });
  await flush();
  const st = second.h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "library");
  assert.equal(st.reason, "Cannot find package 'baileys'");
  assert.ok(storedAccount(first.dir));
});

// ── the rest of the rules ───────────────────────────────────────────────────

test("a capability refusal: unavailable, and link() returns it", async () => {
  const { h, fake } = setup({ refusal: "isolation requires the privileged deployment" });
  assert.deepEqual(h.state(), { phase: "unavailable", reason: "isolation requires the privileged deployment" });
  assert.deepEqual(h.link(), { ok: false, error: "isolation requires the privileged deployment" });
  await flush();
  assert.equal(fake.starts, 0);
});

test("a refusal does not delete a stored session, and a lifted refusal resumes it", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  let refusal: string | null = "the groups are not migrated yet";
  const second = setup({ dir: first.dir, fake: first.fake, refusal: () => refusal });
  await flush();
  assert.equal(second.h.state().phase, "unavailable");
  assert.ok(storedAccount(first.dir));
  refusal = null;
  await second.c.advance(15_000);
  assert.equal(second.h.state().phase, "connected");
});

test("a library that will not load, no stored session: Link halts{library} with the reason, nothing on disk changes", async () => {
  const { h, dir } = setup({ loadFactory: async () => { throw new Error("Cannot find package 'baileys'"); } });
  assert.equal(h.state().phase, "unlinked");
  h.link();
  await flush();
  const st = h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "library");
  assert.equal(st.reason, "Cannot find package 'baileys'");
  assert.ok(!fs.existsSync(path.join(dir, "account.json")));
});

test("open records the account through rememberAccount", async () => {
  const { h, fake, dir, c } = setup();
  await linkAndScan(h, fake);
  assert.deepEqual(storedAccount(dir), { account: ADA, linkedAt: c.now() });
});

test("logged-out from the phone stops for good and keeps the session until the admin acts", async () => {
  const { h, fake, c, dir } = setup();
  await linkAndScan(h, fake);
  fake.script.removeFromPhone();
  await flush();
  const st = h.state() as { phase: string; account?: WaAccount; detail?: string };
  assert.equal(st.phase, "logged-out");
  assert.equal(st.account?.name, "Ada's shop");
  const starts = fake.starts;
  await c.advance(10 * 60_000);
  assert.equal(fake.starts, starts);
  assert.ok(storedAccount(dir));
  // Link again: a fresh QR, not the dead session.
  h.link();
  await flush();
  assert.equal(h.state().phase, "linking");
  assert.ok((h.state() as { qr?: string }).qr);
});

test("cancel while linking stops the transport and goes back to unlinked", async () => {
  const { h, fake } = setup();
  h.link();
  await flush();
  await h.cancel();
  assert.equal(h.state().phase, "unlinked");
  assert.equal(fake.stops, 1);
});

test("a lost socket backs off: 2 s, then 4 s", async () => {
  const { h, fake, c } = setup();
  await linkAndScan(h, fake);
  fake.script.goSilent();
  await c.advance(LIVENESS_MS + 15_000);
  const s0 = fake.starts;
  await c.advance(1_999);
  assert.equal(fake.starts, s0);
  await c.advance(1);
  assert.equal(fake.starts, s0 + 1);
});

test("the log carries neither the QR payload nor the full number", async () => {
  const { h, fake, lines } = setup();
  await linkAndScan(h, fake);
  fake.script.drop();
  await flush();
  const all = lines.join("\n");
  assert.ok(!/fake-qr-/.test(all), all);
  assert.ok(!all.includes("33600000000"), all);
  assert.ok(all.includes("336…00"), all);
});

test("a pre-existing account.json with a session the library no longer accepts lands on logged-out, not on a loop", async () => {
  // No fake creds: the fake answers a QR, which on a resume means the session
  // is gone. The real library answers 401 instead; both must stop retrying.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-handle-")), "s");
  ensureSessionDir(dir);
  rememberAccount(dir, ADA, 5);
  const { h, fake, c } = setup({ dir });
  await flush();
  assert.equal(h.state().phase, "logged-out");
  assert.equal(fake.stops, 1);
  const starts = fake.starts;
  await c.advance(5 * 60_000);
  assert.equal(fake.starts, starts);
});

test("a transport whose start throws is retried with backoff, not left hanging", async () => {
  const fake = makeFakeTransport();
  let fail = 1;
  const factory: WaTransportFactory = async (x) => {
    const t = await fake.factory(x);
    return { ...t, start: async (on) => { if (fail-- > 0) throw new Error("boom"); return t.start(on); } };
  };
  const first = setup({ fake });
  await linkAndScan(first.h, fake);
  await first.h.stop();
  const second = setup({ dir: first.dir, fake, loadFactory: async () => factory });
  await flush();
  assert.equal(second.h.state().phase, "reconnecting");
  await second.c.advance(2_000);
  assert.equal(second.h.state().phase, "connected");
});

test("the library's own logged-out close during Unlink never surfaces", async () => {
  const fake = makeFakeTransport();
  const factory: WaTransportFactory = async (x) => {
    const t = await fake.factory(x);
    let emit: ((e: import("../src/wa-transport.js").WaTransportEvent) => void) | null = null;
    return {
      start: async (on) => { emit = on; return t.start(on); },
      logout: async () => { await t.logout(); emit?.({ type: "close", reason: "logged-out" }); },
      stop: () => t.stop(),
    };
  };
  const { h, lines } = setup({ fake, loadFactory: async () => factory });
  await linkAndScan(h, fake);
  await h.unlink();
  assert.equal(h.state().phase, "unlinked");
  assert.ok(!lines.some((l) => /→ logged-out/.test(l)), lines.join("\n"));
});

test("a reconnect attempt that neither opens nor closes is abandoned and retried", async () => {
  const { h, fake, c } = setup();
  await linkAndScan(h, fake);
  fake.script.offline(); // every socket from now on is silent: no open, no close
  await c.advance(LIVENESS_MS + 15_000);
  assert.equal(h.state().phase, "reconnecting");
  const s0 = fake.starts;
  // Without a watchdog the silent attempt would hold "reconnecting, retrying" for ever.
  await c.advance(LIVENESS_MS + 2 * 15_000 + 60_000);
  assert.ok(fake.starts > s0 + 1, `starts ${fake.starts} vs ${s0}`);
  const st = h.state() as { phase: string; attempt?: number };
  assert.equal(st.phase, "reconnecting");
  assert.ok((st.attempt ?? 0) >= 2);
  fake.script.online();
  await c.advance(5 * 60_000);
  assert.equal(h.state().phase, "connected");
});

test("a permanent close (e.g. connection replaced) halts for good, keeps the session, and says why", async () => {
  const fake = makeFakeTransport();
  const { h, c, dir } = setup({ fake });
  await linkAndScan(h, fake);
  fake.script.fatal("connection replaced: this number was linked again elsewhere");
  await flush();
  const st = h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "permanent");
  assert.match(st.reason ?? "", /linked again elsewhere/);
  const starts = fake.starts;
  await c.advance(30 * 60_000);
  assert.equal(fake.starts, starts, "nothing retries a permanent stop");
  assert.ok(storedAccount(dir));
  // Retry is the admin's call, and resumes the stored session.
  assert.deepEqual(h.retry(), { ok: true });
  await flush();
  assert.equal(h.state().phase, "connected");
});

// ── a step that throws must end in a state that says what failed ───────────

test("resume: a session directory that cannot be used ends halted{error}, not a silent 'reconnecting'", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-handle-"));
  const real = path.join(root, "real");
  ensureSessionDir(real);
  rememberAccount(real, ADA, 5);
  const dir = path.join(root, "s");
  fs.symlinkSync(real, dir); // storedAccount reads through it; ensureSessionDir refuses it
  const { h, c } = setup({ dir });
  await flush();
  const st = h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "error");
  assert.match(st.reason ?? "", /session directory/);
  await c.advance(10 * 60_000);
  assert.equal(h.state().phase, "halted");
});

test("link: a session directory that cannot be created ends halted{error} at once, not three minutes of 'waiting for a code'", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-handle-"));
  fs.writeFileSync(path.join(root, "file"), "x");
  const { h, fake } = setup({ dir: path.join(root, "file", "s") });
  assert.deepEqual(h.link(), { ok: true });
  await flush();
  const st = h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "error");
  assert.match(st.reason ?? "", /session directory/);
  assert.equal(fake.starts, 0);
});

test("unlink: a wipe that fails says so — not ok, halted{error}, and nothing reconnects on the unwiped session", async () => {
  const { h, fake, c, dir } = setup();
  await linkAndScan(h, fake);
  fs.renameSync(dir, `${dir}-real`);
  fs.symlinkSync(`${dir}-real`, dir); // the wipe refuses a symlinked directory
  const r = await h.unlink();
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /could not delete/);
  const st = h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "error");
  const starts = fake.starts;
  await c.advance(10 * 60_000);
  assert.equal(fake.starts, starts, "no reconnect on a session we failed to delete");
});

test("cancel: a wipe that fails ends halted{error}", async () => {
  const { h, fake, dir } = setup();
  h.link();
  await flush();
  fs.renameSync(dir, `${dir}-real`);
  fs.symlinkSync(`${dir}-real`, dir);
  await h.cancel();
  assert.equal(h.state().phase, "halted");
  assert.equal(fake.stops, 1);
});

// ── unlink wipes in every phase ─────────────────────────────────────────────

async function linkedThenRestarted(o: Parameters<typeof setup>[0]) {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  return setup({ ...o, dir: first.dir });
}

test("unlink while the library will not load wipes the stored session and goes back to unlinked", async () => {
  const { h, dir } = await linkedThenRestarted({ loadFactory: async () => { throw new Error("Cannot find package 'baileys'"); } });
  await flush();
  assert.equal(h.state().phase, "halted");
  assert.equal(h.hasStoredSession(), true);
  assert.deepEqual(await h.unlink(), { ok: true });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(h.hasStoredSession(), false);
  assert.equal(h.state().phase, "unlinked");
});

test("unlink while refused (not migrated) wipes the session; when the refusal lifts there is nothing to resume", async () => {
  let refusal: string | null = "the instance's groups are not migrated yet";
  const { h, dir, c } = await linkedThenRestarted({ refusal: () => refusal });
  await flush();
  assert.equal(h.state().phase, "unavailable");
  assert.deepEqual(await h.unlink(), { ok: true });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(h.state(), { phase: "unavailable", reason: "the instance's groups are not migrated yet" });
  refusal = null;
  await c.advance(15_000);
  assert.equal(h.state().phase, "unlinked");
});

test("unlink with nothing stored and nothing running is not ok", async () => {
  const { h } = setup();
  const r = await h.unlink();
  assert.equal(r.ok, false);
  assert.equal((r as { nothing?: true }).nothing, true);
});

test("unlink from halted wipes and goes back to unlinked", async () => {
  const fake = makeFakeTransport();
  const { h, dir } = setup({ fake });
  await linkAndScan(h, fake);
  fake.script.fatal();
  await flush();
  assert.equal(h.state().phase, "halted");
  assert.deepEqual(await h.unlink(), { ok: true });
  assert.equal(h.state().phase, "unlinked");
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ── the breaker: a resume that took the server down is not repeated at boot ──

test("a boot that died while resuming: the next boot does not resume, and says why", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  // Boot 2 starts resuming… and the process dies before the resume settled.
  const second = setup({ dir: first.dir, fake: first.fake });
  assert.equal(second.h.state().phase, "reconnecting");
  // (no stop(): that is what a crash looks like)
  const third = setup({ dir: first.dir, fake: first.fake });
  await flush();
  const st = third.h.state() as { phase: string; cause?: string; reason?: string; account?: WaAccount };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "crash");
  assert.match(st.reason ?? "", /not resumed again automatically/);
  assert.equal(st.account?.name, "Ada's shop");
  const starts = first.fake.starts;
  await third.c.advance(10 * 60_000);
  assert.equal(first.fake.starts, starts);
  // Retry is the admin's call.
  assert.deepEqual(third.h.retry(), { ok: true });
  await flush();
  assert.equal(third.h.state().phase, "connected");
});

test("a resume that settles (connected long enough) disarms the breaker", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const second = setup({ dir: first.dir, fake: first.fake });
  await flush();
  assert.equal(second.h.state().phase, "connected");
  for (let i = 0; i < 5; i++) {
    await second.c.advance(15_000);
    first.fake.script.ping();
  }
  // crash now — after the resume settled
  const third = setup({ dir: first.dir, fake: first.fake });
  await flush();
  assert.equal(third.h.state().phase, "connected");
});

test("a clean stop disarms the breaker even mid-resume", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const second = setup({ dir: first.dir, fake: first.fake });
  await second.h.stop();
  const third = setup({ dir: first.dir, fake: first.fake });
  await flush();
  assert.equal(third.h.state().phase, "connected");
});

// ── the library, installed on demand ────────────────────────────────────────

test("first Link with the library absent: installing, then linking — one install, one transport", async () => {
  const lib = fakeLibrary("absent");
  const { h, fake } = setup({ library: lib.lib });
  assert.deepEqual(h.link(), { ok: true });
  await flush();
  assert.equal(h.state().phase, "installing");
  assert.equal((h.state() as { then?: string }).then, "link");
  assert.equal(fake.starts, 0, "nothing loads before the install is done");
  // Two more clicks while it installs: the same install.
  assert.deepEqual(h.link(), { ok: true });
  assert.deepEqual(h.link(), { ok: true });
  assert.equal(lib.calls.length, 1);
  assert.deepEqual(lib.calls[0], { force: false });
  lib.finish();
  await flush();
  assert.equal(h.state().phase, "linking");
  assert.ok((h.state() as { qr?: string }).qr);
  assert.equal(fake.starts, 1);
});

test("an install that fails halts{library} with the reason, and the next Link tries again", async () => {
  const lib = fakeLibrary("absent");
  const { h, fake } = setup({ library: lib.lib });
  h.link();
  await flush();
  lib.fail("the npm registry could not be reached — is this machine online?");
  await flush();
  const st = h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "library");
  assert.match(st.reason!, /could not install the WhatsApp library: the npm registry could not be reached/);
  assert.equal(fake.starts, 0);
  // Retry with no stored session is a link, so it installs again.
  assert.deepEqual(h.retry(), { ok: true });
  await flush();
  assert.equal(h.state().phase, "installing");
  assert.equal(lib.calls.length, 2);
});

test("a boot with a stored session and NO library: halted{library}, never an install on its own", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const lib = fakeLibrary("absent");
  const second = setup({ dir: first.dir, fake: first.fake, library: lib.lib });
  await second.c.advance(5 * 60_000);
  const st = second.h.state() as { phase: string; cause?: string; reason?: string; account?: WaAccount };
  assert.equal(st.phase, "halted");
  assert.equal(st.cause, "library");
  assert.match(st.reason!, /not installed/);
  assert.equal(st.account?.name, "Ada's shop", "the panel still says whose session it is");
  assert.equal(lib.calls.length, 0, "installing is an admin's act");
  assert.equal(first.fake.starts, 2, "no transport started at this boot");
  assert.ok(storedAccount(first.dir));
  assert.ok(!fs.existsSync(path.join(first.dir, ".resume-in-progress")), "nothing was resumed, so nothing is armed");
});

test("from there, Install (retry) installs and RESUMES the stored session — no QR, the breaker armed while it settles", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const lib = fakeLibrary("absent");
  const second = setup({ dir: first.dir, fake: first.fake, library: lib.lib });
  assert.deepEqual(second.h.retry(), { ok: true });
  await flush();
  assert.equal(second.h.state().phase, "installing");
  assert.equal((second.h.state() as { then?: string }).then, "resume");
  lib.finish();
  await flush();
  assert.equal(second.h.state().phase, "connected");
  assert.ok(!second.lines.some((l) => /→ linking/.test(l)));
  assert.ok(fs.existsSync(path.join(first.dir, ".resume-in-progress")));
});

test("a library left by another release is STALE: halted{library} saying so, and Install replaces it", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const lib = fakeLibrary("stale");
  const second = setup({ dir: first.dir, fake: first.fake, library: lib.lib });
  const st = second.h.state() as { phase: string; cause?: string; reason?: string };
  assert.equal(st.phase, "halted");
  assert.match(st.reason!, /out of date/);
  second.h.retry();
  await flush();
  assert.equal(lib.calls.length, 1);
  lib.finish();
  await flush();
  assert.equal(second.h.state().phase, "connected");
});

test("Unlink works with no library at all: the stored session is wiped and nothing is installed", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const lib = fakeLibrary("absent");
  const second = setup({ dir: first.dir, fake: first.fake, library: lib.lib });
  assert.deepEqual(await second.h.unlink(), { ok: true });
  assert.deepEqual(fs.readdirSync(first.dir), []);
  assert.equal(second.h.state().phase, "unlinked");
  assert.equal(lib.calls.length, 0);
});

test("a ready library that will not load: Retry REinstalls it (force), then tries again", async () => {
  let broken = true;
  const fake = makeFakeTransport();
  const lib = fakeLibrary("ready");
  const { h } = setup({ fake, library: lib.lib, loadFactory: async () => { if (broken) throw new Error("the WhatsApp library loaded, but not in the expected shape"); return fake.factory; } });
  h.link();
  await flush();
  assert.equal((h.state() as { cause?: string }).cause, "library");
  assert.equal(lib.calls.length, 0, "ready: Link did not install");
  broken = false;
  h.retry();
  await flush();
  assert.equal(h.state().phase, "installing");
  assert.deepEqual(lib.calls, [{ force: true }]);
  lib.finish();
  await flush();
  assert.equal(h.state().phase, "linking");
});

test("Unlink while installing goes back to unlinked, and the install's late success starts nothing", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const lib = fakeLibrary("absent");
  const second = setup({ dir: first.dir, fake: first.fake, library: lib.lib });
  second.h.retry();
  await flush();
  assert.equal(second.h.state().phase, "installing");
  assert.deepEqual(await second.h.unlink(), { ok: true });
  assert.equal(second.h.state().phase, "unlinked");
  lib.finish();
  await flush();
  assert.equal(second.h.state().phase, "unlinked");
  assert.equal(first.fake.starts, 2);
});

test("a refusal that lands while installing wins, and the install's success starts nothing", async () => {
  let refusal: string | null = null;
  const lib = fakeLibrary("absent");
  const { h, fake, c } = setup({ library: lib.lib, refusal: () => refusal });
  h.link();
  await flush();
  refusal = "the groups are not migrated yet";
  await c.advance(15_000);
  assert.equal(h.state().phase, "unavailable");
  lib.finish();
  await flush();
  assert.equal(h.state().phase, "unavailable");
  assert.equal(fake.starts, 0);
});
