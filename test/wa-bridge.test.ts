import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWaBridge, type WsLike } from "../src/wa-bridge.js";
import { startWhatsApp } from "../src/whatsapp.js";
import { makeFakeTransport } from "../src/wa-fake.js";
import { openInbox } from "../src/wa-inbox.js";
import { upsertInto, type Channel } from "../src/channels.js";
import type { GuestSetup } from "../src/tg-guests.js";

// The bridge end to end, with NO network and NO phone: the scripted fake
// transport stands for WhatsApp, and a fake server socket stands for our own
// /ws — it records every frame the bridge sends and lets the test answer the
// way the server does (ready, working, stream-text, prompt-id, turn-done…).

const ACCOUNT_ID = "33600000000:1@s.whatsapp.net";
const ACCOUNT = "33600000000@s.whatsapp.net";
const LID = "100000000000001@lid";
const PN = "33611111111@s.whatsapp.net";
const OPEN: GuestSetup = { mode: "dm-only", group: "g1", profile: "Support" };
const SHUT: GuestSetup = { mode: "group", group: "g1", profile: "Support" };

const tick = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

class FakeWs implements WsLike {
  readyState = 0;
  frames: any[] = [];
  private handlers: Record<string, ((a?: any) => void)[]> = {};
  constructor(private server: FakeServer) {
    setImmediate(() => {
      this.readyState = 1;
      this.fire("open");
    });
  }
  on(ev: string, fn: (a?: any) => void) {
    (this.handlers[ev] ??= []).push(fn);
  }
  send(s: string) {
    const f = JSON.parse(s);
    this.frames.push(f);
    this.server.onFrame(this, f);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close");
  }
  fire(ev: string, a?: any) {
    for (const fn of this.handlers[ev] ?? []) fn(a);
  }
  /** The server says something to this socket. */
  emit(m: object) {
    this.fire("message", Buffer.from(JSON.stringify(m)));
  }
  get start() {
    return this.frames.find((f) => f.type === "start");
  }
  prompts() {
    return this.frames.filter((f) => f.type === "prompt");
  }
}

/** Our server, as far as the bridge can tell: answers `start` with `ready`,
 *  and writes the channel row the way the real start handler does. */
class FakeServer {
  sockets: FakeWs[] = [];
  channels: Channel[] = [];
  seq = 0;
  autoReady = true;
  connect = (): WsLike => {
    const ws = new FakeWs(this);
    this.sockets.push(ws);
    return ws;
  };
  onFrame(ws: FakeWs, f: any) {
    if (f.type !== "start" || !this.autoReady) return;
    const id = f.resume ?? `sess-${++this.seq}`;
    if (!f.resume) this.channels = upsertInto(this.channels, { sessionId: id, cwd: `/home/g1/${f.guestKey}`, group: "g1" });
    setImmediate(() => ws.emit({ type: "ready", sessionId: id }));
  }
  last() {
    return this.sockets.at(-1)!;
  }
  open() {
    return this.sockets.filter((s) => s.readyState === 1);
  }
}

async function world(o: { setup?: GuestSetup; dir?: string; server?: FakeServer; fake?: ReturnType<typeof makeFakeTransport>; alive?: (id: string) => boolean } = {}) {
  const root = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "wa-bridge-"));
  const fake = o.fake ?? makeFakeTransport();
  const server = o.server ?? new FakeServer();
  const lines: string[] = [];
  let setup = o.setup ?? OPEN;
  const handle = startWhatsApp({ sessionDir: path.join(root, "session"), refusal: null, loadFactory: async () => fake.factory, log: () => {} });
  const inbox = openInbox(path.join(root, "state", "inbox.json"), { log: () => {} });
  const bridge = startWaBridge({
    handle,
    connect: server.connect,
    setup: () => setup,
    channels: { load: () => server.channels, upsert: (p) => void (server.channels = upsertInto(server.channels, p)) },
    inbox,
    sessionAlive: o.alive ?? (() => false),
    log: (l) => lines.push(l),
    spacingMs: 0,
    reattachMs: 0,
    preemptMs: 200,
  });
  return {
    root,
    fake,
    server,
    handle,
    inbox,
    bridge,
    lines,
    setSetup: (s: GuestSetup) => void (setup = s),
    async link() {
      handle.link();
      await tick();
      fake.script.scan({ id: ACCOUNT_ID, name: "Ada's shop", phone: "33600000000" });
      await tick();
      assert.equal(handle.state().phase, "connected");
    },
    async stop() {
      bridge.stop();
      await handle.stop();
    },
  };
}

