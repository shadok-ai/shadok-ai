import type { WaAccount } from "./wa-link.js";
import type { WaInbound, WaMedia } from "./wa-guests.js";
import type { WaTransport, WaTransportEvent, WaTransportFactory } from "./wa-transport.js";
import { probeInWorker, workerTransportFactory } from "./wa-worker-host.js";

/**
 * The WhatsApp library adapter — the ONLY file that names the library.
 *
 * The library is NOT a dependency of the app: it is installed on demand into
 * the data directory (`wa-library.ts`), and loaded through the loader shipped
 * there (`context/whatsapp-lib/load.mjs`), whose own `import()` resolves from
 * that directory's node_modules. Never a bare `import("baileys")` here — that
 * would resolve from the app's node_modules, and silently use any stray copy.
 * The app must build and boot without the library, so the few library types
 * used here are declared locally instead of imported.
 *
 * The options come from a throwaway spike that linked a test number by QR:
 * full history sync off, presence off (so the phone keeps its notifications),
 * a silent logger (the library's own logs carry numbers and payloads), and
 * QR pairing only — pairing by code is broken upstream.
 */

const LIB = "baileys";
const QR_LIB = "qrcode";

/**
 * The library's `DisconnectReason`, all of it: 515 → restart, 401 → logged-out,
 * 408/428/503 → lost (retried with backoff), 403/440/411/500 → fatal (stopped
 * and said), anything else → error (retried).
 *
 * Fatal because retrying them every minute changes nothing or makes it worse:
 * 403 is WhatsApp refusing the account, 440 means the same number connected
 * elsewhere — two instances on one number would evict each other for ever —
 * and 411/500 are a session that must be linked again. One caveat, read from
 * the library: an unrecognised stream error is ALSO reported as 500, so a 500
 * is not always a damaged session — which is why the halted state offers
 * Retry, not only Link again.
 */
export function closeReasonOf(statusCode: number | undefined): "restart" | "lost" | "logged-out" | "error" | "fatal" {
  switch (statusCode) {
    case 515:
      return "restart";
    case 401:
      return "logged-out";
    case 408:
    case 428:
    case 503:
      return "lost";
    case 403:
    case 440:
    case 411:
    case 500:
      return "fatal";
    default:
      return "error";
  }
}

/** What the panel says for a close it shows. */
export function closeDetailOf(statusCode: number | undefined): string | undefined {
  switch (statusCode) {
    case 401:
      return "the device was removed from the phone, or WhatsApp closed the session";
    case 403:
      return "WhatsApp refused this account (403) — the number may be restricted or banned";
    case 440:
      return "connection replaced (440): this number was connected again elsewhere — another instance or another linked device; two instances on one number evict each other";
    case 411:
      return "WhatsApp reports a multi-device mismatch (411) — link the number again";
    case 500:
      return "WhatsApp reported a bad session or a stream error (500) — retry once, and link the number again if it comes back";
    default:
      return statusCode ? `status ${statusCode}` : undefined;
  }
}

/** The linked account, from the library's `user`. The digits before `:` (the
 *  device suffix) or `@` are the number; a LID-only id carries no number. */
export function accountOf(me: { id?: string; name?: string } | undefined): WaAccount | null {
  if (!me || typeof me.id !== "string" || !me.id) return null;
  const a: WaAccount = { id: me.id };
  if (typeof me.name === "string" && me.name) a.name = me.name;
  const m = /^(\d+)[:@]/.exec(me.id);
  if (m && me.id.endsWith("@s.whatsapp.net")) a.phone = m[1];
  return a;
}

/** The library's stub type for a message whose ciphertext never came for this
 *  device (`WAMessageStubType.CIPHERTEXT`): the spike's finding 3. */
const STUB_CIPHERTEXT = 2;

/**
 * One library message (`messages.upsert`) as the neutral `WaInbound`, or null
 * when it carries no usable key. Pure, tested on library-shaped objects.
 *
 * Read from the library's own decoder: a DM's `remoteJid` is the person's
 * primary address and `remoteJidAlt` their other one (a LID chat carries the
 * phone number, and the reverse). `type: "notify"` is a message delivered now;
 * `append` is a history sync replaying old ones. A disappearing message wraps
 * its content one level down (`ephemeralMessage.message`).
 */
