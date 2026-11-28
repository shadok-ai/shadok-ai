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
import { guestNotice, type GuestSetup } from "../src/tg-guests.js";

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
  /** Answer a frame the way the server would (a toggle re-broadcasts its question). */
  onOther?: (ws: FakeWs, f: any) => void;
  connect = (): WsLike => {
    const ws = new FakeWs(this);
    this.sockets.push(ws);
    return ws;
  };
  onFrame(ws: FakeWs, f: any) {
    if (f.type !== "start") return void this.onOther?.(ws, f);
    if (!this.autoReady) return;
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

async function world(o: { setup?: GuestSetup; dir?: string; server?: FakeServer; fake?: ReturnType<typeof makeFakeTransport>; alive?: (id: string) => boolean; multiTenant?: boolean } = {}) {
  const root = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "wa-bridge-"));
  const fake = o.fake ?? makeFakeTransport();
  const server = o.server ?? new FakeServer();
  const lines: string[] = [];
  let setup = o.setup ?? OPEN;
  const handle = startWhatsApp({ sessionDir: path.join(root, "session"), refusal: null, loadFactory: async () => fake.factory, log: () => {} });
  const inbox = openInbox(path.join(root, "state", "inbox.json"), { log: () => {} });
  const mediaDir = path.join(root, "group-media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const agentFiles = new Map<string, Buffer>();
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
    stagingDir: path.join(root, "state", "media"),
    multiTenant: o.multiTenant,
    mediaDirFor: (sid) => {
      if (!sid) throw new Error("no agent yet");
      return mediaDir;
    },
    readAgentFile: async (_sid, p) => {
      const b = agentFiles.get(p);
      if (!b) throw new Error("not a readable file");
      return b;
    },
    transcribe: (async (p: string) =>
      fs.readFileSync(p, "utf8").startsWith("SPEECH:")
        ? { ok: true as const, text: fs.readFileSync(p, "utf8").slice(7) }
        : { ok: false as const, kind: "empty" as const, notice: "rien compris" }) as never,
    lookAtVideo: async () => ({ durationSec: 4, frames: [{ path: path.join(mediaDir, "f1.jpg"), atSec: 1 }] }),
  });
  return {
    root,
    fake,
    server,
    handle,
    inbox,
    bridge,
    lines,
    mediaDir,
    agentFiles,
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
  assert.deepEqual(w.fake.reads, [], "a shut door never shows \"seen\" either");
  await w.stop();
});

test("a message is marked seen once its agent TOOK it (prompt-id), not on receipt — and only once", async () => {
  const w = await world();
  await w.link();
  say(w, "hello there", { id: "M1" });
  await tick();
  assert.deepEqual(w.fake.reads, [], "received is not read: the agent has not taken it yet");
  const ws = w.server.last();
  ws.emit({ type: "prompt-id", msgId: "u1", text: "hello there" });
  await tick();
  assert.deepEqual(w.fake.reads, [{ chat: LID, id: "M1" }]);
  ws.emit({ type: "turn-done" });
  await tick();
  assert.equal(w.fake.reads.length, 1, "the turn's end does not mark it a second time");
  await w.stop();
});

test("the receipt names the chat the message ARRIVED on, even when the agent is keyed by the LID", async () => {
  const w = await world();
  await w.link();
  say(w, "from my phone number", { id: "P1", chat: PN, chatAlt: LID });
  await tick();
  const ws = w.server.last();
  assert.equal(ws.start.guestKey, LID);
  ws.emit({ type: "turn-done" });
  await tick();
  assert.deepEqual(w.fake.reads, [{ chat: PN, id: "P1" }]);
  await w.stop();
});

