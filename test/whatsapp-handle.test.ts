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

function setup(o: { refusal?: string | null | (() => string | null); loadFactory?: () => Promise<WaTransportFactory>; dir?: string; fake?: ReturnType<typeof makeFakeTransport> } = {}) {
  const dir = o.dir ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-handle-")), "s");
  const fake = o.fake ?? makeFakeTransport();
  const c = clock();
  const lines: string[] = [];
  const h = startWhatsApp({
    sessionDir: dir,
    refusal: o.refusal ?? null,
    loadFactory: o.loadFactory ?? (async () => fake.factory),
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

test("a server restart while linked, library absent: unavailable, and the session stays on disk", async () => {
  const first = setup();
  await linkAndScan(first.h, first.fake);
  await first.h.stop();
  const second = setup({ dir: first.dir, loadFactory: async () => { throw new Error("Cannot find package 'baileys'\n  at somewhere"); } });
  await flush();
  const st = second.h.state() as { phase: string; reason?: string };
  assert.equal(st.phase, "unavailable");
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

test("library absent with no stored session: Link leads to unavailable, nothing on disk changes", async () => {
  const { h, dir } = setup({ loadFactory: async () => { throw new Error("Cannot find package 'baileys'"); } });
  assert.equal(h.state().phase, "unlinked");
  h.link();
  await flush();
  assert.deepEqual(h.state(), { phase: "unavailable", reason: "Cannot find package 'baileys'" });
  assert.deepEqual(h.link(), { ok: false, error: "Cannot find package 'baileys'" });
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