export function inboundOf(m: any, type: string): WaInbound | null {
  const k = m?.key;
  if (!k || typeof k.remoteJid !== "string" || typeof k.id !== "string") return null;
  let content = m.message ?? null;
  // Wrappers the library leaves in place: disappearing, view-once, a document
  // sent with a caption.
  for (const w of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage"])
    if (content?.[w]?.message) content = content[w].message;
  const media = mediaOf(content);
  const caption = media ? content?.[`${media.kind}Message`]?.caption : undefined;
  const text =
    typeof content?.conversation === "string"
      ? content.conversation
      : typeof content?.extendedTextMessage?.text === "string"
        ? content.extendedTextMessage.text
        : typeof caption === "string" && caption
          ? caption
          : undefined;
  const ts = Number(m.messageTimestamp);
  return {
    id: k.id,
    chat: k.remoteJid,
    ...(typeof k.remoteJidAlt === "string" && k.remoteJidAlt ? { chatAlt: k.remoteJidAlt } : {}),
    fromMe: k.fromMe === true,
    live: type === "notify",
    unreadable: m.messageStubType === STUB_CIPHERTEXT,
    ...(text !== undefined ? { text } : {}),
    ...(media ? { media } : {}),
    ...(typeof m.pushName === "string" && m.pushName ? { pushName: m.pushName } : {}),
    at: Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now(),
  };
}

/** The medium a library message carries, described (the bytes come later). */
function mediaOf(content: any): WaMedia | undefined {
  for (const kind of ["image", "document", "audio", "video"] as const) {
    const x = content?.[`${kind}Message`];
    if (!x || typeof x !== "object") continue;
    const size = Number(x.fileLength);
    return {
      kind,
      ...(typeof x.mimetype === "string" && x.mimetype ? { mime: x.mimetype } : {}),
      ...(kind === "document" && typeof x.fileName === "string" && x.fileName ? { fileName: x.fileName } : {}),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      ...(kind === "audio" && x.ptt === true ? { voice: true } : {}),
    };
  }
  return undefined;
}

/** Recent media messages kept for their download: a burst of photos, not a history. */
const RAW_KEEP = 100;

const SILENT_LOGGER: Record<string, unknown> = {
  level: "silent",
  child: () => SILENT_LOGGER,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

// The slice of the library's surface this adapter touches.
interface LibSocket {
  ev: { on(ev: string, fn: (arg: any) => void): void; removeAllListeners?(ev: string): void };
  ws: { on(ev: string, fn: (arg: any) => void): void };
  user?: { id?: string; name?: string };
  logout(msg?: string): Promise<void>;
  sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
  sendPresenceUpdate(type: string, jid?: string): Promise<void>;
  signalRepository?: { lidMapping?: { getLIDForPN(pn: string): Promise<string | null> } };
  updateMediaMessage?: (m: unknown) => Promise<unknown>;
  end(err: Error | undefined): void;
}
interface LibAuthState {
  creds: unknown;
  keys: { get(type: string, ids: string[]): Promise<unknown>; set(data: unknown): Promise<void> };
}
interface Lib {
  default: (cfg: Record<string, unknown>) => LibSocket;
  useMultiFileAuthState(dir: string): Promise<{ state: LibAuthState; saveCreds: () => Promise<void> }>;
  Browsers: { ubuntu(b: string): unknown };
  downloadMediaMessage?: (m: unknown, type: "buffer", opts: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Uint8Array>;
}

/** How long `stop()` waits for credential writes already under way. */
const DRAIN_MS = 5_000;

/**
 * The transport over the library. Exported for its tests only.
 *
 * Two flags, on purpose: `live` gates EVENTS (a closed socket must not move
 * the state), `writable` gates the session DIRECTORY and only `stop()` clears
 * it — a pairing's final credentials are saved around the restart-required
 * close, and must not be dropped by it. Both of the library's write paths go
 * through the gate (`saveCreds` on creds.update, and `keys.set`, which the
 * library calls by itself for signal keys), every write is tracked, and
 * `stop()` resolves only once those under way have landed. That is the
 * contract an unlink relies on: after `stop()` + wipe the directory is empty
 * and STAYS empty, however long the library keeps a reference.
 */
export function makeBaileysTransport(lib: Lib, sessionDir: string): WaTransport {
  let sock: LibSocket | null = null;
  let live = false;
  let writable = true;
  const pending = new Set<Promise<unknown>>();
  /** The library message of each recent medium, for `downloadMedia`. */
  const raw = new Map<string, unknown>();
  const track = (p: Promise<unknown>): Promise<void> => {
    const q = p.then(
      () => undefined,
      () => undefined,
    );
    pending.add(q);
    void q.finally(() => pending.delete(q));
    return q;
  };
  return {
    async start(on) {
      live = true;
      const emit = (e: WaTransportEvent) => {
        if (live) on(e);
      };
      const { state, saveCreds } = await lib.useMultiFileAuthState(sessionDir);
      const auth: LibAuthState = {
        creds: state.creds,
        keys: {
          get: (type, ids) => state.keys.get(type, ids),
          set: (data) => (writable ? track(state.keys.set(data)) : Promise.resolve()),
        },
      };
      const s = lib.default({
        auth,
        logger: SILENT_LOGGER,
        browser: lib.Browsers.ubuntu("Chrome"),
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });
      sock = s;
      s.ev.on("creds.update", () => {
        if (writable) void track(saveCreds());
      });
      // Every decoded frame is a sign of life, and the library pings every
      // ~30 s, so a healthy socket always has some. This is what feeds the
      // liveness watchdog that catches a socket that dies without a close.
      s.ws.on("frame", () => emit({ type: "alive" }));
      // Inbound messages. The library has ALREADY acknowledged each one when
      // this fires; the bridge's persisted inbox is what keeps it from there.
      s.ev.on("messages.upsert", (u: { messages?: unknown[]; type?: string }) => {
        for (const rawMsg of Array.isArray(u?.messages) ? u.messages : []) {
          const msg = inboundOf(rawMsg, String(u?.type ?? ""));
          if (!msg) continue;
          if (msg.media) {
            raw.set(msg.id, rawMsg);
            while (raw.size > RAW_KEEP) raw.delete(raw.keys().next().value as string);
          }
          emit({ type: "message", msg });
        }
      });
      let qrs = 0;
      s.ev.on("connection.update", (u: { qr?: string; connection?: string; lastDisconnect?: { error?: any } }) => {
        emit({ type: "alive" });
        if (u.qr) {
          // The library lets the first QR live 60 s and the next ones 20 s.
          emit({ type: "qr", payload: u.qr, ttlMs: qrs++ === 0 ? 60_000 : 20_000 });
        }
        if (u.connection === "open") {
          const acct = accountOf(s.user);
          if (acct) emit({ type: "open", account: acct });
          else emit({ type: "close", reason: "error", detail: "connected without an account id" });
        }
        if (u.connection === "close") {
          const err = u.lastDisconnect?.error;
          const code: number | undefined = err?.output?.statusCode;
          const reason = closeReasonOf(code);
          const detail = closeDetailOf(code);
          emit({ type: "close", reason, ...(detail ? { detail } : {}) });
          live = false;
        }
      });
    },
    async logout() {
      if (!sock) throw new Error("not connected");
      await sock.logout();
    },
    async sendText(to, text) {
      if (!sock || !live) throw new Error("not connected");
      await sock.sendMessage(to, { text });
    },
    async setTyping(to, on) {
      if (!sock || !live) throw new Error("not connected");
      await sock.sendPresenceUpdate(on ? "composing" : "paused", to);
    },
    async downloadMedia(id) {
      const m = raw.get(id);
      if (!m) throw new Error("this file is no longer available to download");
      if (typeof lib.downloadMediaMessage !== "function") throw new Error("the WhatsApp library cannot download media");
      // The reupload hook asks the sender's phone for a fresh copy when the
      // server's has expired — what made the spike's downloads succeed.
      const buf = await lib.downloadMediaMessage(m, "buffer", {}, {
        logger: SILENT_LOGGER,
        ...(sock?.updateMediaMessage ? { reuploadRequest: sock.updateMediaMessage } : {}),
      });
      raw.delete(id);
      return buf;
    },
    async sendFile(to, f) {
      if (!sock || !live) throw new Error("not connected");
      const data = Buffer.from(f.data);
      // No image library is installed with the library (sharp/jimp are left
      // out): the library's thumbnail step fails inside its own try and the
      // picture goes out without a preview — degraded, never failed.
      await sock.sendMessage(
        to,
        (f.image
          ? { image: data, mimetype: f.mime, ...(f.caption ? { caption: f.caption } : {}) }
          : { document: data, mimetype: f.mime, fileName: f.name, ...(f.caption ? { caption: f.caption } : {}) }),
      );
    },
    async resolveLid(pn) {
      const lid = await sock?.signalRepository?.lidMapping?.getLIDForPN(pn).catch(() => null);
      return typeof lid === "string" && lid ? lid : null;
    },
    async stop() {
      live = false;
      writable = false;
      const s = sock;
      sock = null;
      try {
        s?.end(undefined);
      } catch {
        /* already closed */
      }
      // Let the writes already under way land BEFORE the caller wipes; a write
      // that never settles is not allowed to hold an unlink for ever.
      if (pending.size) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((r) => {
            timer = setTimeout(r, DRAIN_MS);
          }),
        ]);
        clearTimeout(timer);
      }
    },
  };
}