const say = (w: Awaited<ReturnType<typeof world>>, text: string, o: { id?: string; chat?: string; chatAlt?: string; pushName?: string } = {}) =>
  w.fake.script.deliver({ chat: o.chat ?? LID, chatAlt: o.chatAlt ?? PN, text, pushName: o.pushName ?? "Grace", ...(o.id ? { id: o.id } : {}) });

test("a first message spawns a guest agent with the WhatsApp key, and binds the channel at ready", async () => {
  const w = await world();
  await w.link();
  say(w, "hello there", { id: "M1" });
  await tick();
  const ws = w.server.last();
  assert.deepEqual(
    { type: ws.start.type, origin: ws.start.origin, guest: ws.start.guest, guestKey: ws.start.guestKey, resume: ws.start.resume },
    { type: "start", origin: "whatsapp", guest: true, guestKey: LID, resume: undefined },
  );
  assert.equal(ws.start.worktree, false);
  assert.deepEqual(ws.prompts().map((p) => [p.text, p.from]), [["hello there", "Grace"]]);
  const row = w.server.channels[0];
  assert.deepEqual(row.whatsapp, { account: ACCOUNT, id: LID, phone: "33611111111" });
  assert.equal(row.name, "Grace");
  assert.equal(row.telegram, undefined);
  assert.equal(row.mirror, undefined, "a guest conversation is never mirrored");
  await w.stop();
});

test("the second message lands on the same agent; another person gets their own", async () => {
  const w = await world();
  await w.link();
  say(w, "one");
  await tick();
  say(w, "two");
  await tick();
  assert.equal(w.server.sockets.length, 1);
  say(w, "hi", { chat: "100000000000002@lid", chatAlt: "33622222222@s.whatsapp.net", pushName: "Edsger" });
  await tick();
  assert.equal(w.server.sockets.length, 2);
  assert.equal(w.server.last().start.guestKey, "100000000000002@lid");
  await w.stop();
});

test("the same person under a phone number, then under a LID, is ONE agent", async () => {
  const w = await world();
  await w.link();
  // First seen with no LID at all, and the transport cannot map it yet.
  say(w, "first", { chat: PN, chatAlt: undefined as unknown as string });
  await tick();
  assert.equal(w.server.last().start.guestKey, PN);
  assert.equal(w.server.channels[0].whatsapp?.id, PN);
  // Now the LID shows up, with the phone number alongside.
  say(w, "second", { chat: LID, chatAlt: PN });
  await tick();
  assert.equal(w.server.sockets.length, 1, "no second agent");
  assert.deepEqual(w.server.last().prompts().map((p) => p.text), ["first", "second"]);
  assert.equal(w.server.channels[0].whatsapp?.id, LID, "re-keyed to the LID");
  assert.equal(w.server.channels.length, 1);
  await w.stop();
});

test("a phone-number-only message is resolved to the LID it is already bound under", async () => {
  const w = await world();
  await w.link();
  say(w, "by lid", { chat: LID, chatAlt: undefined as unknown as string });
  await tick();
  w.fake.script.mapLid(PN, LID);
  say(w, "by phone", { chat: PN, chatAlt: undefined as unknown as string });
  await tick();
  assert.equal(w.server.sockets.length, 1);
  assert.deepEqual(w.server.last().prompts().map((p) => p.text), ["by lid", "by phone"]);
  await w.stop();
});

test("the door shut is silence: no socket, nothing sent, nothing queued — for known senders too", async () => {
  const w = await world({ setup: SHUT });
  await w.link();
  say(w, "anyone?");
  await tick();
  assert.equal(w.server.sockets.length, 0);
  assert.deepEqual(w.fake.sent, []);
  assert.deepEqual(w.inbox.pending(), []);
  w.setSetup(OPEN);
  say(w, "hello");
  await tick();
  assert.equal(w.server.sockets.length, 1);
  w.setSetup(SHUT);
  say(w, "still there?");
  await tick();
  assert.deepEqual(w.server.last().prompts().map((p) => p.text), ["hello"]);
  assert.deepEqual(w.fake.sent, []);
  await w.stop();
});

