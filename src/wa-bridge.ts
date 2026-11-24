import fs from "node:fs";
import path from "node:path";
import { type GuestNotice, type GuestSetup, guestNotice, guestsOpen } from "./tg-guests.js";
import { attachmentPrompt, makeSendQueue, makeTyping, promptEchoLabel, shouldPreempt, type PromptItem } from "./telegram.js";
import { bareJid, findWaChannel, inboundVerdict, replyAllowed, sendAllowed, senderKey, waReattachList, type WaBinding, type WaInbound } from "./wa-guests.js";
import { dialogMessage, mdToWhatsApp, neutralizeCommand, parseDialogReply, stripAttachmentMarkers, waChunks, waMediaFileName, type WaDialog } from "./wa-format.js";
import { transcribe as whisperTranscribe, heardNotice } from "./whisper.js";
import { lookAtVideo as realLookAtVideo, MAX_FRAMES, type VideoLook } from "./video.js";
import { contentTypeFor, telegramPhotoable } from "./download.js";
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
    "onMessage" | "onConnected" | "account" | "sendText" | "setTyping" | "resolveLid" | "whenConnected" | "downloadMedia" | "sendFile"
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
  // ── step 3: media ──
  /** Where a received medium waits for its agent (beside the inbox, 0700). */
  stagingDir: string;
  /** The agent's GROUP media directory (the server's `mediaDirForSession`,
   *  invariant 60). Throws while the agent is not known yet. */
  mediaDirFor: (sessionId: string | null) => string;
  /** Read a file the AGENT hands over, with the agent's rights (the server's
   *  `readSessionFile`) — the path comes from the agent. */
  readAgentFile: (sessionId: string | null, p: string) => Promise<Uint8Array>;
  /** Group-readable media in multi-tenant (the agent runs as the group user). */
  multiTenant?: boolean;
  /** Telegram's own pipelines, injectable for the tests. */
  transcribe?: typeof whisperTranscribe;
  lookAtVideo?: (p: string, o: { maxFrames?: number; notify?: (l: string) => void }) => Promise<VideoLook>;
  /** Inbound ceiling, bytes. */
  mediaLimit?: number;
}

/** What a person may send in one file: checked on the declared size before
 *  downloading, and on the bytes after. Stated in `guestNotice("too-large")`. */
export const WA_MEDIA_LIMIT = 50 * 1024 * 1024;
/** One unreadable-message notice per person per this long: it can never loop. */
const UNREADABLE_NOTICE_EVERY_MS = 10 * 60_000;