test("a message refused before it reached the agent is never marked seen", async () => {
  const w = await world();
  await w.link();
  say(w, "please", { id: "R1" });
  await tick();
  w.server.last().emit({ type: "pace-blocked" });
  await tick();
  assert.deepEqual(w.inbox.pending(), []);
  assert.deepEqual(w.fake.reads, []);
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

test("a restart of an idle agent (working, then ready, no turn-done) does not leave typing on", async () => {
  const w = await world();
  await w.link();
  say(w, "hi");
  await tick();
  const ws = w.server.last();
  ws.emit({ type: "working" });
  ws.emit({ type: "turn-done" });
  await tick();
  // A reload / auto-reload: the server's restartSession says `working` then
  // `ready`, and nothing else — there is no turn.
  ws.emit({ type: "working", startedAt: Date.now(), elapsedMs: 0 });
  ws.emit({ type: "ready", sessionId: ws.start.resume ?? w.server.channels[0].sessionId });
  await tick();
  assert.deepEqual(w.fake.typing.at(-1), { to: LID, on: false }, "typing must end with the restart");
  // A turn that really runs after the ready still shows typing.
  ws.emit({ type: "working" });
  await tick();
  assert.deepEqual(w.fake.typing.at(-1), { to: LID, on: true });
  await w.stop();
});

test("both bridges stop typing on `ready` — a restart sends no turn-done", () => {
  for (const f of ["../src/wa-bridge.ts", "../src/telegram.ts"]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    const at = src.search(/case "ready":/);
    assert.ok(at >= 0, f);
    assert.match(src.slice(at, at + 900), /b\.typing\.stop\(\)/, `${f}: the ready handler must stop typing`);
  }
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

test("the door at its ceiling: the person IS told, and their next message asks again", async () => {
  // The one exception to "no agent, no binding, nothing sent" above: a ceiling
  // refusal (`guestAdmitVerdict`) is the one the person has to hear, or their
  // message simply vanishes. It goes through `noticeTo` — allowed because they
  // wrote seconds ago — and the words must NOT be "send that again": nothing
  // they can do changes a ceiling.
  const w = await world();
  w.server.autoReady = false;
  await w.link();
  say(w, "hello?");
  await tick();
  w.server.last().emit({
    type: "error",
    code: "guest-full",
    message: "this instance is already holding its maximum of 200 guest conversations",
  });
  await tick();
  assert.equal(w.server.last().readyState, 3, "the socket is closed: it will never be ready");
  assert.deepEqual(w.inbox.pending(), [], "the message is freed, not replayed for ever");
  assert.deepEqual(w.fake.sent, [{ to: LID, text: guestNotice("door-full") }]);
  assert.doesNotMatch(w.fake.sent[0].text, /again right now|send that again/);
  assert.ok(w.lines.some((l) => /guest spawn was refused \(guest-full\)/.test(l)), "said to the admin");
  // The ceiling can clear, so "later" has to be an instruction that works: the
  // next message must ask the server again rather than queue for ever.
  const before = w.server.sockets.length;
  w.server.autoReady = true;
  say(w, "still there?", { id: "F2" });
  await tick();
  assert.ok(w.server.sockets.length > before, "a fresh spawn was attempted");
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

// ── step 3: media in, files out, questions, the unreadable message ──────────

const photo = (w: Awaited<ReturnType<typeof world>>, o: { id?: string; caption?: string; size?: number } = {}) =>
  w.fake.script.deliver({ id: o.id ?? "P1", chat: LID, chatAlt: PN, pushName: "Grace", media: { kind: "image", mime: "image/jpeg", ...(o.size ? { size: o.size } : {}) }, mediaData: "JPEGDATA", ...(o.caption ? { text: o.caption } : {}) });

// The agent runs as the GROUP's OS user and reads the file through the group
// bit. A copy that kept the server's own group was 0640 and unreadable by the
// very agent it was announced to.
test("multi-tenant: the handed file belongs to the media directory's group, not the server's", async (t) => {
  const other = (process.getgroups?.() ?? []).find((g) => g !== process.getgid?.());
  if (other === undefined) return t.skip("needs a second group to tell the directory's group from the server's");
  const w = await world({ multiTenant: true });
  fs.chownSync(w.mediaDir, process.getuid!(), other);
  fs.chmodSync(w.mediaDir, 0o2750);
  await w.link();
  photo(w);
  await tick(60);
  const st = fs.statSync(path.join(w.mediaDir, "wa-P1.jpg"));
  assert.equal(st.gid, other);
  assert.equal(st.mode & 0o777, 0o640);
  await w.stop();
});

test("a photo reaches its agent from the GROUP media directory, its caption riding along; the staging copy goes with the ack", async () => {
  const w = await world();
  await w.link();
  photo(w, { caption: "is this the right one?" });
  await tick(60);
  const ws = w.server.last();
  const p = ws.prompts()[0];
  const dest = path.join(w.mediaDir, "wa-P1.jpg");
  assert.equal(p.text, `[Attached image: ${dest}]\nis this the right one?`);
  assert.equal(fs.readFileSync(dest, "utf8"), "JPEGDATA");
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  assert.equal(w.inbox.pending().length, 1);
  ws.emit({ type: "prompt-id", text: p.text });
  await tick();
  assert.deepEqual(w.inbox.pending(), []);
  assert.deepEqual(fs.readdirSync(path.join(w.root, "state", "media")), [], "staging cleaned");
  await w.stop();
});

test("a document is a file line; a video gets its stills like on Telegram", async () => {
  const w = await world();
  await w.link();
  w.fake.script.deliver({ id: "D1", chat: LID, media: { kind: "document", mime: "application/pdf", fileName: "price list.pdf" }, mediaData: "PDF" });
  await tick(60);
  assert.match(w.server.last().prompts()[0].text, /^\[Attached file: .*wa-D1-price list\.pdf\]$/);
  w.fake.script.deliver({ id: "V1", chat: LID, media: { kind: "video", mime: "video/mp4" }, mediaData: "MP4" });
  await tick(60);
  w.server.last().emit({ type: "turn-done" });
  await tick(60);
  const v = w.server.last().prompts().at(-1)!.text;
  assert.match(v, /\[Attached video: .*wa-V1\.mp4 \(0:04\)\]/);
  assert.match(v, /Stills from it/);
  await w.stop();
});

test("a voice note is transcribed, echoed back, and sent marked as spoken", async () => {
  const w = await world();
  await w.link();
  w.fake.script.deliver({ id: "A1", chat: LID, media: { kind: "audio", mime: "audio/ogg; codecs=opus", voice: true }, mediaData: "SPEECH:is the shop open on sunday" });
  await tick(60);
  const p = w.server.last().prompts()[0];
  assert.equal(p.text, "is the shop open on sunday");
  assert.equal(p.voice, true);
  assert.ok(w.fake.sent.some((s) => s.text.includes("is the shop open on sunday") && s.text.startsWith("🎙")), "what was understood is echoed");
  await w.stop();
});

test("a voice note that cannot be transcribed is said in guest words, and freed", async () => {
  const w = await world();
  await w.link();
  w.fake.script.deliver({ id: "A2", chat: LID, media: { kind: "audio", voice: true }, mediaData: "noise" });
  await tick(60);
  assert.equal(w.server.last().prompts().length, 0);
  assert.ok(w.fake.sent.some((s) => s.text === guestNotice("voice-failed")));
  assert.doesNotMatch(w.fake.sent.map((s) => s.text).join(), /rien compris/, "never the pipeline's own (operator) wording");
  assert.deepEqual(w.inbox.pending(), []);
  await w.stop();
});

test("a file over the limit is refused BEFORE downloading, with one line, and starts nothing", async () => {
  const w = await world();
  await w.link();
  photo(w, { size: 60 * 1024 * 1024 });
  await tick(60);
  assert.equal(w.server.sockets.length, 0);
  assert.deepEqual(w.fake.sent, [{ to: LID, text: guestNotice("too-large") }]);
  assert.deepEqual(w.inbox.pending(), []);
  await w.stop();
});

test("an unreadable first message: one notice, nothing spawned, nothing stored — and its later readable copy is processed", async () => {
  const w = await world();
  await w.link();
  w.fake.script.deliver({ id: "U1", chat: LID, unreadable: true });
  w.fake.script.deliver({ id: "U2", chat: LID, unreadable: true });
  await tick();
  assert.equal(w.server.sockets.length, 0);
  assert.deepEqual(w.fake.sent, [{ to: LID, text: guestNotice("unreadable") }], "once, not twice");
  assert.deepEqual(w.inbox.pending(), []);
  // The library's resend brings the content, under the same id.
  w.fake.script.deliver({ id: "U1", chat: LID, text: "hello, it's me" });
  await tick();
  assert.deepEqual(w.server.last().prompts().map((p) => p.text), ["hello, it's me"]);
  await w.stop();
});

test("an unreadable message with the door shut: silence", async () => {
  const w = await world({ setup: SHUT });
  await w.link();
  w.fake.script.deliver({ id: "U1", chat: LID, unreadable: true });
  await tick();
  assert.deepEqual(w.fake.sent, []);
  await w.stop();
});

test("a medium that waited for its agent survives a restart, and reaches it once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-bridge-"));
  const server = new FakeServer();
  const fake = makeFakeTransport();
  server.autoReady = false;
  const a = await world({ dir: root, server, fake });
  await a.link();
  photo(a, { id: "R1" });
  await tick(60);
  await a.stop();
  for (const s of server.sockets) s.close();
  server.autoReady = true;
  const b = await world({ dir: root, server, fake });
  await b.link();
  await tick(60);
  const prompts = server.sockets.flatMap((s) => s.prompts().map((p) => p.text));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /\[Attached image: .*wa-R1\.jpg\]/);
  await b.stop();
});

test("a file the agent hands over goes as a picture or a document, read with the agent's rights, to the binding only", async () => {
  const w = await world();
  await w.link();
  say(w, "send me the menu");
  await tick();
  w.agentFiles.set("/home/g1/wa-1/menu.png", Buffer.from("PNG"));
  w.agentFiles.set("/home/g1/wa-1/quote.pdf", Buffer.from("PDF!"));
  const ws = w.server.last();
  ws.emit({ type: "stream-tool", name: "ShadokFile", files: [{ path: "/home/g1/wa-1/menu.png", name: "menu.png" }, { path: "/home/g1/wa-1/quote.pdf", name: "quote.pdf" }] });
  ws.emit({ type: "stream-tool", name: "SendUserFile", files: [{ path: "/etc/shadow", name: "shadow" }] });
  ws.emit({ type: "stream-tool", name: "Read", summary: "/etc/passwd" });
  await tick(60);
  assert.deepEqual(w.fake.files, [
    { to: LID, name: "menu.png", mime: "image/png", image: true, size: 3 },
    { to: LID, name: "quote.pdf", mime: "application/pdf", image: false, size: 4 },
  ]);
  assert.deepEqual(w.fake.sent, [], "a refused read and a tool call say nothing to a guest");
  // Once the binding is gone, nothing more goes out.
  w.server.channels = [];
  ws.emit({ type: "stream-tool", name: "ShadokFile", files: [{ path: "/home/g1/wa-1/menu.png", name: "menu.png" }] });
  await tick(60);
  assert.equal(w.fake.files.length, 2);
  await w.stop();
});

const dlg = { type: "dialog", question: "Which day?", multi: false, options: [{ n: 1, label: "Monday" }, { n: 2, label: "Tuesday" }, { n: 3, label: "Type something." }] };

test("a question is a numbered list; the number answers it", async () => {
  const w = await world();
  await w.link();
  say(w, "book me");
  await tick();
  const ws = w.server.last();
  ws.emit(dlg);
  await tick();
  assert.match(w.fake.sent.at(-1)!.text, /Which day\?\n\n1\. Monday\n2\. Tuesday\n3\. Type something\./);
  say(w, "2", { id: "A2" });
  await tick();
  assert.deepEqual(ws.frames.filter((f) => f.type === "choose"), [{ type: "choose", n: 2 }]);
  assert.equal(ws.prompts().length, 1, "an answer is not a prompt");
  assert.deepEqual(w.fake.reads, [{ chat: LID, id: "A2" }], "an answer was read: it is marked seen");
  assert.deepEqual(w.inbox.pending().map((e) => e.text), ["book me"]);
  await w.stop();
});

test("an own answer: number then words, or the number then the words in the next message; anything else is asked again", async () => {
  const w = await world();
  await w.link();
  say(w, "book me");
  await tick();
  const ws = w.server.last();
  ws.emit(dlg);
  await tick();
  say(w, "maybe");
  await tick();
  // One own-answer option: a sentence IS that answer.
  assert.deepEqual(ws.frames.filter((f) => f.type === "freetext"), [{ type: "freetext", n: 3, text: "maybe" }]);
  ws.emit({ ...dlg, question: "Which time?" });
  await tick();
  say(w, "3");
  await tick();
  assert.equal(w.fake.sent.at(-1)!.text, guestNotice("need-text"));
  say(w, "after lunch");
  await tick();
  assert.deepEqual(ws.frames.filter((f) => f.type === "freetext").at(-1), { type: "freetext", n: 3, text: "after lunch" });
  ws.emit({ type: "dialog", question: "Sure?", multi: false, options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] });
  await tick();
  say(w, "what?");
  await tick();
  assert.equal(w.fake.sent.at(-1)!.text, guestNotice("dialog-again"));
  await w.stop();
});

test("a multiple choice toggles one at a time, waiting for each to land, then submits", async () => {
  const w = await world();
  await w.link();
  say(w, "extras?");
  await tick();
  const ws = w.server.last();
  let opts = [{ n: 1, label: "Milk", checked: true }, { n: 2, label: "Sugar" }, { n: 3, label: "Lemon" }];
  const order: string[] = [];
  let landed = 0;
  w.server.onOther = (s, f) => {
    // "@n": how many toggles had LANDED (been re-broadcast) when this frame left.
    order.push(`${f.type}${f.n ?? ""}@${landed}`);
    if (f.type !== "toggle") return;
    opts = opts.map((o) => (o.n === f.n ? { ...o, checked: !o.checked } : o));
    setTimeout(() => {
      landed++;
      s.emit({ type: "dialog", question: "Which extras?", multi: true, options: opts });
    }, 20);
  };
  ws.emit({ type: "dialog", question: "Which extras?", multi: true, options: opts });
  await tick();
  assert.match(w.fake.sent.at(-1)!.text, /1\. ☑ Milk/);
  const before = w.fake.sent.length;
  say(w, "2 3");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(order, ["toggle1@0", "toggle2@1", "toggle3@2", "confirm@3"]);
  assert.equal(w.fake.sent.length, before, "a re-broadcast after a toggle is not sent again");
  await w.stop();
});

test("an agent closed in the cockpit: the person is told once that their next message starts afresh", async () => {
  const w = await world();
  await w.link();
  say(w, "hi");
  await tick();
  w.server.channels = [];
  w.server.last().emit({ type: "stopped" });
  await tick();
  assert.deepEqual(w.fake.sent, [{ to: LID, text: guestNotice("ended") }]);
  await w.stop();
});

test("a refused spawn frees a medium still waiting for its agent: nothing staged, nothing replayed", async () => {
  const w = await world();
  w.server.autoReady = false;
  await w.link();
  photo(w, { id: "X1" });
  await tick(60);
  w.server.last().emit({ type: "error", code: "guest-group", message: "the configured guest group is not usable from here" });
  await tick(60);
  assert.deepEqual(w.inbox.pending(), []);
  assert.deepEqual(fs.readdirSync(path.join(w.root, "state", "media")), []);
  const n = w.server.sockets.length;
  w.bridge.reconcile();
  await tick(60);
  assert.equal(w.server.sockets.length, n, "no respawn storm");
  await w.stop();
});

test("a socket that dies before ready does not wedge the person: the medium is replayed to a fresh one", async () => {
  const w = await world();
  w.server.autoReady = false;
  await w.link();
  photo(w, { id: "W1" });
  await tick(60);
  w.server.last().close(); // the server went away mid-spawn
  await tick(60);
  w.server.autoReady = true;
  w.bridge.reconcile();
  await tick(80);
  const prompts = w.server.sockets.flatMap((s) => s.prompts().map((p) => p.text));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /wa-W1\.jpg/);
  await w.stop();
});