test("groups, own messages, replays and unreadable messages never reach an agent", async () => {
  const w = await world();
  await w.link();
  w.fake.script.deliver({ chat: "120363000000000000@g.us", text: "group chatter" });
  w.fake.script.deliver({ chat: LID, text: "from my own phone", fromMe: true });
  w.fake.script.deliver({ chat: LID, text: "old", live: false });
  w.fake.script.deliver({ chat: LID, unreadable: true });
  w.fake.script.deliver({ chat: "status@broadcast", text: "status" });
  await tick();
  assert.equal(w.server.sockets.length, 0);
  assert.deepEqual(w.inbox.pending(), []);
  await w.stop();
});

test("the agent's answer is formatted for WhatsApp and sent only to the binding", async () => {
  const w = await world();
  await w.link();
  say(w, "hi");
  await tick();
  const ws = w.server.last();
  ws.emit({ type: "working" });
  ws.emit({ type: "stream-text", text: "## Hello\nThis is **bold** and [docs](https://example.com)." });
  await tick();
  assert.deepEqual(w.fake.sent, [{ to: LID, text: "*Hello*\nThis is *bold* and docs (https://example.com)." }]);
  assert.ok(w.fake.typing.some((t) => t.to === LID && t.on), "typing while the agent works");
  ws.emit({ type: "turn-done" });
  await tick();
  assert.ok(w.fake.typing.some((t) => t.to === LID && !t.on), "typing stops with the turn");
  await w.stop();
});

test("what the operator types in the cockpit reaches the person, labelled, with no server path", async () => {
  const w = await world();
  await w.link();
  say(w, "hi");
  await tick();
  w.server.last().emit({ type: "prompt-echo", origin: "web", from: "ada", text: "I'll take it from here [Attached file: /root/.shadok-ai/media/x.pdf]" });
  await tick();
  assert.equal(w.fake.sent.length, 1);
  assert.match(w.fake.sent[0].text, /^👤 ada · web\nI'll take it from here \[file\]$/);
  await w.stop();
});

test("a stranger's /clear reaches the server neutralised — never as a command", async () => {
  const w = await world();
  await w.link();
  say(w, "/clear");
  await tick();
  const p = w.server.last().prompts()[0];
  assert.ok(p.text.includes("/clear"));
  assert.ok(!/^\/[A-Za-z]/.test(p.text.trim()), p.text);
  await w.stop();
});

test("a restart before the prompt landed replays it ONCE; after prompt-id it is never replayed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-bridge-"));
  const server = new FakeServer();
  const fake = makeFakeTransport();
  server.autoReady = false; // the agent takes its time to spawn
  const a = await world({ dir: root, server, fake });
  await a.link();
  say(a, "kept", { id: "K1" });
  await tick();
  assert.equal(server.last().prompts().length, 0, "not ready: nothing submitted yet");
  // The server restarts: the bridge dies with it, and WhatsApp will NOT
  // redeliver (the library acknowledged on receipt).
  await a.stop();
  for (const s of server.sockets) s.close();
  server.autoReady = true;
  // The spawn had gone through: the channel exists with its binding.
  const b = await world({ dir: root, server, fake });
  await b.link();
  await tick();
  const ws = server.last();
  assert.deepEqual(ws.prompts().map((p) => p.text), ["kept"], "replayed from the inbox");
  ws.emit({ type: "prompt-id", msgId: "u1", text: "kept" });
  await tick();
  assert.deepEqual(b.inbox.pending(), []);
  await b.stop();
  for (const s of server.sockets) s.close();
  const c = await world({ dir: root, server, fake });
  await c.link();
  await tick();
  assert.equal(server.sockets.filter((s) => s.prompts().some((p) => p.text === "kept")).length, 1, "never twice");
  await c.stop();
});

test("a message delivered twice by WhatsApp is one prompt", async () => {
  const w = await world();
  await w.link();
  say(w, "once", { id: "DUP" });
  say(w, "once", { id: "DUP" });
  await tick();
  assert.equal(w.server.last().prompts().length, 1);
  await w.stop();
});