/** In-memory companion of an inbox entry: the exact prompt sent for it. */
type Entry = InboxEntry & { sent?: string; spoken?: boolean };

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
  awaiting: Entry[];
  /** Every entry handed to this bridge and not yet acknowledged — what the
   *  replay must not send a second time. */
  inflight: Set<string>;
  /** Entries go in strictly in arrival order, a medium's download/transcription
   *  included: a text sent after a voice note must not overtake it. */
  intake: ReturnType<typeof makeSendQueue>;
  /** Work waiting for `ready` (a medium needs the agent's media directory). */
  afterReady: (() => void)[];
  /** The entry held back while a running turn is interrupted. */
  preempting?: Entry;
  /** Messages that arrived while a preempt was already under way: they wait
   *  their turn, in order, rather than interrupt again (a burst of short texts
   *  is ordinary WhatsApp use). */
  held: Entry[];
  /** Opened to RESUME an existing binding (as opposed to a fresh spawn). */
  isResume: boolean;
  preemptTimer?: NodeJS.Timeout;
  lastRetried?: string;
  /** The question on screen, as last broadcast (with its checkboxes): the
   *  person's next message answers it (`parseDialogReply`). */
  dialog?: WaDialog;
  lastDialog?: string;
  /** An own-answer option was picked by number: the next message is its text. */
  awaitingFreetext?: number;
  /** Resolved by the next re-broadcast of the question (a toggle landed). */
  dialogWaiter?: () => void;
  /** Toggles are being sent: the question's re-broadcasts are repaints of an
   *  answer in progress, never a question to arm again. */
  answering?: boolean;
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
  /** Who wrote, when — fed ONLY by inbound messages (`replyAllowed`). */
  const recentWriters = new Map<string, number>();
  const unreadableNoticed = new Map<string, number>();
  const transcribe = d.transcribe ?? whisperTranscribe;
  const lookAtVideo = d.lookAtVideo ?? realLookAtVideo;
  const mediaLimit = d.mediaLimit ?? WA_MEDIA_LIMIT;

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

  /**
   * A notice to someone who may have NO binding yet — their first message was
   * unreadable, or their first file could not be received. Allowed only for a
   * binding or for someone who wrote minutes ago (`replyAllowed`): still never
   * writing first, and only ever the bridge's own fixed words.
   */
  const noticeTo = (to: string, kind: GuestNotice) => {
    const line = guestNotice(kind);
    const account = d.handle.account();
    if (!line || !account) return;
    if (!sendAllowed(d.channels.load(), account, to) && !replyAllowed(recentWriters, to, Date.now())) {
      log("whatsapp: a notice was NOT sent — that address has not written recently");
      return;
    }
    void d.handle.sendText(to, line).catch(() => log(`whatsapp: a notice could not be sent (${kind})`));
  };

  /** A file the AGENT hands over, read with the agent's rights, sent as a
   *  picture WhatsApp previews or as a document — to the binding only. */
  const sendFileTo = (b: Bridge, f: { path?: unknown; name?: unknown }) =>
    b.send(async () => {
      const p = typeof f.path === "string" ? f.path : "";
      const name = typeof f.name === "string" && f.name ? f.name : path.basename(p);
      if (!p) return;
      if (!sendAllowed(d.channels.load(), b.account, b.to) || d.handle.account() !== b.account) {
        log(`whatsapp: ${short(b)} — file not sent: the recipient is not a binding of the linked number`);
        return;
      }
      let data: Uint8Array;
      try {
        data = await d.readAgentFile(b.sessionId, p);
      } catch (e) {
        // `upload-failed` says nothing to a guest: a file they never asked for
        // is the operator's business (the log).
        log(`whatsapp: ${short(b)} — file ${name} not sent: ${(e as Error)?.message ?? e}`);
        notice(b, "upload-failed");
        return;
      }
      const out = { data, name, mime: contentTypeFor(name), image: telegramPhotoable(name) };
      try {
        await d.handle.sendFile(b.to, out);
      } catch {
        if (!(await d.handle.whenConnected(sendWait))) {
          log(`whatsapp: ${short(b)} — file ${name} NOT delivered: the link did not come back in time`);
          return;
        }
        await d.handle.sendFile(b.to, out).catch((e) => log(`whatsapp: ${short(b)} — file ${name} NOT delivered: ${(e as Error)?.message ?? e}`));
      }
      if (spacing) await new Promise((r) => setTimeout(r, spacing));
    });

  // ── prompts and acknowledgement ──────────────────────────────────────────
  const frame = (b: Bridge, f: object) => {
    if (b.ready && b.ws.readyState === 1) b.ws.send(JSON.stringify(f));
    else b.pending.push(f);
  };
  const submit = (b: Bridge, e: Entry) => {
    e.sent ??= neutralizeCommand(e.text);
    b.awaiting.push(e);
    frame(b, { type: "prompt", text: e.sent, ...(e.name ? { from: e.name } : {}), ...(e.spoken ? { voice: true } : {}) });
  };
  const ack = (e: Entry) => {
    d.inbox.ack(e.id);
    for (const b of bridges) b.inflight.delete(e.id);
    // The staging copy goes with its entry: delivered or refused, it is done.
    if (e.media?.path)
      try {
        fs.rmSync(e.media.path, { force: true });
      } catch {
        /* a leftover is harmless: the next ack or purge removes it */
      }
  };
  const ackAll = (b: Bridge) => {
    for (const e of b.awaiting.splice(0)) ack(e);
    for (const e of b.held.splice(0)) ack(e);
    // …and whatever is still on its way in — a medium waiting for the agent's
    // media directory sits in neither list. Left pending, the replay loop would
    // hand it to a new bridge every few seconds: one refused spawn each time.
    const pending = d.inbox.pending();
    for (const id of [...b.inflight]) {
      const e = pending.find((x) => x.id === id);
      if (e) ack(e);
    }
    b.closing = true;
    for (const go of b.afterReady.splice(0)) go();
    if (b.preempting) {
      ack(b.preempting);
      b.preempting = undefined;
      clearTimeout(b.preemptTimer);
    }
  };
  /** Take the hand back (a running turn, or a question on screen), then send
   *  `e` once the turn has settled — Telegram's preempt, same bound. */
  const preempt = (b: Bridge, e: Entry) => {
    // One interruption at a time: a message arriving while one is under way
    // queues behind it — overwriting it would orphan the first and replay it
    // later, out of order, interrupting again.
    if (b.preempting) {
      b.held.push(e);
      return;
    }
    b.preempting = e;
    b.lastRetried = e.sent ?? e.text;
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
  /** Toggle each number, one at a time — each waits for the server's
   *  re-broadcast of the question, so a toggle never races the previous one —
   *  then submit the form. */
  const runToggles = async (b: Bridge, toggles: number[]) => {
    b.answering = true;
    for (const n of toggles) {
      const landed = new Promise<void>((r) => {
        const t = setTimeout(r, 3000);
        b.dialogWaiter = () => (clearTimeout(t), r());
      });
      frame(b, { type: "toggle", n });
      await landed;
      b.dialogWaiter = undefined;
    }
    frame(b, { type: "confirm" });
    b.answering = false;
    resolved(b);
  };

  /** The question is answered: nothing of it may consume a later message, and
   *  the SAME question asked again (invariant 21's fresh ask) is a new one. */
  const resolved = (b: Bridge) => {
    b.dialog = undefined;
    b.lastDialog = undefined;
    b.awaitingFreetext = undefined;
  };

  /** The person's message while a question is on screen: an ANSWER, never a prompt. */
  const answer = async (b: Bridge, e: Entry) => {
    const dlg = b.dialog!;
    ack(e); // consumed as an answer, whatever it says
    const r = e.media ? ({ kind: "invalid" } as const) : parseDialogReply(dlg, e.text);
    switch (r.kind) {
      case "choose":
        resolved(b);
        frame(b, { type: "choose", n: r.n });
        return;
      case "toggles":
        b.dialog = undefined;
        await runToggles(b, r.toggles);
        return;
      case "freetext":
        resolved(b);
        frame(b, { type: "freetext", n: r.n, text: r.text });
        return;
      case "need-text":
        b.awaitingFreetext = r.n;
        notice(b, "need-text");
        return;
      case "invalid":
        notice(b, "dialog-again");
        return;
    }
  };

  /** A medium, once its agent exists: into the agent's group media directory,
   *  then Telegram's own pipeline for its kind. */
  const sendMedia = async (b: Bridge, e: Entry) => {
    const m = e.media!;
    let dest: string;
    try {
      const dir = d.mediaDirFor(b.sessionId);
      dest = path.join(dir, path.basename(m.path));
      try {
        fs.copyFileSync(m.path, dest, fs.constants.COPYFILE_EXCL);
      } catch (err) {
        // The same message again (a replay after a restart): reuse it, but only
        // a plain file — never something planted under that name.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const st = fs.lstatSync(dest);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("an unexpected entry sits where the attachment goes");
      }
      // The GROUP must be the directory's: `copyFileSync` (libuv) gives the copy
      // the SOURCE's group — root's, from the 0700 staging dir — instead of
      // inheriting the setgid directory's, as a plain write does. 0640 root:root
      // left the agent, which runs as the group's user, unable to read the very
      // file it was told about. Set explicitly, so a copy left behind by an
      // earlier run (the EEXIST reuse above) is repaired too.
      if (d.multiTenant) fs.lchownSync(dest, fs.lstatSync(dest).uid, fs.statSync(dir).gid);
      fs.chmodSync(dest, d.multiTenant ? 0o640 : 0o600);
    } catch (err) {
      log(`whatsapp: ${short(b)} — a received file could not be handed to its agent: ${(err as Error)?.message ?? err}`);
      ack(e);
      notice(b, "media-failed");
      return;
    }
    const caption = e.text.trim() ? e.text : undefined;
    if (m.kind === "audio" && m.voice) {
      // Telegram's voice path: transcribe, ECHO what was understood (a
      // misheard instruction acted on in silence is the failure this guards
      // against), then send it marked as spoken. Its install/progress lines are
      // the operator's business: logged, never said to a guest.
      b.typing.start();
      const out = await transcribe(dest, (line) => log(`whatsapp: ${short(b)} — ${line}`));
      if (!out.ok) {
        log(`whatsapp: ${short(b)} — a voice note could not be transcribed (${out.kind})`);
        b.typing.stop();
        ack(e);
        notice(b, "voice-failed");
        return;
      }
      void sendTo(b, heardNotice(out.text));
      e.sent = caption ? `${out.text}\n\n${caption}` : out.text;
      e.spoken = true;
      submit(b, e);
      return;
    }
    const item: PromptItem = { path: dest, kind: m.kind === "image" ? "image" : m.kind === "video" ? "video" : "file" };
    if (m.kind === "video") {
      // Looked AT (stills) and listened to (its audio), as on Telegram.
      const look = await lookAtVideo(dest, { maxFrames: MAX_FRAMES, notify: (line) => log(`whatsapp: ${short(b)} — ${line}`) });
      if (look.trouble) log(`whatsapp: ${short(b)} — ${look.trouble}`);
      Object.assign(item, {
        ...(look.durationSec ? { durationSec: look.durationSec } : {}),
        ...(look.frames ? { frames: look.frames } : {}),
        ...(look.transcript ? { transcript: look.transcript } : {}),
        ...(look.audioNote ? { audioNote: look.audioNote } : {}),
      });
    }
    e.sent = attachmentPrompt([item], caption);
    submit(b, e);
  };

  /** Hand one entry to the agent: as an answer, a medium or a text. */
  const sendEntry = (b: Bridge, e: Entry) =>
    b.intake(async () => {
      if (b.awaitingFreetext !== undefined && !e.media) {
        const n = b.awaitingFreetext;
        resolved(b);
        ack(e);
        frame(b, { type: "freetext", n, text: e.text });
        return;
      }
      if (b.dialog && b.ready) return answer(b, e);
      if (e.media && !e.sent) {
        if (!b.ready || !b.sessionId) {
          // The agent's media directory needs the agent: wait for `ready`.
          await new Promise<void>((r) => b.afterReady.push(r));
          if (b.closing) return;
        }
        return sendMedia(b, e);
      }
      submit(b, e);
    }).catch((err) => log(`whatsapp: ${short(b)} — a message could not be handed over: ${(err as Error)?.message ?? err}`));

  const promptEntry = (b: Bridge, e: Entry) => {
    b.inflight.add(e.id);
    // A NEW message reopens the right to interrupt (Telegram clears it the
    // same way): kept from an earlier preempt, the same short text sent again
    // later would meet `busy`, fail `shouldPreempt`, and be lost.
    b.lastRetried = undefined;
    if (b.preempting) {
      b.held.push(e);
      return;
    }
    void sendEntry(b, e);
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
      inflight: new Set(),
      intake: makeSendQueue(),
      afterReady: [],
      held: [],
      isResume: !!o.resume,
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
          for (const go of b.afterReady.splice(0)) go();
          break;
        }
        case "working":
          b.typing.start();
          // The turn runs again: any question was answered (here, or by the
          // operator from the cockpit) and must not consume the next message.
          if (!b.answering) resolved(b);
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
            const t = (e.sent ?? neutralizeCommand(e.text)).trim();
            return !!t && (said === t || (t.length >= 16 && said.includes(t)));
          });
          if (i >= 0) ack(b.awaiting.splice(i, 1)[0]);
          break;
        }
        case "dialog": {
          b.typing.stop();
          const opts = (Array.isArray(m.options) ? m.options : [])
            .filter((x: { n?: unknown; label?: unknown }) => typeof x?.n === "number" && typeof x?.label === "string")
            .map((x: { n: number; label: string; checked?: boolean }) => ({ n: x.n, label: x.label, ...(x.checked ? { checked: true } : {}) }));
          const dlg: WaDialog = {
            question: typeof m.question === "string" ? m.question : "",
            ...(typeof m.body === "string" && m.body.trim() ? { body: m.body } : {}),
            multi: m.multi === true,
            options: opts,
          };
          // A multi-select re-sends its question on every toggle (new
          // checkboxes): while an answer is being toggled in, that is a repaint
          // — it releases the next toggle and arms nothing.
          const key = `${dlg.question}\u0000${opts.map((x: { label: string }) => x.label).join("\u0000")}`;
          if (b.answering) {
            b.dialogWaiter?.();
            break;
          }
          b.dialog = dlg;
          if (key === b.lastDialog) break;
          b.lastDialog = key;
          b.awaitingFreetext = undefined;
          if (opts.length) void sendTo(b, dialogMessage(dlg));
          break;
        }
        case "turn-done": {
          b.dialog = undefined;
          b.lastDialog = undefined;
          b.awaitingFreetext = undefined;
          // Whatever was submitted before this turn ended has been taken in.
          for (const e of b.awaiting.splice(0)) ack(e);
          if (b.preempting) {
            const e = b.preempting;
            b.preempting = undefined;
            clearTimeout(b.preemptTimer);
            void sendEntry(b, e);
            break;
          }
          // What queued behind an interruption goes next, one turn each.
          const next = b.held.shift();
          if (next) {
            void sendEntry(b, next);
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
          if (last && shouldPreempt({ code: m.code, text: last.sent ?? last.text, lastRetried: b.lastRetried })) {
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
        case "stream-tool":
          // A file the agent hands over (the harness's SendUserFile, or
          // shadok's own ShadokFile) is a delivery, not tool noise. Every other
          // tool call is the operator's business and never reaches a guest.
          if ((m.name === "SendUserFile" || m.name === "ShadokFile") && Array.isArray(m.files))
            for (const f of m.files) void sendFileTo(b, f);
          break;
        case "exited":
          b.typing.stop();
          b.dialog = undefined;
          break;
        case "stopped": {
          // The agent was CLOSED in the cockpit: its row is gone, so this
          // bridge points at nothing. Closing it means the person's next
          // message finds no binding and starts a NEW agent — an explicit
          // ending, never an inferred one (a dropped link ends nothing).
          b.typing.stop();
          b.closing = true;
          ackAll(b);
          // Said ONCE, honestly: their next message starts afresh. The row is
          // already gone, so `sendAllowed` cannot vouch for this address any
          // more — it was this bridge's binding until a moment ago (ready),
          // on this linked number, and this is the only line that may follow.
          const ended = guestNotice("ended");
          if (ended && b.ready && d.handle.account() === b.account) void d.handle.sendText(b.to, ended).catch(() => {});
          log(`whatsapp: ${short(b)} — its agent was closed; the next message starts a new one`);
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          break;
        }
      }
    });
    ws.on("close", () => {
      b.typing.stop();
      clearTimeout(b.preemptTimer);
      // A medium waiting for `ready` on a socket that died is released (it
      // stays pending in the inbox and the replay hands it to a fresh bridge).
      b.closing = true;
      for (const go of b.afterReady.splice(0)) go();
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
    if (!guestsOpen(d.setup())) return; // the door shut: silence, nothing queued, no notice
    const account = d.handle.account();
    if (!account) return;
    // Someone wrote: for a few minutes the bridge may answer them with its own
    // notices, even with no binding yet (`replyAllowed`).
    const now = Date.now();
    for (const j of [bareJid(m.chat), bareJid(m.chatAlt)]) if (j) recentWriters.set(j, now);
    for (const [j, at] of recentWriters) if (now - at > 60 * 60_000) recentWriters.delete(j);
    // A stub copy of a message already received says nothing: the person was
    // heard, and asking for a resend would only send it twice.
    if (v.kind === "unreadable" && d.inbox.seen(m.id)) return;
    if (v.kind === "unreadable") {
      // The spike's finding 3: no content for this linked device yet. Nothing
      // is stored and the id is NOT marked seen, so if the library's own
      // resend brings the content later, it is processed normally. ONE line
      // asks for a resend — writing to them is also what makes their next
      // message readable — at most once per person per few minutes.
      log("whatsapp: a message arrived unreadable (not yet encrypted for this device)");
      const last = unreadableNoticed.get(v.replyTo) ?? 0;
      if (now - last < UNREADABLE_NOTICE_EVERY_MS) return;
      unreadableNoticed.set(v.replyTo, now);
      noticeTo(v.replyTo, "unreadable");
      return;
    }
    if (d.inbox.seen(m.id)) return;
    let lid = v.lid;
    if (!lid && v.pn) lid = bareJid(await d.handle.resolveLid(v.pn).catch(() => null));
    const sender = senderKey({ lid, pn: v.pn });
    if (!sender) return;
    const e: InboxEntry = {
      id: m.id,
      sender,
      ...(v.pn ? { phone: digits(v.pn) } : {}),
      ...(cleanName(m.pushName) ? { name: cleanName(m.pushName) } : {}),
      text: v.kind === "text" ? v.text : v.caption ?? "",
      at: m.at,
    };
    if (v.kind === "media") {
      // Downloaded NOW: the library's message lives in this process only, so
      // a medium that waited for its agent across a restart would be gone. It
      // waits as a file in the staging directory instead, recorded in the inbox.
      const replyTo = bareJid(m.chat)!;
      if ((v.media.size ?? 0) > mediaLimit) {
        log("whatsapp: a received file is over the size limit — refused");
        noticeTo(replyTo, "too-large");
        return;
      }
      try {
        const bytes = await d.handle.downloadMedia(m.id);
        if (bytes.length > mediaLimit) {
          noticeTo(replyTo, "too-large");
          return;
        }
        fs.mkdirSync(d.stagingDir, { recursive: true, mode: 0o700 });
        fs.chmodSync(d.stagingDir, 0o700);
        const staged = path.join(d.stagingDir, waMediaFileName(m.id, v.media));
        // `wx`: never through an existing name or a symlink; never readable by others.
        fs.writeFileSync(staged, bytes, { flag: "wx", mode: 0o600 });
        e.media = { path: staged, kind: v.media.kind, ...(v.media.mime ? { mime: v.media.mime } : {}), ...(v.media.voice ? { voice: true } : {}) };
      } catch (err) {
        if (d.inbox.seen(m.id)) return; // a concurrent copy of the same message won
        log(`whatsapp: a received file could not be downloaded: ${(err as Error)?.message ?? err}`);
        noticeTo(replyTo, "media-failed");
        return;
      }
    }
    // In the inbox BEFORE anything else: from here a restart replays it.
    if (!d.inbox.add(e)) {
      // A late duplicate of an id already taken: its staging copy is nobody's.
      if (e.media?.path) fs.rmSync(e.media.path, { force: true });
      return;
    }
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
      const carried = [...bridges].some((b) => alive(b) && b.inflight.has(e.id));
      if (carried) continue;
      deliver(e);
    }
  };

  // Staging files no pending entry claims (an unreadable inbox at boot, a crash
  // between download and record) are purged at start: they are strangers' files.
  try {
    const claimed = new Set(d.inbox.pending().map((e) => e.media?.path).filter(Boolean));
    for (const f of fs.readdirSync(d.stagingDir)) {
      const full = path.join(d.stagingDir, f);
      if (!claimed.has(full)) fs.rmSync(full, { force: true });
    }
  } catch {
    /* no staging directory yet */
  }

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