// ── review fixes (step 3) ───────────────────────────────────────────────────

test("after a multiple-choice answer, the person's next message is a PROMPT, not a stale answer", async () => {
  const w = await world();
  await w.link();
  say(w, "extras?");
  await tick();
  const ws = w.server.last();
  let opts = [{ n: 1, label: "Milk" }, { n: 2, label: "Sugar" }];
  w.server.onOther = (s, f) => {
    if (f.type !== "toggle") return;
    opts = opts.map((o) => (o.n === f.n ? { ...o, checked: true } : o));
    setTimeout(() => s.emit({ type: "dialog", question: "Which extras?", multi: true, options: opts }), 10);
  };
  ws.emit({ type: "dialog", question: "Which extras?", multi: true, options: opts });
  await tick();
  say(w, "1 2");
  await new Promise((r) => setTimeout(r, 150));
  ws.emit({ type: "working" });
  say(w, "also check the price");
  await tick();
  assert.deepEqual(ws.prompts().map((p) => p.text), ["extras?", "also check the price"]);
  assert.ok(!w.fake.sent.some((s) => s.text === guestNotice("dialog-again")));
  await w.stop();
});

test("the same question asked AGAIN after it was answered is shown again", async () => {
  const w = await world();
  await w.link();
  say(w, "go");
  await tick();
  const ws = w.server.last();
  const yesNo = { type: "dialog", question: "Do you want to proceed?", multi: false, options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] };
  ws.emit(yesNo);
  await tick();
  say(w, "1");
  await tick();
  ws.emit(yesNo); // a second, byte-identical ask within the same turn (invariant 21)
  await tick();
  assert.equal(w.fake.sent.filter((s) => s.text.includes("Do you want to proceed?")).length, 2);
  say(w, "2");
  await tick();
  assert.deepEqual(ws.frames.filter((f) => f.type === "choose").map((f) => f.n), [1, 2]);
  await w.stop();
});