type LibLoader = { load(name: string): Promise<unknown> };

/** The packages, through the loader of the installed copy. */
async function fromDataDir(entryUrl: string, name: string): Promise<unknown> {
  const loader = (await import(entryUrl)) as LibLoader;
  return loader.load(name);
}

/** The in-process loader. Runs INSIDE the worker (`wa-worker.ts`), never in
 *  the server's thread: see `loadBaileysFactory`. */
export const loadBaileysInProcess = async (entryUrl: string): Promise<WaTransportFactory> => {
  let lib: Lib;
  try {
    lib = (await fromDataDir(entryUrl, LIB)) as Lib;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The resolver's message names the server's own paths: not the panel's
    // business, so it stops at the package name.
    const first = msg.split("\n")[0].replace(/ imported from .*$/, "").replace(/ from \S+$/, "");
    throw new Error(`the WhatsApp library is not installed or failed to load: ${first}`);
  }
  if (typeof lib.default !== "function" || typeof lib.useMultiFileAuthState !== "function")
    throw new Error("the WhatsApp library loaded, but not in the expected shape");
  return async ({ sessionDir }) => makeBaileysTransport(lib, sessionDir);
};

/**
 * What the server uses. Rejects (with the library's own message) when the
 * library is absent or fails to load — checked in a throwaway worker, so even
 * loading it never happens in the server's thread — and the handle turns that
 * into the `unavailable` state. Otherwise every transport runs in a worker of
 * its own (`wa-worker-host.ts`): an error raised inside the library's code
 * ends that worker and becomes a `close{error}`, never a process exit.
 */
