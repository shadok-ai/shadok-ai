import { type GuestNotice, type GuestSetup, guestNotice, guestsOpen } from "./tg-guests.js";
import { makeSendQueue, makeTyping, promptEchoLabel, shouldPreempt } from "./telegram.js";
import { bareJid, findWaChannel, inboundVerdict, sendAllowed, senderKey, waReattachList, type WaBinding, type WaInbound } from "./wa-guests.js";
import { mdToWhatsApp, neutralizeCommand, stripAttachmentMarkers, waChunks } from "./wa-format.js";
import type { Inbox, InboxEntry } from "./wa-inbox.js";
import type { WhatsAppHandle } from "./whatsapp.js";

/**
 * The WhatsApp bridge: anyone who writes to the linked number talks to an agent
 * of their own — the WhatsApp twin of Telegram's guest DMs.
 *
 * Shaped like Telegram's: each person gets ONE loopback WebSocket to our own
 * server (`connect` presents the internal cookie AND the WhatsApp bridge
 * secret), so their agent is the same `Live` the cockpit shows, and the server
 * — not this file — decides the origin (`whatsapp`), the group and the profile
 * from what the socket proved (invariants 49 and 61). What this file decides
 * is pure and lives in `wa-guests.ts` / `wa-format.ts`; what must survive a
 * restart lives in the inbox (`wa-inbox.ts`).
 *
 * Three promises this file is built around:
 *  - **one person, one agent** — a LID and a phone-number address for the same
 *    person resolve to one binding (`findWaChannel`), and a row bound under the
 *    phone number is re-keyed to the LID the day it shows up;
 *  - **nothing lost, nothing twice** — every message is in the inbox before
 *    anything else happens, and leaves it only once the server says the prompt
 *    landed (`prompt-id`, or the turn's end) or the person was told it did not;
 *  - **the bridge never writes first** — it only ever sends to a bridge, a
 *    bridge only exists for a sender, and every send re-checks the target is
 *    an existing binding of the linked account (`sendAllowed`).
 */

/** The slice of a `ws` WebSocket the bridge uses (a fake in tests). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(ev: "open" | "message" | "close" | "error", fn: (arg?: any) => void): void;
}

export interface WaBridgeDeps {
  handle: Pick<
    WhatsAppHandle,
    "onMessage" | "onConnected" | "account" | "sendText" | "setTyping" | "resolveLid" | "whenConnected"
  >;
  /** A loopback socket to our own /ws, proving the WhatsApp bridge secret. */
  connect: () => WsLike;
  /** The WhatsApp guest door, read LIVE on every message: the panel's save
   *  needs no restart, and a door shut a second ago is shut. */
  setup: () => GuestSetup;
  channels: {
    load(): { sessionId: string; whatsapp?: WaBinding | null; profile?: string | null; name?: string }[];
    upsert(patch: { sessionId: string; whatsapp?: WaBinding; name?: string }): void;
  };
  inbox: Inbox;
  /** Is this agent's process alive? (a tmux probe in the server). */
  sessionAlive: (sessionId: string) => boolean;
  log?: (line: string) => void;
  /** Between two messages to one person: a burst of sends is what gets a
   *  number flagged, and order must hold anyway. */
  spacingMs?: number;
  /** How long an answer waits for a dropped link to come back before it is
   *  given up (and logged). */
  sendWaitMs?: number;
  /** The reattach loop's period; 0 = no timer (tests drive `reconcile`). */
  reattachMs?: number;
  /** How long a preempt may take before the message is declared lost. */
  preemptMs?: number;
}

export interface WaBridge {
  /** One reattach + replay pass (also run by the timer). */
  reconcile(): void;
  stop(): void;
  /** How many person bridges are open (for the log and the tests). */
  size(): number;
}