test("a question answered from the cockpit stops arming: the next message is a prompt", async () => {
  const w = await world();
  await w.link();
  say(w, "go");
  await tick();
  const ws = w.server.last();
  ws.emit({ type: "dialog", question: "Sure?", multi: false, options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] });
  await tick();
  ws.emit({ type: "working" }); // the operator clicked an answer; the turn resumed
  say(w, "thanks!");
  await tick();
  assert.deepEqual(ws.prompts().map((p) => p.text), ["go", "thanks!"]);
  await w.stop();
});

test("an unreadable copy of a message already received says nothing", async () => {
  const w = await world();
  await w.link();
  say(w, "hello", { id: "S1" });
  await tick();
  w.fake.script.deliver({ id: "S1", chat: LID, unreadable: true });
  await tick();
  assert.ok(!w.fake.sent.some((s) => s.text === guestNotice("unreadable")));
  await w.stop();
});

test("a staging file no pending entry claims is purged at start", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-bridge-"));
  fs.mkdirSync(path.join(root, "state", "media"), { recursive: true });
  fs.writeFileSync(path.join(root, "state", "media", "wa-ORPHAN.jpg"), "x");
  const w = await world({ dir: root });
  await tick();
  assert.deepEqual(fs.readdirSync(path.join(root, "state", "media")), []);
  await w.stop();
});