export const loadBaileysFactory = async (entryUrl: string): Promise<WaTransportFactory> => {
  const spec = { modulePath: import.meta.url, exportName: "loadBaileysInProcess", arg: entryUrl };
  await probeInWorker(spec);
  return workerTransportFactory(spec);
};

/** The QR encoder, from the installed copy. Plain JS, so it is loaded in the
 *  server's thread (drawing a code is not the library's socket code). */
export function qrLoaderFrom(entryUrl: () => string): () => Promise<unknown> {
  return async () => fromDataDir(entryUrl(), QR_LIB);
}

/** The QR code as an SVG string, drawn server-side: the page's CSP allows no
 *  external image and no inline script, and the payload never needs to reach
 *  a third party. When the encoder is absent, the REASON — otherwise the panel
 *  would sit on "waiting for a code" until linking expired. */
export async function qrSvg(payload: string, load: () => Promise<unknown>): Promise<{ svg: string } | { error: string }> {
  let mod: { default?: { toString: Function }; toString?: Function };
  try {
    mod = (await load()) as typeof mod;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].replace(/ imported from .*$/, "");
    return { error: `the QR code cannot be drawn: the QR encoder (qrcode) is not installed or failed to load (${msg})` };
  }
  try {
    const toString = (mod.default?.toString ?? mod.toString) as (t: string, o: Record<string, unknown>) => Promise<string>;
    return { svg: await toString(payload, { type: "svg", margin: 2, errorCorrectionLevel: "M" }) };
  } catch (e) {
    return { error: `the QR code cannot be drawn: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
}
