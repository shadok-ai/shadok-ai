import type { WaAccount } from "./wa-link.js";
import type { WaTransport, WaTransportEvent, WaTransportFactory } from "./wa-transport.js";
import { probeInWorker, workerTransportFactory } from "./wa-worker-host.js";

/**
 * The WhatsApp library adapter — the ONLY file that names the library.
 *
 * The library is an optionalDependency and is loaded by a dynamic `import()`
 * whose specifier is a variable: a literal would make `tsc` resolve it, and an
 * install made with `--omit=optional` must still build, boot and serve the
 * cockpit (the panel then says "unavailable" with the reason). For the same
 * reason the few library types used here are declared locally instead of
 * imported.
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

/** The in-process loader. Runs INSIDE the worker (`wa-worker.ts`), never in
 *  the server's thread: see `loadBaileysFactory`. */
export const loadBaileysInProcess = async (): Promise<WaTransportFactory> => {
  let lib: Lib;
  try {
    lib = (await import(LIB)) as Lib;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The resolver's message names the server's own install path: not the
    // panel's business, so it stops at the package name.
    const first = msg.split("\n")[0].replace(/ imported from .*$/, "");
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
export const loadBaileysFactory = async (): Promise<WaTransportFactory> => {
  const spec = { modulePath: import.meta.url, exportName: "loadBaileysInProcess" };
  await probeInWorker(spec);
  return workerTransportFactory(spec);
};

/** The QR code as an SVG string, drawn server-side: the page's CSP allows no
 *  external image and no inline script, and the payload never needs to reach
 *  a third party. When the encoder is absent, the REASON — otherwise the panel
 *  would sit on "waiting for a code" until linking expired. */
export async function qrSvg(
  payload: string,
  load: () => Promise<unknown> = () => import(QR_LIB),
): Promise<{ svg: string } | { error: string }> {
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