interface Bridge {
  /** The sender key this bridge was opened for (canonical at the time). */
  key: string;
  /** Where the person's messages are sent: the binding's id. */
  to: string;
  /** The linked account this conversation belongs to. */
  account: string;
  phone?: string;
  name?: string;
  ws: WsLike;
  sessionId: string | null;
  ready: boolean;
  /** Frames waiting for `ready`. */
  pending: object[];
  send: ReturnType<typeof makeSendQueue>;
  typing: { start(): void; stop(): void };
  /** Inbox entries submitted and not yet acknowledged by the server. */
  awaiting: InboxEntry[];
  /** The entry held back while a running turn (or a question) is interrupted. */
  preempting?: InboxEntry;
  /** Messages that arrived while a preempt was already under way: they wait
   *  their turn, in order, rather than interrupt again (a burst of short texts
   *  is ordinary WhatsApp use). */
  held: InboxEntry[];
  /** Opened to RESUME an existing binding (as opposed to a fresh spawn). */
  isResume: boolean;
  preemptTimer?: NodeJS.Timeout;
  lastRetried?: string;
  /** A question is on the screen: the next message dismisses it first. */
  dialogUp: boolean;
  lastDialog?: string;
  /** Ended for good (stopped, refused): its close is not a reason to replay. */
  closing: boolean;
}

const MAX_NAME = 64;
const cleanName = (s: string | undefined) => (s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_NAME) || undefined;
const digits = (jid: string) => jid.slice(0, jid.indexOf("@"));

