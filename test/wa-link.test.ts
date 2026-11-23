import assert from "node:assert/strict";
import test from "node:test";
import {
  LINK_TIMEOUT_MS,
  LIVENESS_MS,
  linkReduce,
  linkView,
  maskPhone,
  reconnectDelayMs,
  type WaAccount,
  type WaLinkState,
} from "../src/wa-link.js";

const ADA: WaAccount = { id: "33600000000:4@s.whatsapp.net", name: "Ada's shop", phone: "33600000000" };
const T = 1_000_000;

const connected = (over: Partial<Extract<WaLinkState, { phase: "connected" }>> = {}): WaLinkState => ({
  phase: "connected",
  account: ADA,
  linkedAt: T - 50_000,
  connectedAt: T - 10_000,
  lastSeenAt: T,
  ...over,
});
const reconnecting = (attempt = 1): WaLinkState => ({
  phase: "reconnecting",
  account: ADA,
  linkedAt: T - 50_000,
  lostAt: T - 5_000,
  attempt,
});

test("link-requested starts linking from unlinked and from logged-out", () => {
  assert.deepEqual(linkReduce({ phase: "unlinked" }, { type: "link-requested" }, T), { phase: "linking", startedAt: T });
  const lo: WaLinkState = { phase: "logged-out", account: ADA, at: T - 1, detail: "removed" };
  assert.deepEqual(linkReduce(lo, { type: "link-requested" }, T), { phase: "linking", startedAt: T });
});

test("link-requested is ignored while connected, reconnecting, linking or unavailable", () => {
  for (const s of [connected(), reconnecting(), { phase: "linking", startedAt: T - 5 } as WaLinkState, { phase: "unavailable", reason: "x" } as WaLinkState])
    assert.deepEqual(linkReduce(s, { type: "link-requested" }, T), s);
});

test("qr sets the payload and its expiry", () => {
  const s = linkReduce({ phase: "linking", startedAt: T - 5 }, { type: "qr", payload: "QR-1", ttlMs: 60_000 }, T);
  assert.deepEqual(s, { phase: "linking", startedAt: T - 5, qr: "QR-1", qrExpiresAt: T + 60_000 });
});

test("a qr outside linking is ignored", () => {
  assert.deepEqual(linkReduce({ phase: "unlinked" }, { type: "qr", payload: "QR", ttlMs: 1 }, T), { phase: "unlinked" });
});

test("close{restart} while linking stays linking (the normal end of a scan), and drops the spent QR", () => {
  const s: WaLinkState = { phase: "linking", startedAt: T - 5, qr: "QR-1", qrExpiresAt: T + 1 };
  const n = linkReduce(s, { type: "close", reason: "restart" }, T);
  assert.equal(n.phase, "linking");
  assert.equal((n as { qr?: string }).qr, undefined);
  assert.equal((n as { startedAt: number }).startedAt, T - 5);
});

test("open from linking is a NEW link: linkedAt = now", () => {
  const n = linkReduce({ phase: "linking", startedAt: T - 5 }, { type: "open", account: ADA }, T);
  assert.deepEqual(n, { phase: "connected", account: ADA, linkedAt: T, connectedAt: T, lastSeenAt: T });
});

test("open from reconnecting keeps the stored linkedAt", () => {
  const n = linkReduce(reconnecting(3), { type: "open", account: ADA }, T);
  assert.deepEqual(n, { phase: "connected", account: ADA, linkedAt: T - 50_000, connectedAt: T, lastSeenAt: T });
});

test("open after a cancel is ignored", () => {
  assert.deepEqual(linkReduce({ phase: "unlinked" }, { type: "open", account: ADA }, T), { phase: "unlinked" });
});

test("tick past LINK_TIMEOUT_MS in linking goes back to unlinked", () => {
  const s: WaLinkState = { phase: "linking", startedAt: T };
  assert.equal(linkReduce(s, { type: "tick" }, T + LINK_TIMEOUT_MS - 1).phase, "linking");
  assert.deepEqual(linkReduce(s, { type: "tick" }, T + LINK_TIMEOUT_MS + 1), { phase: "unlinked" });
});

test("tick in connected past LIVENESS_MS of silence goes to reconnecting{attempt:1}", () => {
  const s = connected({ lastSeenAt: T });
  assert.equal(linkReduce(s, { type: "tick" }, T + LIVENESS_MS).phase, "connected");
  const n = linkReduce(s, { type: "tick" }, T + LIVENESS_MS + 1);
  assert.deepEqual(n, { phase: "reconnecting", account: ADA, linkedAt: T - 50_000, lostAt: T + LIVENESS_MS + 1, attempt: 1 });
});

test("alive refreshes lastSeenAt", () => {
  const n = linkReduce(connected({ lastSeenAt: T - 80_000 }), { type: "alive" }, T);
  assert.equal((n as { lastSeenAt: number }).lastSeenAt, T);
});

test("close{lost|error} in connected → reconnecting{attempt:1}", () => {
  for (const reason of ["lost", "error"] as const) {
    const n = linkReduce(connected(), { type: "close", reason }, T);
    assert.deepEqual(n, { phase: "reconnecting", account: ADA, linkedAt: T - 50_000, lostAt: T, attempt: 1 });
  }
});

test("close{lost|error} in reconnecting increments attempt and keeps lostAt", () => {
  for (const reason of ["lost", "error"] as const) {
    const n = linkReduce(reconnecting(2), { type: "close", reason }, T);
    assert.deepEqual(n, { ...reconnecting(3) });
  }
});