test("an agent closed in the cockpit unbinds: the next message starts a NEW agent", async () => {
  const w = await world();
  await w.link();
  say(w, "hi");
  await tick();
  const first = w.server.last();
  // The cockpit's ✕: the server drops the row and tells the socket.
  w.server.channels = w.server.channels.filter((c) => c.sessionId !== "sess-1");
  first.emit({ type: "stopped" });
  await tick();
  assert.equal(first.readyState, 3);
  say(w, "are you there?");
  await tick();
  const second = w.server.last();
  assert.notEqual(second, first);
  assert.equal(second.start.resume, undefined, "a fresh spawn, not a resume");
  assert.equal(second.start.guest, true);
  await w.stop();
});

test("a busy agent is interrupted and the message re-sent once the turn ends (Telegram's preempt)", async () => {
  const w = await world();
  await w.link();
  say(w, "first");
  await tick();
  const ws = w.server.last();
  say(w, "second");
  await tick();
  ws.emit({ type: "error", code: "busy", message: "a response is already in progress" });
  await tick();
  assert.ok(ws.frames.some((f) => f.type === "key" && f.key === "escape"));
  ws.emit({ type: "turn-done" });
  await tick();
  assert.deepEqual(ws.prompts().map((p) => p.text), ["first", "second", "second"]);
  await w.stop();
});

test("a refusal that loses the message tells the person in guest words, and frees the inbox", async () => {
  const w = await world();
  await w.link();
  say(w, "hi", { id: "R1" });
  await tick();
  w.server.last().emit({ type: "pace-blocked", reason: "over the ideal pace" });
  await tick();
  assert.equal(w.fake.sent.length, 1);
  assert.match(w.fake.sent[0].text, /capacity/);
  assert.doesNotMatch(w.fake.sent[0].text, /pace guard/);
  assert.deepEqual(w.inbox.pending(), []);
  await w.stop();
});

test("a guest spawn the server refuses: not replayed for ever, and nothing sent to a number with no binding", async () => {
  const w = await world();
  w.server.autoReady = false;
  await w.link();
  say(w, "hi");
  await tick();
  w.server.last().emit({ type: "error", code: "guest-group", message: "the configured guest group is not usable from here" });
  await tick();
  assert.equal(w.server.last().readyState, 3);
  assert.deepEqual(w.inbox.pending(), []);
  assert.deepEqual(w.fake.sent, [], "no agent, no binding: the bridge never writes first");
  assert.ok(w.lines.some((l) => /guest spawn was refused \(guest-group\)/.test(l)), "said to the admin");
  await w.stop();
});

test("a question the agent asks reaches the person as text, and their reply dismisses it first", async () => {
  const w = await world();
  await w.link();
  say(w, "book me");
  await tick();
  const ws = w.server.last();
  ws.emit({ type: "dialog", question: "Which day?", options: [{ n: 1, label: "Monday" }, { n: 2, label: "Tuesday" }] });
  await tick();
  assert.match(w.fake.sent.map((s) => s.text).join("\n"), /Which day\?[\s\S]*Monday[\s\S]*Tuesday/);
  say(w, "Tuesday please");
  await tick();
  assert.ok(ws.frames.some((f) => f.type === "key" && f.key === "escape"));
  ws.emit({ type: "turn-done" });
  await tick();
  assert.deepEqual(ws.prompts().map((p) => p.text), ["book me", "Tuesday please"]);
  await w.stop();
});

test("reattach: a live bound agent gets its bridge back at start; an idle one is left alone", async () => {
  const server = new FakeServer();
  server.channels = [
    { sessionId: "live", cwd: "/x", whatsapp: { account: ACCOUNT, id: LID } },
    { sessionId: "idle", cwd: "/y", whatsapp: { account: ACCOUNT, id: "100000000000002@lid" } },
    { sessionId: "other", cwd: "/z", whatsapp: { account: "33699999999@s.whatsapp.net", id: "100000000000003@lid" } },
  ];
  const probed: string[] = [];
  const w = await world({ server, alive: (id) => (probed.push(id), id !== "idle") });
  await w.link();
  w.bridge.reconcile();
  await tick();
  assert.deepEqual(server.sockets.map((s) => s.start.resume), ["live"]);
  // Steady state: the bridge exists, so the next pass probes nothing for it.
  probed.length = 0;
  w.bridge.reconcile();
  assert.ok(!probed.includes("live"));
  // The agent speaks unprompted (a schedule): it reaches the person.
  server.last().emit({ type: "stream-text", text: "Your daily summary" });
  await tick();
  assert.deepEqual(w.fake.sent, [{ to: LID, text: "Your daily summary" }]);
  await w.stop();
});