export function startWaBridge(d: WaBridgeDeps): WaBridge {
  const log = d.log ?? ((l: string) => console.log(l));
  const spacing = d.spacingMs ?? 400;
  const sendWait = d.sendWaitMs ?? 5 * 60_000;
  const preemptMs = d.preemptMs ?? 20_000;
  const bridges = new Set<Bridge>();
  let stopped = false;
  /** Agents whose resume the server refused (the instance left their group, a
   *  sign-out): the reattach loop leaves them alone for a while instead of
   *  opening a socket every few seconds. A person writing still retries. */
  const refusedUntil = new Map<string, number>();
  const REFUSED_BACKOFF_MS = 10 * 60_000;

  const alive = (b: Bridge) => !b.closing && b.ws.readyState <= 1;
  const short = (b: Bridge) => (b.sessionId ? b.sessionId.slice(0, 8) : "new");

  // ── sending ──────────────────────────────────────────────────────────────
  /** One text to one person, through their queue, in order, spaced; waiting
   *  out a dropped link rather than dropping the answer. */
  const sendTo = (b: Bridge, text: string): Promise<void> =>
    b.send(async () => {
      for (const part of waChunks(text)) {
        // Re-checked at the moment of sending, against the registry: the
        // binding may have been closed since the answer was written.
        if (!sendAllowed(d.channels.load(), b.account, b.to) || d.handle.account() !== b.account) {
          log(`whatsapp: ${short(b)} — not sent: the recipient is not a binding of the linked number`);
          return;
        }
        try {
          await d.handle.sendText(b.to, part);
        } catch {
          if (!(await d.handle.whenConnected(sendWait))) {
            log(`whatsapp: ${short(b)} — message NOT delivered: the link did not come back in time`);
            return;
          }
          try {
            await d.handle.sendText(b.to, part);
          } catch (e) {
            log(`whatsapp: ${short(b)} — message NOT delivered: ${(e as Error)?.message ?? e}`);
            return;
          }
        }
        if (spacing) await new Promise((r) => setTimeout(r, spacing));
      }
    });

  /** A line the bridge says about itself: always in guest words (`guestNotice`)
   *  — every WhatsApp sender is a guest — or nothing at all. */
  const notice = (b: Bridge, kind: GuestNotice) => {
    const line = guestNotice(kind);
    if (line) void sendTo(b, line);
  };

  // ── prompts and acknowledgement ──────────────────────────────────────────
  const frame = (b: Bridge, f: object) => {
    if (b.ready && b.ws.readyState === 1) b.ws.send(JSON.stringify(f));
    else b.pending.push(f);
  };
  const submit = (b: Bridge, e: InboxEntry) => {
    b.awaiting.push(e);
    frame(b, { type: "prompt", text: neutralizeCommand(e.text), ...(e.name ? { from: e.name } : {}) });
  };
  const ack = (e: InboxEntry) => d.inbox.ack(e.id);
  const ackAll = (b: Bridge) => {
    for (const e of b.awaiting.splice(0)) ack(e);
    for (const e of b.held.splice(0)) ack(e);
    if (b.preempting) {
      ack(b.preempting);
      b.preempting = undefined;
      clearTimeout(b.preemptTimer);
    }
  };
  /** Take the hand back (a running turn, or a question on screen), then send
   *  `e` once the turn has settled — Telegram's preempt, same bound. */
  const preempt = (b: Bridge, e: InboxEntry) => {
    // One interruption at a time: a message arriving while one is under way
    // queues behind it — overwriting it would orphan the first and replay it
    // later, out of order, interrupting again.
    if (b.preempting) {
      b.held.push(e);
      return;
    }
    b.preempting = e;
    b.lastRetried = e.text;
    frame(b, { type: "key", key: "escape" });
    clearTimeout(b.preemptTimer);
    b.preemptTimer = setTimeout(() => {
      if (b.preempting !== e) return;
      b.preempting = undefined;
      b.typing.stop();
      ack(e);
      notice(b, "preempt-failed");
    }, preemptMs);
    b.preemptTimer.unref?.();
  };
  const promptEntry = (b: Bridge, e: InboxEntry) => {
    // A NEW message reopens the right to interrupt (Telegram clears it the
    // same way): kept from an earlier preempt, the same short text sent again
    // later would meet `busy`, fail `shouldPreempt`, and be lost.
    b.lastRetried = undefined;
    if (b.preempting) {
      b.held.push(e);
      return;
    }
    if (b.dialogUp && b.ready) {
      // Numbered answers are step 3; until then a reply to a question is a
      // new message, and the question is dismissed so it can go in.
      b.dialogUp = false;
      preempt(b, e);
      return;
    }
    submit(b, e);
  };

  // ── the person's socket ──────────────────────────────────────────────────
  const open = (o: { key: string; to: string; account: string; resume?: string; profile?: string | null; name?: string; phone?: string }): Bridge => {
    const ws = d.connect();
    const b: Bridge = {
      key: o.key,
      to: o.to,
      account: o.account,
      ...(o.phone ? { phone: o.phone } : {}),
      ...(o.name ? { name: o.name } : {}),
      ws,
      sessionId: o.resume ?? null,
      ready: false,
      pending: [],
      send: makeSendQueue(),
      typing: { start() {}, stop() {} },
      awaiting: [],
      held: [],
      isResume: !!o.resume,
      dialogUp: false,
      closing: false,
    };
    // Typing is a frame to the person too: same guard as a text.
    const typingTo = (on: boolean) => {
      if (d.handle.account() !== b.account || !sendAllowed(d.channels.load(), b.account, b.to)) return;
      void d.handle.setTyping(b.to, on).catch(() => {});
    };
    const beat = makeTyping(() => typingTo(true), 8000);
    b.typing = {
      start: () => beat.start(),
      stop: () => {
        beat.stop();
        typingTo(false);
      },
    };
    bridges.add(b);

    ws.on("open", () => {
      ws.send(
        JSON.stringify(
          o.resume
            ? { type: "start", resume: o.resume, origin: "whatsapp", ...(o.profile ? { profile: o.profile } : {}) }
            : {
                type: "start",
                origin: "whatsapp",
                worktree: false,
                // The marker says only "this is a guest": the group and the
                // profile are resolved by the server from the WhatsApp door,
                // because this socket proved the WhatsApp secret. `guestKey`
                // names the person's own directory (`waGuestWorkDirName`) and
                // nothing else.
                guest: true,
                guestKey: o.key,
              },
        ),
      );
    });

    ws.on("message", (raw: unknown) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (m.type) {
        case "ready": {
          b.sessionId = m.sessionId;
          b.ready = true;
          // The binding, written ONCE per spawn and re-asserted on a resume.
          // Never `mirror`: a guest's conversation is published nowhere else.
          const existing = d.channels.load().find((c) => c.sessionId === b.sessionId);
          d.channels.upsert({
            sessionId: b.sessionId!,
            whatsapp: { account: b.account, id: b.to, ...(b.phone ? { phone: b.phone } : existing?.whatsapp?.phone ? { phone: existing.whatsapp.phone } : {}) },
            // Named after the person, as Telegram guests are; a rename made
            // in the cockpit since is theirs to keep.
            ...(b.name && !existing?.name ? { name: b.name } : {}),
          });
          for (const f of b.pending.splice(0)) ws.send(JSON.stringify(f));
          break;
        }
        case "working":
          b.typing.start();
          break;
        case "stream-text":
          if (typeof m.text === "string" && m.text.trim()) void sendTo(b, mdToWhatsApp(m.text));
          break;
        case "prompt-echo": {
          // The server already excludes the sender: this is someone ELSE — the
          // operator in the cockpit — and it reaches the person labelled, as
          // on Telegram.
          if (typeof m.text !== "string" || !m.text.trim()) break;
          void sendTo(b, `${promptEchoLabel(m.origin, m.auto, m.from)}\n${mdToWhatsApp(stripAttachmentMarkers(m.text))}`);
          break;
        }
        case "prompt-id": {
          // The transcript recorded a prompt: if it is one of ours, it landed.
          const said = String(m.text ?? "").trim();
          if (!said) break;
          // Exact, or containment of a text long enough not to match by
          // accident ("ok" must not be acked by an operator's prompt saying it).
          const i = b.awaiting.findIndex((e) => {
            const t = neutralizeCommand(e.text).trim();
            return !!t && (said === t || (t.length >= 16 && said.includes(t)));
          });
          if (i >= 0) ack(b.awaiting.splice(i, 1)[0]);
          break;
        }
        case "dialog": {
          b.typing.stop();
          b.dialogUp = true;
          // A multi-select re-sends its dialog on every toggle: one message per question.
          const opts = Array.isArray(m.options) ? m.options : [];
          const key = `${m.question}\u0000${opts.map((x: { label?: string }) => x?.label).join("\u0000")}`;
          if (key === b.lastDialog) break;
          b.lastDialog = key;
          const lines = [String(m.question || "").trim(), ...opts.map((x: { label?: string }) => `- ${String(x?.label ?? "").trim()}`)].filter(Boolean);
          if (lines.length) void sendTo(b, lines.join("\n"));
          notice(b, "no-keyboard");
          break;
        }
        case "turn-done": {
          b.dialogUp = false;
          b.lastDialog = undefined;
          // Whatever was submitted before this turn ended has been taken in.
          for (const e of b.awaiting.splice(0)) ack(e);
          if (b.preempting) {
            const e = b.preempting;
            b.preempting = undefined;
            clearTimeout(b.preemptTimer);
            submit(b, e);
            break;
          }
          // What queued behind an interruption goes next, one turn each.
          const next = b.held.shift();
          if (next) {
            submit(b, next);
            break;
          }
          b.typing.stop();
          break;
        }
        case "pace-blocked": {
          // The prompt was NOT sent: say so, and free the inbox — the person
          // is asked to send it again, so keeping it would send it twice.
          b.typing.stop();
          const e = b.awaiting.pop();
          if (e) ack(e);
          notice(b, "pace-blocked");
          break;
        }
        case "error": {
          const last = b.awaiting.at(-1);
          if (last && shouldPreempt({ code: m.code, text: last.text, lastRetried: b.lastRetried })) {
            b.awaiting.pop();
            preempt(b, last);
            break;
          }
          if (!b.ready && b.isResume) {
            // An EXISTING binding the server will not resume (the instance
            // left its group when the door moved, a sign-out). Not a fresh
            // spawn: the person HAS a binding, so they are told, the message
            // is freed rather than replayed for ever, and the reattach loop
            // backs off. The agent itself is not ended — an inferred refusal
            // ends nothing; closing it is the operator's act.
            log(`whatsapp: ${short(b)} — its resume was refused (${m.code ?? "error"}): ${String(m.message ?? "").slice(0, 160)}`);
            if (b.sessionId) refusedUntil.set(b.sessionId, Date.now() + REFUSED_BACKOFF_MS);
            const hadMessage = b.awaiting.length > 0 || !!b.preempting || b.held.length > 0;
            b.pending.length = 0;
            ackAll(b);
            if (hadMessage) notice(b, "error");
            b.closing = true;
            try {
              ws.close();
            } catch {
              /* already closing */
            }
            break;
          }
          if (!b.ready) {
            // A spawn the server refused (the door shut meanwhile, the group
            // unusable, the instance signed out): this bridge will never be
            // ready. End it and free the inbox — a refused message must not be
            // replayed on every reconnect. Nothing is said to the person: no
            // agent means no binding, and the bridge sends to bindings only
            // (`sendAllowed`). The log line is for the admin, whose setup it is.
            log(`whatsapp: a guest spawn was refused (${m.code ?? "error"}): ${String(m.message ?? "").slice(0, 160)}`);
            b.pending.length = 0;
            ackAll(b);
            b.closing = true;
            try {
              ws.close();
            } catch {
              /* already closing */
            }
            break;
          }
          if (m.code === "busy") {
            // A RESENT message (the one a preempt held back) met `busy` again:
            // someone else took the turn in between. Say it is lost rather than
            // acking it in silence at the next turn's end.
            const lost = b.awaiting.pop();
            if (lost) {
              ack(lost);
              notice(b, "preempt-failed");
            }
            break;
          }
          b.typing.stop();
          const e = b.awaiting.pop();
          if (e) ack(e);
          notice(b, m.code === "unresponsive" ? "unresponsive" : "error");
          break;
        }
        case "exited":
          b.typing.stop();
          b.dialogUp = false;
          break;
        case "stopped":
          // The agent was CLOSED in the cockpit: its row is gone, so this
          // bridge points at nothing. Closing it means the person's next
          // message finds no binding and starts a NEW agent — an explicit
          // ending, never an inferred one (a dropped link ends nothing).
          b.typing.stop();
          b.closing = true;
          ackAll(b);
          log(`whatsapp: ${short(b)} — its agent was closed; the next message starts a new one`);
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          break;
      }
    });
    ws.on("close", () => {
      b.typing.stop();
      clearTimeout(b.preemptTimer);
      bridges.delete(b);
    });
    ws.on("error", () => {});
    return b;
  };

  // ── routing a message to its person ──────────────────────────────────────
  const identOf = (e: InboxEntry) => ({
    lid: e.sender.endsWith("@lid") ? e.sender : null,
    pn: e.sender.endsWith("@s.whatsapp.net") ? e.sender : e.phone ? `${e.phone}@s.whatsapp.net` : null,
  });

  const bridgeFor = (account: string, e: InboxEntry): Bridge => {
    const ident = identOf(e);
    const ch = findWaChannel(d.channels.load(), account, ident);
    if (ch) {
      let to = ch.whatsapp!.id;
      // Bound under the phone number before the LID was known: re-key the SAME
      // row to the LID — never a second one.
      if (ident.lid && to !== ident.lid) {
        const phone = ch.whatsapp!.phone ?? (to.endsWith("@s.whatsapp.net") ? digits(to) : undefined);
        d.channels.upsert({ sessionId: ch.sessionId, whatsapp: { account, id: ident.lid, ...(phone ? { phone } : {}) } });
        log(`whatsapp: ${ch.sessionId.slice(0, 8)} — re-keyed from a phone address to the person's LID`);
        to = ident.lid;
      }
      const live = [...bridges].find((b) => b.sessionId === ch.sessionId && alive(b));
      if (live) {
        live.to = to;
        return live;
      }
      return open({ key: to, to, account, resume: ch.sessionId, profile: ch.profile ?? null, ...(e.phone ? { phone: e.phone } : {}) });
    }
    // Not bound yet: a spawn may already be under way for this person.
    const pending = [...bridges].find(
      (b) => !b.sessionId && alive(b) && b.account === account && (b.key === e.sender || (!!e.phone && b.phone === e.phone)),
    );
    if (pending) return pending;
    log(`whatsapp: a new person wrote — starting their agent`);
    return open({ key: e.sender, to: e.sender, account, ...(e.name ? { name: e.name } : {}), ...(e.phone ? { phone: e.phone } : {}) });
  };

  /** Hand an inbox entry to its person's agent. */
  const deliver = (e: InboxEntry) => {
    const account = d.handle.account();
    if (!account) return; // nothing linked: kept for when something is
    // A door shut after the message was received: silence, and it is dropped
    // rather than held — the design's door is silent for everyone.
    if (!guestsOpen(d.setup())) {
      ack(e);
      return;
    }
    promptEntry(bridgeFor(account, e), e);
  };

  const onMessage = async (m: WaInbound) => {
    if (stopped) return;
    const v = inboundVerdict(m);
    if (v.kind === "ignore") return;
    if (v.kind !== "text") return; // media and the unreadable notice: task 3
    if (!guestsOpen(d.setup())) return; // the door shut: silence, nothing queued
    const account = d.handle.account();
    if (!account || d.inbox.seen(m.id)) return;
    let lid = v.lid;
    if (!lid && v.pn) lid = bareJid(await d.handle.resolveLid(v.pn).catch(() => null));
    const sender = senderKey({ lid, pn: v.pn });
    if (!sender) return;
    const e: InboxEntry = {
      id: m.id,
      sender,
      ...(v.pn ? { phone: digits(v.pn) } : {}),
      ...(cleanName(m.pushName) ? { name: cleanName(m.pushName) } : {}),
      text: v.text,
      at: m.at,
    };
    // In the inbox BEFORE anything else: from here a restart replays it.
    if (!d.inbox.add(e)) return;
    deliver(e);
  };

  // ── reattach and replay ──────────────────────────────────────────────────
  const reconcile = () => {
    if (stopped) return;
    const account = d.handle.account();
    if (!account) return;
    // A bridge of ANOTHER number (a different one was linked since) has no
    // business staying open: its sends would be refused anyway.
    for (const b of [...bridges]) if (b.account !== account && alive(b)) {
      b.closing = true;
      b.ws.close();
    }
    const hasBridge = (id: string) => [...bridges].some((b) => b.sessionId === id && alive(b));
    // A live bound agent with no bridge — a server restart, a respawn — gets
    // it back, so what it says unprompted (a schedule, the operator typing)
    // reaches the person. Probed only when there is no bridge (invariant 38),
    // and never for an idle agent: that would respawn every past guest.
    for (const c of waReattachList(d.channels.load(), account, hasBridge)) {
      if ((refusedUntil.get(c.sessionId) ?? 0) > Date.now()) continue;
      if (!d.sessionAlive(c.sessionId)) continue;
      log(`whatsapp: reattaching live agent ${c.sessionId.slice(0, 8)}`);
      open({ key: c.whatsapp!.id, to: c.whatsapp!.id, account, resume: c.sessionId, profile: c.profile ?? null });
    }
    // What the inbox still holds and no bridge is carrying: replay it. A
    // bridge that exists for that person already holds its entries.
    for (const e of d.inbox.pending()) {
      const carried = [...bridges].some(
        (b) => alive(b) && (b.awaiting.some((x) => x.id === e.id) || b.preempting?.id === e.id || b.held.some((x) => x.id === e.id)),
      );
      if (carried) continue;
      deliver(e);
    }
  };

  const offMsg = d.handle.onMessage((m) => void onMessage(m).catch((e) => log(`whatsapp: a message could not be handled: ${(e as Error)?.message ?? e}`)));
  // Every (re)connect replays what is still pending — a restart's backlog
  // arrives the moment the link is back.
  const offConn = d.handle.onConnected(() => reconcile());
  const timer = d.reattachMs === 0 ? null : setInterval(reconcile, d.reattachMs ?? 5000);
  timer?.unref?.();
  queueMicrotask(reconcile);

  return {
    reconcile,
    size: () => [...bridges].filter(alive).length,
    stop() {
      stopped = true;
      offMsg();
      offConn();
      if (timer) clearInterval(timer);
      for (const b of [...bridges]) {
        b.closing = true;
        b.typing.stop();
        try {
          b.ws.close();
        } catch {
          /* already closed */
        }
      }
      bridges.clear();
    },
  };
}