test("close{logged-out} from anywhere → logged-out, keeping the account", () => {
  for (const s of [connected(), reconnecting()]) {
    const n = linkReduce(s, { type: "close", reason: "logged-out", detail: "removed from the phone" }, T);
    assert.deepEqual(n, { phase: "logged-out", account: ADA, at: T, detail: "removed from the phone" });
  }
  const n = linkReduce({ phase: "linking", startedAt: 1 }, { type: "close", reason: "logged-out" }, T);
  assert.equal(n.phase, "logged-out");
  assert.equal((n as { account?: WaAccount }).account, undefined);
});

test("unlinked and cancel → unlinked", () => {
  for (const s of [connected(), reconnecting(), { phase: "linking", startedAt: 1 } as WaLinkState]) {
    assert.deepEqual(linkReduce(s, { type: "unlinked" }, T), { phase: "unlinked" });
    assert.deepEqual(linkReduce(s, { type: "cancel" }, T), { phase: "unlinked" });
  }
});

test("stored-session → reconnecting{attempt:0}", () => {
  const n = linkReduce({ phase: "unlinked" }, { type: "stored-session", account: ADA, linkedAt: T - 50_000 }, T);
  assert.deepEqual(n, { phase: "reconnecting", account: ADA, linkedAt: T - 50_000, lostAt: T, attempt: 0 });
});

test("unavailable → unavailable from anywhere", () => {
  for (const s of [connected(), reconnecting(), { phase: "unlinked" } as WaLinkState])
    assert.deepEqual(linkReduce(s, { type: "unavailable", reason: "no library" }, T), { phase: "unavailable", reason: "no library" });
});

test("reconnectDelayMs doubles from 2s and caps at 60s", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(reconnectDelayMs),
    [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000],
  );
  assert.equal(reconnectDelayMs(0), 0);
});

test("linkView hands the QR to a person only", () => {
  const s: WaLinkState = { phase: "linking", startedAt: T, qr: "QR-1", qrExpiresAt: T + 20_000 };
  assert.ok(!("qr" in linkView(s, T, false)));
  assert.equal(linkView(s, T, true).qr, "QR-1");
});

test("linkView never hands an expired QR", () => {
  const s: WaLinkState = { phase: "linking", startedAt: T, qr: "QR-1", qrExpiresAt: T + 20_000 };
  assert.ok(!("qr" in linkView(s, T + 20_001, true)));
});

test("linkView shows the number in full to a person, masked to anything else", () => {
  const v1 = linkView(connected(), T, true) as { account: { phone?: string } };
  const v2 = linkView(connected(), T, false) as { account: { phone?: string } };
  assert.equal(v1.account.phone, "33600000000");
  assert.equal(v2.account.phone, "336…00");
  // The raw device id carries the number too: never in a view.
  assert.ok(!JSON.stringify(v1).includes("s.whatsapp.net"));
});

test("maskPhone keeps three leading and two trailing digits", () => {
  assert.equal(maskPhone("33600000000"), "336…00");
  assert.equal(maskPhone(undefined), undefined);
  assert.equal(maskPhone("1234"), "…");
});

// ── halted: a stop the panel names, with the session kept ───────────────────

test("close{fatal} from connected or reconnecting → halted{permanent}, keeping account and linkedAt", () => {
  for (const s of [connected(), reconnecting()]) {
    const n = linkReduce(s, { type: "close", reason: "fatal", detail: "connection replaced" }, T);
    assert.deepEqual(n, { phase: "halted", cause: "permanent", account: ADA, linkedAt: T - 50_000, at: T, reason: "connection replaced" });
  }
});

test("close{fatal} while linking → halted without an account", () => {
  const n = linkReduce({ phase: "linking", startedAt: 1 }, { type: "close", reason: "fatal", detail: "forbidden" }, T);
  assert.deepEqual(n, { phase: "halted", cause: "permanent", at: T, reason: "forbidden" });
});

test("halt sets the cause and the reason from anywhere but unavailable", () => {
  const n = linkReduce(connected(), { type: "halt", cause: "error", reason: "disk full" }, T);
  assert.deepEqual(n, { phase: "halted", cause: "error", account: ADA, linkedAt: T - 50_000, at: T, reason: "disk full" });
  const u: WaLinkState = { phase: "unavailable", reason: "x" };
  assert.deepEqual(linkReduce(u, { type: "halt", cause: "error", reason: "y" }, T), u);
});

test("halted leaves only by an admin's act: link-requested, stored-session, unlinked", () => {
  const h: WaLinkState = { phase: "halted", cause: "permanent", account: ADA, linkedAt: 5, at: T - 1, reason: "r" };
  assert.equal(linkReduce(h, { type: "link-requested" }, T).phase, "linking");
  assert.equal(linkReduce(h, { type: "stored-session", account: ADA, linkedAt: 5 }, T).phase, "reconnecting");
  assert.equal(linkReduce(h, { type: "unlinked" }, T).phase, "unlinked");
  for (const e of [{ type: "tick" }, { type: "alive" }, { type: "close", reason: "lost" }, { type: "qr", payload: "q", ttlMs: 1 }] as const)
    assert.deepEqual(linkReduce(h, e, T), h);
});

test("linkView of halted names cause and reason", () => {
  const h: WaLinkState = { phase: "halted", cause: "crash", account: ADA, linkedAt: 5, at: T, reason: "r" };
  const v = linkView(h, T, false) as { phase: string; cause: string; reason: string; account: { phone: string } };
  assert.equal(v.cause, "crash");
  assert.equal(v.reason, "r");
  assert.equal(v.account.phone, "336…00");
});
