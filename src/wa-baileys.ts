import type { WaAccount } from "./wa-link.js";
import type { WaTransport, WaTransportEvent, WaTransportFactory } from "./wa-transport.js";

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

/** 515 → restart, 401 → logged-out, 408/428/503 → lost, anything else → error. */
export function closeReasonOf(statusCode: number | undefined): "restart" | "lost" | "logged-out" | "error" {
  switch (statusCode) {
    case 515:
      return "restart";
    case 401:
      return "logged-out";
    case 408:
    case 428:
    case 503:
      return "lost";
    default:
      return "error";
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
interface Lib {
  default: (cfg: Record<string, unknown>) => LibSocket;
  useMultiFileAuthState(dir: string): Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  Browsers: { ubuntu(b: string): unknown };
}

function makeBaileysTransport(lib: Lib, sessionDir: string): WaTransport {
  let sock: LibSocket | null = null;
  let live = false;
  return {
    async start(on) {
      live = true;
      const emit = (e: WaTransportEvent) => {
        if (live) on(e);
      };
      const { state, saveCreds } = await lib.useMultiFileAuthState(sessionDir);
      const s = lib.default({
        auth: state,
        logger: SILENT_LOGGER,
        browser: lib.Browsers.ubuntu("Chrome"),
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });
      sock = s;
      s.ev.on("creds.update", () => void saveCreds().catch(() => {}));
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
          emit({
            type: "close",
            reason,
            ...(reason === "logged-out" ? { detail: "the device was removed from the phone, or WhatsApp closed the session" } : code ? { detail: `status ${code}` } : {}),
          });
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
      const s = sock;
      sock = null;
      try {
        s?.end(undefined);
      } catch {
        /* already closed */
      }
    },
  };
}

/** Rejects (with the library's own message) when the library is absent or
 *  fails to load; the handle turns that into the `unavailable` state. */
export const loadBaileysFactory = async (): Promise<WaTransportFactory> => {
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

/** The QR code as an SVG string, drawn server-side: the page's CSP allows no
 *  external image and no inline script, and the payload never needs to reach
 *  a third party. Null when the encoder is absent. */
export async function qrSvg(payload: string): Promise<string | null> {
  try {
    const mod = (await import(QR_LIB)) as { default?: { toString: Function }; toString: Function };
    const toString = (mod.default?.toString ?? mod.toString) as (t: string, o: Record<string, unknown>) => Promise<string>;
    return await toString(payload, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
  } catch {
    return null;
  }
}