test("an answer written while the link is down waits for the reconnect instead of being dropped", async () => {
  const w = await world();
  await w.link();
  say(w, "hi");
  await tick();
  w.fake.script.drop();
  await tick();
  w.server.last().emit({ type: "stream-text", text: "late answer" });
  await tick();
  assert.deepEqual(w.fake.sent, []);
  // The handle reconnects after its backoff (2 s).
  await new Promise((r) => setTimeout(r, 2300));
  await tick();
  assert.deepEqual(w.fake.sent, [{ to: LID, text: "late answer" }]);
  await w.stop();
});

// ── review fixes ────────────────────────────────────────────────────────────

test("the same short text sent again in a later busy turn is preempted again, never silently dropped", async () => {
  const w = await world();
  await w.link();
  say(w, "start");
  await tick();
  const ws = w.server.last();
  say(w, "ok");
  await tick();
  ws.emit({ type: "error", code: "busy", message: "busy" });
  await tick();
  ws.emit({ type: "turn-done" }); // "ok" is resubmitted
  await tick();
  ws.emit({ type: "turn-done" });
  await tick();
  say(w, "ok"); // the SAME text, a new message, during another turn
  await tick();
  ws.emit({ type: "error", code: "busy", message: "busy" });
  await tick();
  assert.equal(ws.frames.filter((f) => f.type === "key").length, 2, "preempted again");
  ws.emit({ type: "turn-done" });
  await tick();
  assert.equal(ws.prompts().filter((p) => p.text === "ok").length, 4, "each send, each re-send");
  await w.stop();
});

test("a resent preempt that meets busy again is said to be lost, not acked in silence", async () => {
  const w = await world();
  await w.link();
  say(w, "start");
  await tick();
  const ws = w.server.last();
  say(w, "second");
  await tick();
  ws.emit({ type: "error", code: "busy", message: "busy" });
  await tick();
  ws.emit({ type: "turn-done" }); // resent…
  await tick();
  ws.emit({ type: "error", code: "busy", message: "busy" }); // …and someone else took the turn
  await tick();
  assert.ok(w.fake.sent.some((s) => /didn't go through/.test(s.text)), JSON.stringify(w.fake.sent));
  assert.deepEqual(w.inbox.pending(), []);
  await w.stop();
});

test("a burst keeps its order: one interruption, then the rest in sequence", async () => {
  const w = await world();
  await w.link();
  say(w, "A");
  await tick();
  const ws = w.server.last();
  say(w, "B");
  await tick();
  ws.emit({ type: "error", code: "busy", message: "busy" });
  await tick();
  say(w, "C");
  await tick();
  assert.equal(ws.frames.filter((f) => f.type === "key").length, 1, "C does not interrupt again");
  ws.emit({ type: "turn-done" });
  await tick();
  w.bridge.reconcile();
  await tick();
  ws.emit({ type: "turn-done" });
  await tick();
  // The first "B" frame is the one the server refused as busy: the agent reads A, B, C.
  assert.deepEqual(ws.prompts().map((p) => p.text), ["A", "B", "B", "C"]);
  assert.equal(ws.frames.filter((f) => f.type === "key").length, 1);
  await w.stop();
});

test("a refused RESUME of a known sender tells them, and is not retried every few seconds", async () => {
  const server = new FakeServer();
  server.channels = [{ sessionId: "old", cwd: "/x", whatsapp: { account: ACCOUNT, id: LID } }];
  server.autoReady = false;
  const w = await world({ server, alive: () => true });
  await w.link();
  await tick();
  // The reattach at start is refused (the instance left that group).
  server.last().emit({ type: "error", code: "forbidden", message: "you are not entitled to resume this agent" });
  await tick();
  const n = server.sockets.length;
  w.bridge.reconcile();
  w.bridge.reconcile();
  await tick();
  assert.equal(server.sockets.length, n, "no reattach storm");
  say(w, "hello?");
  await tick();
  server.last().emit({ type: "error", code: "forbidden", message: "you are not entitled to resume this agent" });
  await tick();
  assert.equal(w.fake.sent.length, 1, "the person is told something went wrong");
  assert.deepEqual(w.inbox.pending(), []);
  await w.stop();
});
